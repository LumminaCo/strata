use std::{fs, path::Path, time::Duration};

use rusqlite::{Connection, TransactionBehavior, params};
use strata_core::{CoreError, Result};

use crate::io_error;

pub const HISTORY_LIMIT: u32 = 10_000;
const MAX_SAVED_QUERY_TITLE_CHARS: usize = 120;
const MAX_SAVED_QUERY_SQL_BYTES: usize = 8_000_000;

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

#[derive(Debug, PartialEq)]
pub struct HistoryRecord {
    pub id: i64,
    pub entry: HistoryEntry,
}

#[derive(Debug, PartialEq)]
pub struct HistoryPage {
    pub items: Vec<HistoryRecord>,
    pub total: u64,
    pub has_more: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct SavedQuery {
    pub id: String,
    pub connection_id: Option<String>,
    pub title: String,
    pub sql: String,
    pub created_at: i64,
    pub updated_at: i64,
}

pub struct Database {
    pub(crate) connection: Connection,
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
        let mut version: u32 = transaction
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .map_err(io_error)?;
        if version == 0 {
            transaction
                .execute_batch(include_str!("migrations/001.sql"))
                .map_err(io_error)?;
            version = 1;
            transaction
                .pragma_update(None, "user_version", version)
                .map_err(io_error)?;
        }
        if version == 1 {
            transaction
                .execute_batch(include_str!("migrations/002.sql"))
                .map_err(io_error)?;
            version = 2;
            transaction
                .pragma_update(None, "user_version", version)
                .map_err(io_error)?;
        }
        if version != 2 {
            return Err(CoreError::config("Unsupported strata.db schema version"));
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

    pub fn catalog(
        &self,
        profile: &str,
        database: &str,
        schema: &str,
        min_time: i64,
    ) -> Result<Option<String>> {
        use rusqlite::OptionalExtension;
        self.connection.query_row(
            "SELECT payload FROM metadata_cache WHERE conn_id=?1 AND database_name=?2 AND schema_name=?3 AND fetched_at>=?4",
            params![profile, database, schema, min_time], |row| row.get(0),
        ).optional().map_err(io_error)
    }

    pub fn save_catalog(
        &self,
        profile: &str,
        database: &str,
        schema: &str,
        payload: &str,
        now: i64,
    ) -> Result<()> {
        self.connection.execute(
            "INSERT INTO metadata_cache VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT (conn_id, database_name, schema_name) DO UPDATE SET payload=excluded.payload,fetched_at=excluded.fetched_at",
            params![profile, database, schema, payload, now],
        ).map_err(io_error)?;
        Ok(())
    }

    pub fn clear_catalog(&self, profile: &str) -> Result<()> {
        self.connection
            .execute("DELETE FROM metadata_cache WHERE conn_id=?1", [profile])
            .map_err(io_error)?;
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
                    source: parse_source(&source)?,
                    sql: row.get(2)?,
                    started_at: row.get(3)?,
                    duration_ms: row.get(4)?,
                    rows: row.get(5)?,
                    status: parse_status(&status)?,
                    error: row.get(7)?,
                })
            })
            .map_err(io_error)?
            .collect::<rusqlite::Result<_>>()
            .map_err(io_error)?;
        Ok(result)
    }

    pub fn query_history(
        &self,
        connection_id: Option<&str>,
        search: Option<&str>,
        offset: u32,
        limit: u32,
    ) -> Result<HistoryPage> {
        let search = search.map(str::trim).filter(|value| !value.is_empty());
        let limit = limit.clamp(1, 1_000);
        let total: i64 = self
            .connection
            .query_row(
                "SELECT COUNT(*) FROM history
                 WHERE (?1 IS NULL OR conn_id = ?1)
                   AND (?2 IS NULL OR instr(lower(sql), lower(?2)) > 0)",
                params![connection_id, search],
                |row| row.get(0),
            )
            .map_err(io_error)?;
        let mut statement = self
            .connection
            .prepare(
                "SELECT id, conn_id, source, sql, started_at, duration_ms, rows, status, error
                 FROM history
                 WHERE (?1 IS NULL OR conn_id = ?1)
                   AND (?2 IS NULL OR instr(lower(sql), lower(?2)) > 0)
                 ORDER BY started_at DESC, id DESC
                 LIMIT ?3 OFFSET ?4",
            )
            .map_err(io_error)?;
        let items: Vec<HistoryRecord> = statement
            .query_map(params![connection_id, search, limit, offset], |row| {
                let source = row.get::<_, String>(2)?;
                let status = row.get::<_, String>(7)?;
                Ok(HistoryRecord {
                    id: row.get(0)?,
                    entry: HistoryEntry {
                        connection_id: row.get(1)?,
                        source: parse_source(&source)?,
                        sql: row.get(3)?,
                        started_at: row.get(4)?,
                        duration_ms: row.get(5)?,
                        rows: row.get(6)?,
                        status: parse_status(&status)?,
                        error: row.get(8)?,
                    },
                })
            })
            .map_err(io_error)?
            .collect::<rusqlite::Result<_>>()
            .map_err(io_error)?;
        let total = u64::try_from(total).unwrap_or(0);
        let has_more = (u64::from(offset) + items.len() as u64) < total;
        Ok(HistoryPage {
            items,
            total,
            has_more,
        })
    }

    pub fn list_saved_queries(
        &self,
        connection_id: Option<&str>,
        search: Option<&str>,
    ) -> Result<Vec<SavedQuery>> {
        let search = search.map(str::trim).filter(|value| !value.is_empty());
        let mut statement = self
            .connection
            .prepare(
                "SELECT id, conn_id, title, sql, created_at, updated_at
                 FROM saved_queries
                 WHERE (?1 IS NULL OR conn_id = ?1)
                   AND (?2 IS NULL OR instr(lower(title), lower(?2)) > 0 OR instr(lower(sql), lower(?2)) > 0)
                 ORDER BY updated_at DESC, id DESC",
            )
            .map_err(io_error)?;
        let rows = statement
            .query_map(params![connection_id, search], |row| {
                Ok(SavedQuery {
                    id: row.get(0)?,
                    connection_id: row.get(1)?,
                    title: row.get(2)?,
                    sql: row.get(3)?,
                    created_at: row.get(4)?,
                    updated_at: row.get(5)?,
                })
            })
            .map_err(io_error)?
            .collect::<rusqlite::Result<_>>()
            .map_err(io_error)?;
        Ok(rows)
    }

    pub fn create_saved_query(
        &self,
        id: &str,
        connection_id: Option<&str>,
        title: &str,
        sql: &str,
        now: i64,
    ) -> Result<SavedQuery> {
        let (title, sql) = validate_saved_query(title, sql)?;
        self.connection
            .execute(
                "INSERT INTO saved_queries (id, conn_id, title, sql, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![id, connection_id, title, sql, now, now],
            )
            .map_err(io_error)?;
        Ok(SavedQuery {
            id: id.to_owned(),
            connection_id: connection_id.map(str::to_owned),
            title,
            sql,
            created_at: now,
            updated_at: now,
        })
    }

    pub fn update_saved_query(
        &self,
        id: &str,
        title: &str,
        sql: &str,
        now: i64,
    ) -> Result<SavedQuery> {
        use rusqlite::OptionalExtension;
        let (title, sql) = validate_saved_query(title, sql)?;
        let updated = self
            .connection
            .execute(
                "UPDATE saved_queries SET title = ?1, sql = ?2, updated_at = ?3 WHERE id = ?4",
                params![title, sql, now, id],
            )
            .map_err(io_error)?;
        if updated == 0 {
            return Err(CoreError::config("Saved query does not exist"));
        }
        self.connection
            .query_row(
                "SELECT id, conn_id, title, sql, created_at, updated_at FROM saved_queries WHERE id = ?1",
                [id],
                |row| {
                    Ok(SavedQuery {
                        id: row.get(0)?,
                        connection_id: row.get(1)?,
                        title: row.get(2)?,
                        sql: row.get(3)?,
                        created_at: row.get(4)?,
                        updated_at: row.get(5)?,
                    })
                },
            )
            .optional()
            .map_err(io_error)?
            .ok_or_else(|| CoreError::config("Saved query does not exist"))
    }

    pub fn delete_saved_query(&self, id: &str) -> Result<()> {
        self.connection
            .execute("DELETE FROM saved_queries WHERE id = ?1", [id])
            .map_err(io_error)?;
        Ok(())
    }
}

