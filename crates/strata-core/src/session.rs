use std::{collections::HashMap, sync::Arc, time::Duration};

use futures_util::StreamExt;
use strata_sql::{Dialect, StmtClass, split};
use tokio::sync::{Mutex, RwLock};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::{
    Cell, CellKind, ColumnMeta, CoreError, DbConnection, DbKind, Driver, ExecEvent, ExecStream,
    Introspector, Profile, Result, Secret,
};

const MAX_ROWS: usize = 200_000;
const MAX_CELL_BYTES: usize = 16 * 1024 * 1024;
const DRAIN_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Clone, Copy)]
pub struct Limits {
    pub fetch_size: usize,
    pub row_cap: usize,
    pub timeout_ms: u32,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            fetch_size: 500,
            row_cap: MAX_ROWS,
            timeout_ms: 0,
        }
    }
}

#[derive(Debug)]
pub struct Batch {
    pub cursor: Uuid,
    pub columns: Vec<ColumnMeta>,
    pub rows: Vec<Vec<Cell>>,
    pub fetched: usize,
    pub exhausted: bool,
    pub capped: bool,
    pub affected: Option<u64>,
    pub messages: Vec<(String, String)>,
}

struct Cursor {
    id: Uuid,
    cancel: CancellationToken,
    stream: Option<ExecStream>,
    columns: Vec<ColumnMeta>,
    rows: Vec<Vec<Cell>>,
    delivered: usize,
    capped: bool,
    affected: Option<u64>,
}

struct SessionState {
    connection: Box<dyn DbConnection>,
    cursor: Option<Cursor>,
    broken: bool,
    manual: bool,
    transaction_open: bool,
    transaction_failed: bool,
}

struct Session {
    state: Mutex<SessionState>,
    active: Mutex<Option<(Uuid, CancellationToken)>>,
    closed: CancellationToken,
    dialect: Dialect,
    read_only: bool,
}

pub struct Core {
    drivers: HashMap<DbKind, Arc<dyn Driver>>,
    sessions: RwLock<HashMap<Uuid, Arc<Session>>>,
    limits: Limits,
}

impl Core {
    pub fn new(drivers: impl IntoIterator<Item = Arc<dyn Driver>>, limits: Limits) -> Result<Self> {
        if limits.fetch_size == 0 || limits.row_cap == 0 || limits.row_cap > MAX_ROWS {
            return Err(CoreError::config(
                "Fetch size must be positive and row cap must be between 1 and 200,000",
            ));
        }
        Ok(Self {
            drivers: drivers
                .into_iter()
                .map(|driver| (driver.kind(), driver))
                .collect(),
            sessions: RwLock::default(),
            limits,
        })
    }

    fn driver(&self, kind: DbKind) -> Result<&Arc<dyn Driver>> {
        self.drivers
            .get(&kind)
            .ok_or_else(|| CoreError::config("Database driver is unavailable"))
    }

    pub async fn open_session(&self, profile: &Profile, secret: &Secret) -> Result<Uuid> {
        profile.validate()?;
        let mut connection = self.driver(profile.kind)?.connect(profile, secret).await?;
        connection.set_read_only(profile.read_only).await?;
        connection
            .set_statement_timeout(self.limits.timeout_ms)
            .await?;
        let id = Uuid::now_v7();
        let dialect = match profile.kind {
            DbKind::Postgres => Dialect::Postgres,
            DbKind::SqlServer => Dialect::SqlServer,
            DbKind::Oracle => Dialect::Oracle,
        };
        self.sessions.write().await.insert(
            id,
            Arc::new(Session {
                state: Mutex::new(SessionState {
                    connection,
                    cursor: None,
                    broken: false,
                    manual: false,
                    transaction_open: false,
                    transaction_failed: false,
                }),
                active: Mutex::new(None),
                closed: CancellationToken::new(),
                dialect,
                read_only: profile.read_only,
            }),
        );
        Ok(id)
    }

    pub async fn introspector(
        &self,
        profile: &Profile,
        secret: &Secret,
    ) -> Result<Box<dyn Introspector>> {
        profile.validate()?;
        self.driver(profile.kind)?
            .introspector(profile, secret)
            .await
    }

    async fn session(&self, id: Uuid) -> Result<Arc<Session>> {
        self.sessions
            .read()
            .await
            .get(&id)
            .cloned()
            .ok_or_else(|| CoreError::config("Session does not exist"))
    }

