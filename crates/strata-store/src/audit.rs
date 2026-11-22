use rusqlite::params;
use serde::Serialize;
use strata_core::Result;

use crate::{Database, io_error};

#[derive(Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct AuditEntry {
    #[ts(type = "number")]
    pub id: i64,
    #[ts(type = "number")]
    pub ts: i64,
    pub client_name: Option<String>,
    pub connection_name: String,
    pub tool: String,
    pub sql: Option<String>,
    pub class: Option<String>,
    pub decision: String,
    pub reason: Option<String>,
    pub rows: Option<u32>,
    pub duration_ms: Option<u32>,
}

pub struct AuditOutcome {
    pub class: Option<String>,
    pub decision: &'static str,
    pub reason: Option<String>,
    pub rows: Option<u32>,
    pub duration_ms: u32,
}

impl Database {
    pub fn begin_audit(&self, entry: &AuditEntry) -> Result<i64> {
        self.connection
            .execute(
                "INSERT INTO audit (ts, source, client_name, conn_name, tool, sql, decision)
             VALUES (?1, 'mcp', ?2, ?3, ?4, ?5, 'pending')",
                params![
                    entry.ts,
                    entry.client_name,
                    entry.connection_name,
                    entry.tool,
                    entry.sql
                ],
            )
            .map_err(io_error)?;
        Ok(self.connection.last_insert_rowid())
    }

    pub fn finish_audit(&self, id: i64, outcome: &AuditOutcome) -> Result<()> {
        self.connection.execute(
            "UPDATE audit SET class=?1, decision=?2, reason=?3, rows=?4, duration_ms=?5 WHERE id=?6",
            params![outcome.class, outcome.decision, outcome.reason, outcome.rows, outcome.duration_ms, id],
        ).map_err(io_error)?;
        Ok(())
    }

    pub fn audit(&self, limit: u32) -> Result<Vec<AuditEntry>> {
        let mut query = self.connection.prepare(
            "SELECT id, ts, client_name, conn_name, tool, sql, class, decision, reason, rows, duration_ms
             FROM audit ORDER BY id DESC LIMIT ?1",
        ).map_err(io_error)?;
        let records = query
            .query_map([limit.clamp(1, 1000)], |row| {
                Ok(AuditEntry {
                    id: row.get(0)?,
                    ts: row.get(1)?,
                    client_name: row.get(2)?,
                    connection_name: row.get(3)?,
                    tool: row.get(4)?,
                    sql: row.get(5)?,
                    class: row.get(6)?,
                    decision: row.get(7)?,
                    reason: row.get(8)?,
                    rows: row.get(9)?,
                    duration_ms: row.get(10)?,
                })
            })
            .map_err(io_error)?
            .collect::<rusqlite::Result<_>>()
            .map_err(io_error)?;
        Ok(records)
    }
}
