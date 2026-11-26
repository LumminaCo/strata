use std::{
    future::Future,
    time::{Duration, Instant},
};

use strata_core::{Batch, ColumnMeta, CoreError, DbKind, ForeignKeyRef, Result, TableForeignKey};
use strata_sql::{
    Dialect, ProjectionSource, QueryColumnSources, Span, StmtClass, TableSource,
    needs_mutation_confirmation, query_column_sources, split, statement_at, utf16_to_byte,
};
use strata_store::{HistoryEntry, HistoryStatus, Source};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::{
    AppService, CatalogScope, RunEvent, RunMode, RunRequest, Session, Target, elapsed_ms,
    inspection, protocol::wire_rows,
};

const MAX_BATCH: usize = 500;
const FK_ENRICH_TIMEOUT: Duration = Duration::from_secs(2);
const MAX_FK_TABLES: usize = 8;

pub(crate) struct Plan {
    pub spans: Vec<Span>,
    pub confirmation: Option<String>,
}

pub(crate) fn plan(
    text: &str,
    target: Target,
    mode: RunMode,
    blank_lines: bool,
    production: bool,
    dialect: Dialect,
) -> Result<Plan> {
    if text.len() > 8_000_000 {
        return Err(CoreError::config("SQL exceeds 8 MB"));
    }
    let spans = match target {
        Target::Selection {
            selection: [start, end],
        } => {
            let sql = slice(text, start, end)?;
            let mut spans = split(sql, dialect, false);
            if matches!(mode, RunMode::Statement | RunMode::Explain) && spans.len() > 1 {
                return Err(CoreError::config(
                    "Use Run script to run a selection containing multiple statements",
                ));
            }
            for span in &mut spans {
                span.start += start;
                span.end += start;
            }
            spans
        }
        Target::Cursor { cursor } if matches!(mode, RunMode::Statement | RunMode::Explain) => {
            statement_at(text, cursor, dialect, blank_lines)
                .into_iter()
                .collect()
        }
        Target::Cursor { .. } => split(text, dialect, false),
    };
    let confirmation = if matches!(mode, RunMode::Explain) {
        None
    } else if production && spans.iter().any(|span| span.kind_hint != StmtClass::Read) {
        Some("This SQL can change a production database.".into())
    } else if spans.iter().any(|span| {
        span.kind_hint != StmtClass::Read
            && slice(text, span.start, span.end)
                .is_ok_and(|sql| needs_mutation_confirmation(sql, dialect))
    }) {
        Some("An UPDATE or DELETE may affect every row.".into())
    } else {
        None
    };
    Ok(Plan {
        spans,
        confirmation,
    })
}

impl AppService {
    pub async fn run<F, Fut>(
        &self,
        request: RunRequest,
        emit: F,
    ) -> std::result::Result<(), crate::ErrorDto>
    where
        F: Fn(RunEvent) -> Fut,
        Fut: Future<Output = bool>,
    {
        self.run_inner(request, emit).await.map_err(Into::into)
    }