    pub async fn run(&self, session: Uuid, sql: &str) -> Result<Batch> {
        let session = self.session(session).await?;
        let spans = split(sql, session.dialect, false);
        let [statement] = spans.as_slice() else {
            return Err(CoreError::config("Run exactly one statement at a time"));
        };
        if session.read_only && statement.kind_hint != StmtClass::Read {
            return Err(CoreError::ReadOnlyViolation {
                reason: "Only recognized reads may run on this profile".into(),
            });
        }
        let mut state = session.state.lock().await;
        session.ensure_open(&state)?;
        if state.manual && statement.kind_hint == StmtClass::TxControl {
            return Err(CoreError::config(
                "Use the transaction controls in manual mode",
            ));
        }
        state.discard().await?;
        if state.manual && !state.transaction_open {
            state.connection.begin().await?;
            state.transaction_open = true;
            state.transaction_failed = false;
        }
        let cancel = session.closed.child_token();
        let stream = state.connection.execute(sql, cancel.clone()).await?;
        let cursor = Uuid::now_v7();
        state.cursor = Some(Cursor {
            id: cursor,
            cancel,
            stream: Some(stream),
            columns: Vec::new(),
            rows: Vec::new(),
            delivered: 0,
            capped: false,
            affected: None,
        });
        self.read(&session, &mut state, cursor, self.limits.fetch_size)
            .await
    }

    pub async fn fetch_more(&self, session: Uuid, cursor: Uuid, count: usize) -> Result<Batch> {
        if count == 0 {
            return Err(CoreError::config("Fetch size must be positive"));
        }
        let session = self.session(session).await?;
        let mut state = session.state.lock().await;
        self.read(&session, &mut state, cursor, count).await
    }

    async fn read(
        &self,
        session: &Session,
        state: &mut SessionState,
        id: Uuid,
        count: usize,
    ) -> Result<Batch> {
        session.ensure_open(state)?;
        let cursor = state
            .cursor
            .as_ref()
            .filter(|cursor| cursor.id == id)
            .ok_or_else(|| CoreError::config("Cursor does not exist"))?;
        *session.active.lock().await = Some((id, cursor.cancel.clone()));
        let result = state.read(count, self.limits.row_cap).await;
        *session.active.lock().await = None;
        if state.transaction_open
            && (result.is_err() || result.as_ref().is_ok_and(|batch| batch.capped))
        {
            state.transaction_failed = true;
        }
        result
    }

    pub async fn set_manual_transactions(&self, session: Uuid, manual: bool) -> Result<()> {
        let session = self.session(session).await?;
        let mut state = session.state.lock().await;
        session.ensure_open(&state)?;
        if state.transaction_open && state.manual != manual {
            return Err(CoreError::config(
                "Commit or roll back the open transaction first",
            ));
        }
        state.manual = manual;
        Ok(())
    }

    pub async fn transaction_open(&self, session: Uuid) -> Result<bool> {
        let session = self.session(session).await?;
        Ok(session.state.lock().await.transaction_open)
    }

    pub async fn commit(&self, session: Uuid) -> Result<()> {
        self.finish_transaction(session, true).await
    }

    pub async fn rollback(&self, session: Uuid) -> Result<()> {
        self.finish_transaction(session, false).await
    }

    async fn finish_transaction(&self, session: Uuid, commit: bool) -> Result<()> {
        let session = self.session(session).await?;
        let mut state = session.state.lock().await;
        session.ensure_open(&state)?;
        if !state.transaction_open {
            return Err(CoreError::config("There is no open manual transaction"));
        }
        if commit && state.transaction_failed {
            return Err(CoreError::config(
                "Roll back the failed transaction before continuing",
            ));
        }
        // An unfinished statement must be fully consumed before committing it.
        if commit
            && state
                .cursor
                .as_ref()
                .is_some_and(|cursor| cursor.stream.is_some())
        {
            return Err(CoreError::config(
                "Finish fetching or close the current result first",
            ));
        }
        state.discard().await?;
        if commit {
            state.connection.commit().await?;
        } else {
            state.connection.rollback().await?;
        }
        state.transaction_open = false;
        state.transaction_failed = false;
        Ok(())
    }

    pub async fn get_cell(
        &self,
        session: Uuid,
        cursor: Uuid,
        row: usize,
        column: usize,
    ) -> Result<Cell> {
        let session = self.session(session).await?;
        let state = session.state.lock().await;
        state
            .cursor
            .as_ref()
            .filter(|value| value.id == cursor)
            .and_then(|value| value.rows.get(row))
            .and_then(|row| row.get(column))
            .cloned()
            .ok_or_else(|| CoreError::config("Cell does not exist"))
    }

    pub async fn stop(&self, session: Uuid) -> Result<()> {
        let session = self.session(session).await?;
        let active_id = session.active.lock().await.as_ref().map(|(id, active)| {
            active.cancel();
            *id
        });
        let mut state = session.state.lock().await;
        if active_id.is_none() || state.cursor.as_ref().map(|cursor| cursor.id) == active_id {
            state.discard().await?;
        }
        Ok(())
    }

    pub async fn close_session(&self, session: Uuid) -> Result<()> {
        let Some(session) = self.sessions.write().await.remove(&session) else {
            return Ok(());
        };
        session.closed.cancel();
        session.state.lock().await.discard().await
    }
}