fn validate_saved_query(title: &str, sql: &str) -> Result<(String, String)> {
    let title = title.trim();
    if title.is_empty() {
        return Err(CoreError::config("Enter a title for the saved query"));
    }
    if title.chars().count() > MAX_SAVED_QUERY_TITLE_CHARS {
        return Err(CoreError::config(
            "Saved query title must be 120 characters or fewer",
        ));
    }
    if sql.trim().is_empty() {
        return Err(CoreError::config("Saved query SQL must not be empty"));
    }
    if sql.len() > MAX_SAVED_QUERY_SQL_BYTES {
        return Err(CoreError::config("SQL exceeds 8 MB"));
    }
    Ok((title.to_owned(), sql.to_owned()))
}

fn parse_source(value: &str) -> rusqlite::Result<Source> {
    match value {
        "ui" => Ok(Source::Ui),
        "cli" => Ok(Source::Cli),
        "mcp" => Ok(Source::Mcp),
        _ => Err(rusqlite::Error::InvalidQuery),
    }
}

fn parse_status(value: &str) -> rusqlite::Result<HistoryStatus> {
    match value {
        "ok" => Ok(HistoryStatus::Ok),
        "error" => Ok(HistoryStatus::Error),
        "cancelled" => Ok(HistoryStatus::Cancelled),
        _ => Err(rusqlite::Error::InvalidQuery),
    }
}

impl Source {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ui => "ui",
            Self::Cli => "cli",
            Self::Mcp => "mcp",
        }
    }
}

impl HistoryStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ok => "ok",
            Self::Error => "error",
            Self::Cancelled => "cancelled",
        }
    }
}