    async fn run_inner<F, Fut>(&self, request: RunRequest, emit: F) -> Result<()>
    where
        F: Fn(RunEvent) -> Fut,
        Fut: Future<Output = bool>,
    {
        let session = self.session(request.session_id).await?;
        let settings = self.engine.config().settings;
        let plan = plan(
            &request.text,
            request.target,
            request.mode,
            settings.blank_line_delimiter,
            session.production && settings.confirm_production,
            crate::inspection::dialect(session.kind),
        )?;
        if plan.confirmation.is_some() && !request.confirmed {
            return Err(CoreError::config("Confirm this query before running it"));
        }
        if plan.spans.is_empty() {
            return Err(CoreError::config("No SQL statement selected"));
        }

        let cancel = session.lifetime.child_token();
        {
            let mut control = session.control.lock().await;
            if control.active.is_some() {
                return Err(CoreError::config("A query is already running in this tab"));
            }
            if control.cancelled == Some(request.run_id) {
                control.cancelled = None;
                cancel.cancel();
            }
            control.active = Some((request.run_id, cancel.clone()));
        }

        let started = Instant::now();
        let started_at = crate::metadata::now_ms();
        let mut recorded_sql = Vec::new();
        let mut rows = 0_u32;
        let mut next_result_index = 0;
        let mut statements = 0;
        let mut explain_mode = false;
        let run = async {
            check_cancel(&cancel)?;
            if request.keep_results.unwrap_or(false) {
                self.engine
                    .core()
                    .preserve_results(request.session_id)
                    .await?;
            } else {
                self.engine.core().clear_results(request.session_id).await?;
            }
            if matches!(request.mode, RunMode::Explain) && session.kind == DbKind::SqlServer {
                self.engine
                    .core()
                    .set_explain(request.session_id, true)
                    .await?;
                explain_mode = true;
            }
            for (index, span) in plan.spans.iter().enumerate() {
                check_cancel(&cancel)?;
                send(
                    &emit,
                    RunEvent::StatementStart {
                        index,
                        span: [span.start, span.end],
                    },
                )
                .await?;
                let sql = slice(&request.text, span.start, span.end)?;
                let explain = match (request.mode, session.kind) {
                    (RunMode::Explain, DbKind::Oracle) => {
                        let (source, _) = strata_sql::oracle_execution(sql);
                        let label = format!("S{}", &request.run_id.simple().to_string()[..24]);
                        let plan = format!("EXPLAIN PLAN SET STATEMENT_ID = '{label}' FOR {source}");
                        self.engine.core().run_batch(request.session_id, &plan, 1, Some(&cancel)).await?;
                        Some(format!("SELECT PLAN_TABLE_OUTPUT FROM TABLE(DBMS_XPLAN.DISPLAY(NULL,'{label}','TYPICAL'))"))
                    }
                    (RunMode::Explain, DbKind::Postgres) => Some(format!("EXPLAIN {sql}")),
                    _ => None,
                };
                let sql = explain.as_deref().unwrap_or(sql);
                recorded_sql.push(strata_sql::history_sql(sql).to_owned());
                for _ in 0..span.repeat {
                    check_cancel(&cancel)?;
                    let fetched = self
                        .stream_statement(
                            &session,
                            Statement {
                                session: request.session_id,
                                sql,
                                index,
                                pause: !explain_mode
                                    && span.repeat == 1
                                    && index + 1 == plan.spans.len(),
                                explain: matches!(request.mode, RunMode::Explain),
                                fetch_size: settings.fetch_size,
                                cancel: &cancel,
                            },
                            &mut next_result_index,
                            &emit,
                        )
                        .await?;
                    rows = rows.saturating_add(fetched);
                }
                statements += 1;
                if span.kind_hint == StmtClass::Session
                    && !matches!(request.mode, RunMode::Explain)
                    && let Ok(info) = self.engine.core().server_info(request.session_id).await
                {
                    *session.database.write().await = info.database.clone();
                    *session.schema.write().await = info.schema.clone();
                    send(
                        &emit,
                        RunEvent::SessionContext {
                            database: info.database,
                            schema: info.schema,
                        },
                    )
                    .await?;
                }
                if span.kind_hint == StmtClass::Ddl && !matches!(request.mode, RunMode::Explain) {
                    self.metadata
                        .invalidate(&self.engine, session.connection_id)
                        .await?;
                    send(
                        &emit,
                        RunEvent::CatalogChanged {
                            connection_id: session.connection_id,
                        },
                    )
                    .await?;
                }
            }
            Ok(())
        }
        .await;

        let run = if explain_mode {
            let restore = self
                .engine
                .core()
                .set_explain(request.session_id, false)
                .await;
            run.and(restore)
        } else {
            run
        };
        if matches!(run, Err(CoreError::Cancelled)) {
            let _ = self.engine.core().stop(request.session_id).await;
        }
        {
            let mut control = session.control.lock().await;
            if control.cancelled == Some(request.run_id) {
                control.cancelled = None;
            }
            control.active = None;
        }
        let status = match &run {
            Ok(()) => HistoryStatus::Ok,
            Err(CoreError::Cancelled) => HistoryStatus::Cancelled,
            Err(_) => HistoryStatus::Error,
        };
        if !recorded_sql.is_empty()
            && self
                .engine
                .record_history(HistoryEntry {
                    connection_id: session.connection_id.to_string(),
                    source: Source::Ui,
                    sql: recorded_sql.join("\n"),
                    started_at,
                    duration_ms: elapsed_ms(started),
                    rows,
                    status,
                    error: None,
                })
                .await
                .is_err()
        {
            send(
                &emit,
                RunEvent::Message {
                    level: "warning".into(),
                    text: "Could not save query history.".into(),
                },
            )
            .await?;
        }
        if let Err(error) = run {
            send(
                &emit,
                RunEvent::Error {
                    statement_index: statements,
                    error: error.into(),
                },
            )
            .await?;
        }
        if let Ok((true, open)) = self
            .engine
            .core()
            .transaction_state(request.session_id)
            .await
        {
            send(&emit, RunEvent::TransactionState { manual: true, open }).await?;
        }
        send(
            &emit,
            RunEvent::Done {
                elapsed_ms: elapsed_ms(started),
                statements,
            },
        )
        .await
    }
}