impl Session {
    fn ensure_open(&self, state: &SessionState) -> Result<()> {
        if self.closed.is_cancelled() || state.broken || state.connection.is_closed() {
            return Err(CoreError::Connect {
                message: "Session is disconnected".into(),
            });
        }
        Ok(())
    }
}

impl SessionState {
    async fn discard(&mut self) -> Result<()> {
        if let Some(mut cursor) = self.cursor.take()
            && let Some(mut stream) = cursor.stream.take()
        {
            cursor.cancel.cancel();
            let result = cancel_and_drain(self.connection.cancel_handle(), &mut stream).await;
            self.transaction_failed |= self.transaction_open;
            self.broken |= result.is_err();
            result?;
        }
        Ok(())
    }

    async fn read(&mut self, count: usize, cap: usize) -> Result<Batch> {
        let cursor = self
            .cursor
            .as_mut()
            .ok_or_else(|| CoreError::config("Cursor does not exist"))?;
        let from = cursor.delivered;
        let target = from.saturating_add(count).min(cap);
        let mut messages = Vec::new();
        while cursor.rows.len() < target {
            let Some(stream) = cursor.stream.as_mut() else {
                break;
            };
            let next = tokio::select! {
                biased;
                _ = cursor.cancel.cancelled() => {
                    let result = cancel_and_drain(self.connection.cancel_handle(), stream).await;
                    cursor.stream = None;
                    self.broken |= result.is_err();
                    result?;
                    return Err(CoreError::Cancelled);
                }
                event = stream.next() => event,
            };
            match next {
                Some(Ok(ExecEvent::ResultStart(columns))) => cursor.columns = columns,
                Some(Ok(ExecEvent::Row(row))) => cursor.rows.push(
                    row.into_iter()
                        .enumerate()
                        .map(|(index, cell)| {
                            bound_cell(cell, cursor.columns.get(index).map(|column| column.kind))
                        })
                        .collect(),
                ),
                Some(Ok(ExecEvent::ResultEnd)) => {}
                Some(Ok(ExecEvent::Affected(rows))) => cursor.affected = Some(rows),
                Some(Ok(ExecEvent::Message { level, text })) => messages.push((level, text)),
                Some(Err(error)) => {
                    cursor.stream = None;
                    return Err(error);
                }
                None => cursor.stream = None,
            }
        }
        if cursor.rows.len() == cap
            && let Some(stream) = cursor.stream.as_mut()
        {
            cursor.cancel.cancel();
            let result = cancel_and_drain(self.connection.cancel_handle(), stream).await;
            cursor.stream = None;
            cursor.capped = true;
            self.broken |= result.is_err();
            result?;
        }
        let delivered = target.min(cursor.rows.len());
        cursor.delivered = delivered;
        let exhausted = cursor.stream.is_none() && delivered == cursor.rows.len();
        Ok(Batch {
            cursor: cursor.id,
            columns: cursor.columns.clone(),
            rows: cursor.rows[from..delivered]
                .iter()
                .map(|row| {
                    row.iter()
                        .enumerate()
                        .map(|(index, cell)| {
                            preview_cell(cell, cursor.columns.get(index).map(|column| column.kind))
                        })
                        .collect()
                })
                .collect(),
            fetched: delivered,
            exhausted,
            capped: cursor.capped && exhausted,
            affected: cursor.affected,
            messages,
        })
    }
}

async fn cancel_and_drain(cancel: crate::CancelHandle, stream: &mut ExecStream) -> Result<()> {
    tokio::time::timeout(DRAIN_TIMEOUT, async {
        cancel().await?;
        while stream.next().await.is_some() {}
        Ok(())
    })
    .await
    .unwrap_or(Err(CoreError::Timeout))
}

fn bound_cell(cell: Cell, kind: Option<CellKind>) -> Cell {
    // Binary values are held as hex, which uses two characters per byte.
    let bound = if kind == Some(CellKind::Binary) {
        MAX_CELL_BYTES * 2 + 2
    } else {
        MAX_CELL_BYTES
    };
    match cell {
        Cell::Text(text) if text.len() > bound => {
            Cell::Text(format!("[Value: {} bytes]", text.len()))
        }
        other => other,
    }
}

fn preview_cell(cell: &Cell, kind: Option<CellKind>) -> Cell {
    if kind == Some(CellKind::Binary)
        && let Cell::Text(text) = cell
        && let Some(hex) = text.strip_prefix("0x")
        && hex.is_ascii()
    {
        let prefix = &hex[..hex.len().min(128)];
        let ellipsis = if hex.len() > 128 { "…" } else { "" };
        return Cell::Text(format!("0x{prefix}{ellipsis} ({} bytes)", hex.len() / 2));
    }
    match cell {
        Cell::Text(text) if let Some((offset, _)) = text.char_indices().nth(2000) => {
            Cell::Text(format!("{}…", &text[..offset]))
        }
        other => other.clone(),
    }
}
