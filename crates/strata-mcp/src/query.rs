use std::time::Instant;

use serde_json::{Value, json};
use strata_core::{AgentAccess, CoreError, DbKind, Environment, Limits, Profile, Secret};
use strata_engine::{Engine, WireCell};
use strata_sql::{Dialect, StmtClass, strict_statement};
use tokio_util::sync::CancellationToken;

use crate::{Arguments, Failure, ToolResult};

pub(crate) async fn execute(
    engine: &Engine,
    mut profile: Profile,
    args: &Arguments,
    tool: &str,
    secret: &Secret,
    cancelled: &CancellationToken,
) -> Result<ToolResult, Failure> {
    let sql = args
        .sql
        .as_deref()
        .ok_or(Failure::deny("SQL is required"))?;
    let dialect = match profile.kind {
        DbKind::Postgres => Dialect::Postgres,
        DbKind::SqlServer => Dialect::SqlServer,
        DbKind::Oracle => Dialect::Oracle,
    };
    let (sql, class) = strict_statement(sql, dialect).map_err(Failure::deny)?;
    let write = tool == "run_write";
    let explain = tool == "explain_query";
    let dry_run = args.dry_run.unwrap_or(false);
    let class_name = format!("{class:?}").to_ascii_lowercase();
    let denied = |reason| Failure::deny(reason).with_class(&class_name);
    if write {
        if profile.agent_access != AgentAccess::Write
            || profile.env == Environment::Prod
            || profile.read_only
        {
            return Err(denied("Write access is disabled for this connection"));
        }
        match class {
            StmtClass::Ddl
                if profile.allow_agent_ddl && !(dry_run && profile.kind == DbKind::Oracle) => {}
            StmtClass::Ddl => {
                return Err(denied(
                    "DDL is disabled for this connection or cannot be rolled back",
                ));
            }
            StmtClass::Write if strata_sql::agent_dml(sql, dialect) => {}
            _ => {
                return Err(denied(
                    "run_write accepts a single recognized write statement",
                ));
            }
        }
    } else if class != StmtClass::Read || !strata_sql::agent_read_allowed(sql, dialect) {
        return Err(denied("The query does not pass the read-only policy"));
    }

    let settings = engine.config().settings;
    let limit = args
        .max_rows
        .unwrap_or(settings.agent_default_row_limit)
        .clamp(1, settings.agent_max_row_limit.min(10_000));
    let seconds = args
        .timeout_s
        .unwrap_or(settings.agent_statement_timeout_s)
        .clamp(1, 120);
    let core = engine
        .core_with_limits(Limits {
            fetch_size: limit + 1,
            row_cap: limit + 1,
            timeout_ms: seconds.saturating_mul(1_000),
        })
        .map_err(Failure::database)?;
    if let Some(database) = &args.database {
        profile.database = database.clone();
    }
    let oracle_plan = explain && profile.kind == DbKind::Oracle;
    profile.read_only = !write && !oracle_plan;
    let started = Instant::now();
    let id = core
        .open_session(&profile, secret)
        .await
        .map_err(Failure::database)?;
    let result = async {
        let transactional = !write || dry_run || class != StmtClass::Ddl;
        if transactional {
            core.set_manual_transactions(id, true).await?;
        }
        let plan;
        let statement = if oracle_plan {
            let (statement, _) = strata_sql::oracle_execution(sql);
            core.run_batch(
                id,
                &format!("EXPLAIN PLAN SET STATEMENT_ID = 'STRATA_MCP' FOR {statement}"),
                1,
                Some(cancelled),
            )
            .await?;
            "SELECT PLAN_TABLE_OUTPUT FROM TABLE(DBMS_XPLAN.DISPLAY(NULL,'STRATA_MCP','TYPICAL'))"
        } else if explain && profile.kind == DbKind::Postgres {
            plan = format!("EXPLAIN {sql}");
            &plan
        } else {
            if explain && profile.kind == DbKind::SqlServer {
                core.set_explain(id, true).await?;
            }
            sql
        };
        let batch = core
            .run_batch(id, statement, limit + 1, Some(cancelled))
            .await?;
        if explain && profile.kind == DbKind::SqlServer {
            core.set_explain(id, false).await?;
        }
        if transactional && core.transaction_open(id).await? {
            if write && !dry_run {
                core.commit(id).await?;
            } else {
                core.rollback(id).await?;
            }
        }
        Ok::<_, CoreError>(batch)
    }
    .await;
    if result.is_err() && core.transaction_open(id).await.unwrap_or(false) {
        let _ = core.rollback(id).await;
    }
    let _ = core.close_session(id).await;
    let batch = result.map_err(|err| Failure::database(err).with_class(&class_name))?;
    let truncated =
        batch.rows.len() > limit || batch.capped || !batch.exhausted || batch.next_result;
    let rows = batch
        .rows
        .into_iter()
        .take(limit)
        .map(|row| row.into_iter().map(WireCell::from).collect::<Vec<_>>())
        .collect::<Vec<_>>();
    let row_count = rows.len() as u32;
    let elapsed_ms = started.elapsed().as_millis().min(u128::from(u32::MAX)) as u32;
    let affected = batch.affected.unwrap_or_default();
    let payload = if write {
        json!({"affected_rows": affected, "dry_run": dry_run, "elapsed_ms": elapsed_ms})
    } else if explain {
        let plan = serde_json::to_value(&rows)
            .unwrap_or_default()
            .as_array()
            .map(|rows| {
                rows.iter()
                    .filter_map(|row| row.get(0).and_then(Value::as_str))
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .unwrap_or_default();
        json!({"plan": plan, "truncated": truncated, "elapsed_ms": elapsed_ms})
    } else {
        json!({"columns": batch.columns, "rows": rows, "row_count": row_count,
            "truncated": truncated, "elapsed_ms": elapsed_ms})
    };
    Ok(ToolResult {
        value: payload,
        rows: Some(if write {
            affected.try_into().unwrap_or(u32::MAX)
        } else {
            row_count
        }),
        class: Some(class_name),
    })
}