struct Statement<'a> {
    session: Uuid,
    sql: &'a str,
    index: usize,
    pause: bool,
    explain: bool,
    fetch_size: usize,
    cancel: &'a CancellationToken,
}

impl AppService {
    async fn stream_statement<F, Fut>(
        &self,
        session_state: &Session,
        statement: Statement<'_>,
        next_result_index: &mut usize,
        emit: &F,
    ) -> Result<u32>
    where
        F: Fn(RunEvent) -> Fut,
        Fut: Future<Output = bool>,
    {
        let core = self.engine.core();
        let Statement {
            session,
            sql,
            index,
            pause,
            explain,
            fetch_size,
            cancel,
        } = statement;
        // Publish the first row immediately. Subsequent events amortize IPC overhead.
        let mut batch = core.run_batch(session, sql, 1, Some(cancel)).await?;
        let mut total = 0_u32;
        'results: loop {
            let cursor_id = batch.cursor;
            let has_result = !batch.columns.is_empty();
            if has_result {
                let mut columns = std::mem::take(&mut batch.columns);
                if !explain
                    && columns.iter().any(|col| col.foreign_key.is_none())
                    && columns.iter().all(|col| col.table_oid.is_none())
                {
                    let _ = tokio::time::timeout(
                        FK_ENRICH_TIMEOUT,
                        self.enrich_foreign_keys(session_state, sql, &mut columns),
                    )
                    .await;
                }
                let rows = wire_rows(std::mem::take(&mut batch.rows));
                send(
                    emit,
                    RunEvent::ResultStart {
                        cursor_id,
                        result_index: *next_result_index,
                        columns,
                        rows,
                    },
                )
                .await?;
                *next_result_index += 1;
            }
            loop {
                let Batch {
                    rows,
                    messages,
                    fetched,
                    capped,
                    exhausted,
                    next_result,
                    affected,
                    ..
                } = batch;
                if !rows.is_empty() {
                    send(
                        emit,
                        RunEvent::Rows {
                            cursor_id,
                            rows: wire_rows(rows),
                        },
                    )
                    .await?;
                }
                for (level, text) in messages {
                    send(emit, RunEvent::Message { level, text }).await?;
                }
                if exhausted {
                    if has_result {
                        if !pause && !next_result {
                            core.retain_result(session, cursor_id).await?;
                        }
                        send(
                            emit,
                            RunEvent::ResultEnd {
                                cursor_id,
                                fetched,
                                capped,
                            },
                        )
                        .await?;
                    } else if let Some(rows) = affected {
                        send(
                            emit,
                            RunEvent::Affected {
                                statement_index: index,
                                rows: rows.try_into().unwrap_or(u32::MAX),
                            },
                        )
                        .await?;
                    }
                    total = total.saturating_add(
                        affected
                            .map_or(fetched, |count| count as usize)
                            .try_into()
                            .unwrap_or(u32::MAX),
                    );
                    if next_result {
                        batch = core
                            .next_result(session, cursor_id, 1, Some(cancel))
                            .await?;
                        continue 'results;
                    }
                    return Ok(total);
                }
                if pause && fetched >= fetch_size {
                    send(emit, RunEvent::ResultPaused { cursor_id, fetched }).await?;
                    return Ok(total.saturating_add(fetched.try_into().unwrap_or(u32::MAX)));
                }
                check_cancel(cancel)?;
                let count = if pause {
                    (fetch_size - fetched).min(MAX_BATCH)
                } else {
                    MAX_BATCH
                };
                batch = core
                    .fetch_batch(session, cursor_id, count, Some(cancel))
                    .await?;
            }
        }
    }

    async fn enrich_foreign_keys(&self, session: &Session, sql: &str, columns: &mut [ColumnMeta]) {
        let dialect = inspection::dialect(session.kind);
        let Some(sources) = query_column_sources(sql, dialect) else {
            return;
        };
        let default_database = session.database.read().await.clone();
        let default_schema = session.schema.read().await.clone();
        let password = session.password.as_ref().map(|s| s.expose().to_owned());

        let mut resolved = Vec::new();
        for table in sources.tables.iter().take(MAX_FK_TABLES) {
            let mut scope = CatalogScope {
                connection_id: session.connection_id,
                database: Some(default_database.clone()),
                password: password.clone(),
            };
            let mut parts = table.parts.clone();
            if parts.len() == 3 && dialect == Dialect::SqlServer {
                scope.database = Some(parts.remove(0));
            }
            let Ok(catalog) = self.metadata.catalog(&self.engine, &scope).await else {
                continue;
            };
            let object = if parts.len() == 1
                && let Some(schema) = default_schema
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
            {
                let qualified = inspection::qualified(&[schema, parts[0].as_str()], dialect);
                match catalog.resolve(&qualified).await {
                    Ok(Some(object)) => Some(object),
                    _ => catalog
                        .resolve(&inspection::qualified(&parts, dialect))
                        .await
                        .ok()
                        .flatten(),
                }
            } else {
                catalog
                    .resolve(&inspection::qualified(&parts, dialect))
                    .await
                    .ok()
                    .flatten()
            };
            let Some(object) = object else {
                continue;
            };
            let Ok(keys) = self
                .metadata
                .foreign_keys_for_object(&self.engine, &scope, &object)
                .await
            else {
                continue;
            };
            if !keys.is_empty() {
                resolved.push((table.clone(), keys.as_ref().clone()));
            }
        }
        if !resolved.is_empty() {
            apply_foreign_keys(columns, &sources, &resolved, dialect);
        }
    }
}

