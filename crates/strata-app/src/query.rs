use std::{future::Future, time::Instant};

use strata_core::{Batch, CoreError, Result};
use strata_sql::{
    Dialect, Span, StmtClass, needs_mutation_confirmation, split, statement_at, utf16_to_byte,
};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::{AppService, RunEvent, RunMode, RunRequest, Target, elapsed_ms, protocol::wire_rows};

const MAX_BATCH: usize = 500;

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
) -> Result<Plan> {
    if text.len() > 8_000_000 {
        return Err(CoreError::config("SQL exceeds 8 MB"));
    }
    let dialect = Dialect::Postgres;
    let spans = match target {
        Target::Selection {
            selection: [start, end],
        } => {
            let sql = slice(text, start, end)?;
            let mut spans = split(sql, dialect, false);
            if matches!(mode, RunMode::Statement) && spans.len() > 1 {
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
        Target::Cursor { cursor } if matches!(mode, RunMode::Statement) => {
            statement_at(text, cursor, dialect, blank_lines)
                .into_iter()
                .collect()
        }
        Target::Cursor { .. } => split(text, dialect, false),
    };
    let confirmation = if production && spans.iter().any(|span| span.kind_hint != StmtClass::Read) {
        Some("This SQL can change a production database.".into())
    } else if spans.iter().any(|span| {
        span.kind_hint != StmtClass::Read
            && slice(text, span.start, span.end).is_ok_and(needs_mutation_confirmation)
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
            session.production,
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
        let mut statements = 0;
        let run = async {
            check_cancel(&cancel)?;
            self.engine.core().clear_results(request.session_id).await?;
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
                stream_statement(
                    self.engine.core(),
                    Statement {
                        session: request.session_id,
                        sql,
                        index,
                        pause: index + 1 == plan.spans.len(),
                        fetch_size: settings.fetch_size,
                        cancel: &cancel,
                    },
                    &emit,
                )
                .await?;
                statements += 1;
            }
            Ok(())
        }
        .await;

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
    fetch_size: usize,
    cancel: &'a CancellationToken,
}

async fn stream_statement<F, Fut>(
    core: &strata_core::Core,
    statement: Statement<'_>,
    emit: &F,
) -> Result<()>
where
    F: Fn(RunEvent) -> Fut,
    Fut: Future<Output = bool>,
{
    let Statement {
        session,
        sql,
        index,
        pause,
        fetch_size,
        cancel,
    } = statement;
    // Publish the first row immediately. Subsequent events amortize IPC overhead.
    let mut batch = core.run_batch(session, sql, 1, Some(cancel)).await?;
    let cursor_id = batch.cursor;
    let has_result = !batch.columns.is_empty();
    if has_result {
        let columns = std::mem::take(&mut batch.columns);
        send(
            emit,
            RunEvent::ResultStart {
                cursor_id,
                result_index: index,
                columns,
            },
        )
        .await?;
    }
    loop {
        let Batch {
            rows,
            messages,
            fetched,
            capped,
            exhausted,
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
                if !pause {
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
            return Ok(());
        }
        if pause && fetched >= fetch_size {
            return send(emit, RunEvent::ResultPaused { cursor_id, fetched }).await;
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
        )
        .unwrap();
        assert!(allowed.confirmation.is_none());
        let prod = super::plan(
            "DELETE FROM fixture WHERE id = 7",
            Target::Cursor { cursor: 0 },
            RunMode::Statement,
            true,
            true,
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
                false
            )
            .is_err()
        );
    }
}
