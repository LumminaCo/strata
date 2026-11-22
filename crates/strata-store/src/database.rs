use std::{fs, path::Path, time::Duration};

use rusqlite::{Connection, TransactionBehavior, params};
use strata_core::{CoreError, Result};

use crate::io_error;

const HISTORY_LIMIT: u32 = 10_000;

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Source {
    Ui,
    Cli,
    Mcp,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum HistoryStatus {
    Ok,
    Error,
    Cancelled,
}

#[derive(Debug, PartialEq)]
pub struct HistoryEntry {
    pub connection_id: String,
    pub source: Source,
    pub sql: String,
    pub started_at: i64,
    pub duration_ms: u32,
    pub rows: u32,
    pub status: HistoryStatus,
    pub error: Option<String>,
}

pub struct Database {
    connection: Connection,
}

impl Database {
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent().filter(|path| !path.as_os_str().is_empty()) {
            fs::create_dir_all(parent).map_err(io_error)?;
        }
        let mut connection = Connection::open(path).map_err(io_error)?;
        connection
            .busy_timeout(Duration::from_secs(5))
            .map_err(io_error)?;
        connection
            .pragma_update(None, "journal_mode", "WAL")
            .map_err(io_error)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(io_error)?;
        let version: u32 = transaction
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .map_err(io_error)?;
        match version {
            0 => {
                transaction
                    .execute_batch(include_str!("migrations/001.sql"))
                    .map_err(io_error)?;
                transaction
                    .pragma_update(None, "user_version", 1)
                    .map_err(io_error)?;
            }
            1 => {}
            _ => return Err(CoreError::config("Unsupported strata.db schema version")),
        }
        transaction.commit().map_err(io_error)?;
        Ok(Self { connection })
    }

    pub fn load_workspace(&self) -> Result<Option<String>> {
        use rusqlite::OptionalExtension;
        self.connection
            .query_row("SELECT payload FROM workspace WHERE id = 1", [], |row| {
                row.get(0)
            })
            .optional()
            .map_err(io_error)
    }

    pub fn save_workspace(&self, json: &str) -> Result<()> {
        self.connection.execute(
            "INSERT INTO workspace (id, payload) VALUES (1, ?1) ON CONFLICT (id) DO UPDATE SET payload = excluded.payload",
            [json],
        ).map_err(io_error)?;
        Ok(())
    }

    pub fn record_history(&mut self, entry: &HistoryEntry) -> Result<()> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(io_error)?;
        tx.execute(
            "INSERT INTO history (conn_id, source, sql, started_at, duration_ms, rows, status, error)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![entry.connection_id, entry.source.as_str(), entry.sql, entry.started_at,
                entry.duration_ms, entry.rows, entry.status.as_str(), entry.error],
        ).map_err(io_error)?;
        tx.execute(
            "DELETE FROM history WHERE id IN (
                 SELECT id FROM history WHERE conn_id = ?1
                 ORDER BY started_at DESC, id DESC LIMIT -1 OFFSET ?2
             )",
            params![entry.connection_id, HISTORY_LIMIT],
        )
        .map_err(io_error)?;
        tx.commit().map_err(io_error)
    }

    pub fn history(&self, connection_id: &str, limit: u32) -> Result<Vec<HistoryEntry>> {
        let mut statement = self
            .connection
            .prepare(
                "SELECT conn_id, source, sql, started_at, duration_ms, rows, status, error
             FROM history WHERE conn_id = ?1 ORDER BY started_at DESC, id DESC LIMIT ?2",
            )
            .map_err(io_error)?;
        let result = statement
            .query_map(params![connection_id, limit.min(HISTORY_LIMIT)], |row| {
                let source = row.get::<_, String>(1)?;
                let status = row.get::<_, String>(6)?;
                Ok(HistoryEntry {
                    connection_id: row.get(0)?,
                    source: match source.as_str() {
                        "ui" => Source::Ui,
                        "cli" => Source::Cli,
                        "mcp" => Source::Mcp,
                        _ => return Err(rusqlite::Error::InvalidQuery),
                    },
                    sql: row.get(2)?,
                    started_at: row.get(3)?,
                    duration_ms: row.get(4)?,
                    rows: row.get(5)?,
                    status: match status.as_str() {
                        "ok" => HistoryStatus::Ok,
                        "error" => HistoryStatus::Error,
                        "cancelled" => HistoryStatus::Cancelled,
                        _ => return Err(rusqlite::Error::InvalidQuery),
                    },
                    error: row.get(7)?,
                })
            })
            .map_err(io_error)?
            .collect::<rusqlite::Result<_>>()
            .map_err(io_error)?;
        Ok(result)
    }
}

impl Source {
    fn as_str(self) -> &'static str {
        match self {
            Self::Ui => "ui",
            Self::Cli => "cli",
            Self::Mcp => "mcp",
        }
    }
}

impl HistoryStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Ok => "ok",
            Self::Error => "error",
            Self::Cancelled => "cancelled",
        }
    }
}