pub(crate) fn apply_foreign_keys(
    columns: &mut [ColumnMeta],
    sources: &QueryColumnSources,
    resolved: &[(TableSource, Vec<TableForeignKey>)],
    dialect: Dialect,
) {
    let has_wildcard = sources.projections.iter().any(|item| {
        matches!(
            item,
            ProjectionSource::Wildcard | ProjectionSource::QualifiedWildcard(_)
        )
    });

    if !has_wildcard && sources.projections.len() == columns.len() {
        for (column, projection) in columns.iter_mut().zip(&sources.projections) {
            if column.foreign_key.is_some() {
                continue;
            }
            if let ProjectionSource::Column {
                qualifier,
                column: source_column,
                ..
            } = projection
            {
                column.foreign_key =
                    resolve_fk(resolved, qualifier.as_deref(), source_column, dialect);
            }
        }
        return;
    }

    let all_wildcard = sources
        .projections
        .iter()
        .any(|item| matches!(item, ProjectionSource::Wildcard));
    let wildcard_qualifiers: Vec<&[String]> = sources
        .projections
        .iter()
        .filter_map(|item| match item {
            ProjectionSource::QualifiedWildcard(parts) => Some(parts.as_slice()),
            _ => None,
        })
        .collect();

    for column in columns.iter_mut() {
        if column.foreign_key.is_some() {
            continue;
        }
        let explicit_matches: Vec<&ProjectionSource> = sources
            .projections
            .iter()
            .filter(|item| match item {
                ProjectionSource::Column { output_name, .. } => {
                    ident_matches(output_name, &column.name, dialect)
                }
                _ => false,
            })
            .collect();
        if let [
            ProjectionSource::Column {
                qualifier,
                column: source_column,
                ..
            },
        ] = explicit_matches.as_slice()
        {
            column.foreign_key = resolve_fk(resolved, qualifier.as_deref(), source_column, dialect);
            continue;
        }

        if all_wildcard {
            column.foreign_key = resolve_fk(resolved, None, &column.name, dialect);
        } else if !wildcard_qualifiers.is_empty() {
            let mut found: Option<ForeignKeyRef> = None;
            let mut ambiguous = false;
            for qualifier in &wildcard_qualifiers {
                if let Some(fk) = resolve_fk(resolved, Some(qualifier), &column.name, dialect) {
                    if let Some(existing) = &found {
                        if existing != &fk {
                            ambiguous = true;
                            break;
                        }
                    } else {
                        found = Some(fk);
                    }
                }
            }
            if !ambiguous {
                column.foreign_key = found;
            }
        }
    }
}

fn resolve_fk(
    resolved: &[(TableSource, Vec<TableForeignKey>)],
    qualifier: Option<&[String]>,
    column_name: &str,
    dialect: Dialect,
) -> Option<ForeignKeyRef> {
    let mut matched: Option<ForeignKeyRef> = None;
    for (table, keys) in resolved {
        if let Some(q) = qualifier
            && !table_matches_qualifier(table, q, dialect)
        {
            continue;
        }
        if let Some(fk) = find_fk_in_table(keys, column_name, dialect) {
            if let Some(existing) = &matched {
                if existing != fk {
                    return None;
                }
            } else {
                matched = Some(fk.clone());
            }
        }
    }
    matched
}

fn table_matches_qualifier(table: &TableSource, qualifier: &[String], dialect: Dialect) -> bool {
    if qualifier.is_empty() {
        return false;
    }
    if qualifier.len() == 1 {
        let name = &qualifier[0];
        if let Some(alias) = &table.alias {
            return ident_matches(alias, name, dialect);
        }
        return table
            .parts
            .last()
            .is_some_and(|last| ident_matches(last, name, dialect));
    }
    if qualifier.len() > table.parts.len() {
        return false;
    }
    let start = table.parts.len() - qualifier.len();
    table.parts[start..]
        .iter()
        .zip(qualifier)
        .all(|(left, right)| ident_matches(left, right, dialect))
}

fn find_fk_in_table<'a>(
    keys: &'a [TableForeignKey],
    column_name: &str,
    dialect: Dialect,
) -> Option<&'a ForeignKeyRef> {
    keys.iter()
        .find(|fk| fk.column == column_name)
        .or_else(|| {
            keys.iter()
                .find(|fk| ident_matches(&fk.column, column_name, dialect))
        })
        .map(|fk| &fk.target)
}

fn ident_matches(left: &str, right: &str, _dialect: Dialect) -> bool {
    left.eq_ignore_ascii_case(right)
}

fn check_cancel(cancel: &CancellationToken) -> Result<()> {
    if cancel.is_cancelled() {
        Err(CoreError::Cancelled)
    } else {
        Ok(())
    }
}

async fn send<F, Fut>(emit: &F, event: RunEvent) -> Result<()>
where
    F: Fn(RunEvent) -> Fut,
    Fut: Future<Output = bool>,
{
    if emit(event).await {
        Ok(())
    } else {
        Err(CoreError::Cancelled)
    }
}

fn slice(text: &str, start: u32, end: u32) -> Result<&str> {
    let range = utf16_to_byte(text, start).zip(utf16_to_byte(text, end));
    range
        .and_then(|(from, to)| text.get(from..to))
        .ok_or_else(|| CoreError::config("Invalid SQL selection"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plans_utf16_selections_and_requires_mutation_confirmation() {
        let selection = "SELECT '🪨'; ";
        let text = format!("{selection}UPDATE fixture SET x = 1;");
        let start = selection.encode_utf16().count() as u32;
        let end = text.encode_utf16().count() as u32;
        let plan = plan(
            &text,
            Target::Selection {
                selection: [start, end],
            },
            RunMode::Statement,
            true,
            false,
            Dialect::Postgres,
        )
        .unwrap();
        assert_eq!((plan.spans[0].start, plan.spans[0].end), (start, end));
        assert!(plan.confirmation.is_some());

        let allowed = super::plan(
            "DELETE FROM fixture WHERE id = 7",
            Target::Cursor { cursor: 0 },
            RunMode::Statement,
            true,
            false,
            Dialect::Postgres,
        )
        .unwrap();
        assert!(allowed.confirmation.is_none());
        let prod = super::plan(
            "DELETE FROM fixture WHERE id = 7",
            Target::Cursor { cursor: 0 },
            RunMode::Statement,
            true,
            true,
            Dialect::Postgres,
        )
        .unwrap();
        assert!(prod.confirmation.is_some());
        let inside_emoji = selection.find('🪨').unwrap() as u32 + 1;
        assert!(
            super::plan(
                &text,
                Target::Selection {
                    selection: [inside_emoji, end]
                },
                RunMode::Script,
                true,
                false,
                Dialect::Postgres,
            )
            .is_err()
        );
    }

    fn sample_col(name: &str) -> ColumnMeta {
        ColumnMeta {
            name: name.into(),
            db_type: "int".into(),
            kind: strata_core::CellKind::Int,
            nullable: Some(false),
            table_oid: None,
            column_id: None,
            foreign_key: None,
        }
    }

    #[test]
    fn applies_foreign_keys_for_wildcards_joins_and_aliases() {
        let sql = "SELECT e.department_id AS dept, e.job_id, d.location_id FROM hr.employees e JOIN hr.departments d ON d.department_id = e.department_id";
        let sources = query_column_sources(sql, Dialect::Oracle).expect("sources");
        let dept_fk = ForeignKeyRef {
            schema: "HR".into(),
            table: "DEPARTMENTS".into(),
            column: "DEPARTMENT_ID".into(),
        };
        let job_fk = ForeignKeyRef {
            schema: "HR".into(),
            table: "JOBS".into(),
            column: "JOB_ID".into(),
        };
        let loc_fk = ForeignKeyRef {
            schema: "HR".into(),
            table: "LOCATIONS".into(),
            column: "LOCATION_ID".into(),
        };
        let resolved = vec![
            (
                sources.tables[0].clone(),
                vec![
                    TableForeignKey {
                        column: "DEPARTMENT_ID".into(),
                        target: dept_fk.clone(),
                    },
                    TableForeignKey {
                        column: "JOB_ID".into(),
                        target: job_fk.clone(),
                    },
                ],
            ),
            (
                sources.tables[1].clone(),
                vec![TableForeignKey {
                    column: "LOCATION_ID".into(),
                    target: loc_fk.clone(),
                }],
            ),
        ];
        let mut columns = vec![
            sample_col("DEPT"),
            sample_col("JOB_ID"),
            sample_col("LOCATION_ID"),
        ];
        apply_foreign_keys(&mut columns, &sources, &resolved, Dialect::Oracle);
        assert_eq!(columns[0].foreign_key, Some(dept_fk));
        assert_eq!(columns[1].foreign_key, Some(job_fk));
        assert_eq!(columns[2].foreign_key, Some(loc_fk));

        let wildcard_sql = "SELECT TOP (50) * FROM [SalesLT].[SalesOrderHeader]";
        let wildcard_sources =
            query_column_sources(wildcard_sql, Dialect::SqlServer).expect("mssql sources");
        let customer_fk = ForeignKeyRef {
            schema: "SalesLT".into(),
            table: "Customer".into(),
            column: "CustomerID".into(),
        };
        let mut mssql_cols = vec![sample_col("SalesOrderID"), sample_col("CustomerID")];
        apply_foreign_keys(
            &mut mssql_cols,
            &wildcard_sources,
            &[(
                wildcard_sources.tables[0].clone(),
                vec![TableForeignKey {
                    column: "CustomerID".into(),
                    target: customer_fk.clone(),
                }],
            )],
            Dialect::SqlServer,
        );
        assert_eq!(mssql_cols[0].foreign_key, None);
        assert_eq!(mssql_cols[1].foreign_key, Some(customer_fk));
    }
}
