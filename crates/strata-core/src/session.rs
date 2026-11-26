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

impl Limits {
    fn validate(self) -> Result<Self> {
        if self.fetch_size == 0 || self.row_cap == 0 || self.row_cap > MAX_ROWS {
            return Err(CoreError::config(
                "Fetch size must be positive and row cap must be between 1 and 200,000",
            ));
        }
        Ok(self)
    }
}

#[derive(Debug)]
pub struct Batch {
    pub cursor: Uuid,
    pub columns: Vec<ColumnMeta>,
    pub rows: Vec<Vec<Cell>>,
    pub fetched: usize,
    pub exhausted: bool,
    pub next_result: bool,
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
    changes_context: bool,
    next_columns: Option<Vec<ColumnMeta>>,
}

struct SessionState {
    connection: Box<dyn DbConnection>,
    cursor: Option<Cursor>,
    previous: HashMap<Uuid, Cursor>,
    resolution_path: Vec<String>,
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
    limits: Limits,
}

pub struct Core {
    drivers: HashMap<DbKind, Arc<dyn Driver>>,
    sessions: RwLock<HashMap<Uuid, Arc<Session>>>,
    limits: Limits,
}

impl Core {
    pub fn new(drivers: impl IntoIterator<Item = Arc<dyn Driver>>, limits: Limits) -> Result<Self> {
        let limits = limits.validate()?;
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
        self.open_session_with_limits(profile, secret, self.limits)
            .await
    }

    pub async fn open_session_with_limits(
        &self,
        profile: &Profile,
        secret: &Secret,
        limits: Limits,
    ) -> Result<Uuid> {
        let limits = limits.validate()?;
        profile.validate()?;
        let mut connection = self.driver(profile.kind)?.connect(profile, secret).await?;
        connection.set_read_only(profile.read_only).await?;
        connection.set_statement_timeout(limits.timeout_ms).await?;
        let resolution_path = connection.resolution_path().await?;
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
                    previous: HashMap::new(),
                    resolution_path,
                    broken: false,
                    manual: false,
                    transaction_open: false,
                    transaction_failed: false,
                }),
                active: Mutex::new(None),
                closed: CancellationToken::new(),
                dialect,
                read_only: profile.read_only,
                limits,
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
        self.run_batch(
            session,
            sql,
            self.session(session).await?.limits.fetch_size,
            None,
        )
        .await
    }

    pub async fn run_batch(
        &self,
        session: Uuid,
        sql: &str,
        count: usize,
        cancellation: Option<&CancellationToken>,
    ) -> Result<Batch> {
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
        if cancellation.is_some_and(CancellationToken::is_cancelled) {
            return Err(CoreError::Cancelled);
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
            changes_context: statement.kind_hint == StmtClass::Session,
            next_columns: None,
        });
        let read = self.read(&session, &mut state, cursor, count, cancellation);
        read.await
    }

    pub async fn fetch_more(&self, session: Uuid, cursor: Uuid, count: usize) -> Result<Batch> {
        self.fetch_batch(session, cursor, count, None).await
    }

    pub async fn fetch_batch(
        &self,
        session: Uuid,
        cursor: Uuid,
        count: usize,
        cancellation: Option<&CancellationToken>,
    ) -> Result<Batch> {
        if count == 0 {
            return Err(CoreError::config("Fetch size must be positive"));
        }
        let session = self.session(session).await?;
        let mut state = session.state.lock().await;
        self.read(&session, &mut state, cursor, count, cancellation)
            .await
    }

    async fn read(
        &self,
        session: &Session,
        state: &mut SessionState,
        id: Uuid,
        count: usize,
        cancellation: Option<&CancellationToken>,
    ) -> Result<Batch> {
        session.ensure_open(state)?;
        let cursor = state
            .cursor
            .as_ref()
            .filter(|cursor| cursor.id == id)
            .ok_or_else(|| CoreError::config("Cursor does not exist"))?;
        *session.active.lock().await = Some((id, cursor.cancel.clone()));
        let retained = state
            .previous
            .values()
            .map(|cursor| cursor.rows.len())
            .sum::<usize>();
        let result = state
            .read(
                count,
                session.limits.row_cap.saturating_sub(retained),
                cancellation,
            )
            .await;
        *session.active.lock().await = None;
        if result.as_ref().is_ok_and(|batch| batch.exhausted)
            && state
                .cursor
                .as_ref()
                .is_some_and(|cursor| cursor.changes_context && cursor.stream.is_none())
        {
            state.resolution_path = state.connection.resolution_path().await?;
        }
        if state.transaction_open
            && (result.is_err() || result.as_ref().is_ok_and(|batch| batch.capped))
        {
            state.transaction_failed = true;
        }
        result
    }

    pub async fn next_result(
        &self,
        id: Uuid,
        cursor_id: Uuid,
        count: usize,
        cancellation: Option<&CancellationToken>,
    ) -> Result<Batch> {
        let session = self.session(id).await?;
        let mut state = session.state.lock().await;
        session.ensure_open(&state)?;
        let active = state
            .cursor
            .as_mut()
            .filter(|cursor| cursor.id == cursor_id)
            .ok_or_else(|| CoreError::config("Cursor does not exist"))?;
        let columns = active
            .next_columns
            .take()
            .ok_or_else(|| CoreError::config("No next result set"))?;
        let next_id = Uuid::now_v7();
        let next = Cursor {
            id: next_id,
            stream: active.stream.take(),
            cancel: active.cancel.clone(),
            columns,
            rows: Vec::new(),
            delivered: 0,
            capped: false,
            affected: None,
            changes_context: active.changes_context,
            next_columns: None,
        };
        if let Some(previous) = state.cursor.replace(next) {
            state.previous.insert(previous.id, previous);
        }
        self.read(&session, &mut state, next_id, count.max(1), cancellation)
            .await
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

    pub async fn transaction_state(&self, session: Uuid) -> Result<(bool, bool)> {
        let session = self.session(session).await?;
        let state = session.state.lock().await;
        Ok((state.manual, state.transaction_open))
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
            .or_else(|| state.previous.get(&cursor))
            .and_then(|value| value.rows.get(row))
            .and_then(|row| row.get(column))
            .cloned()
            .ok_or_else(|| CoreError::config("Cell does not exist"))
    }

    pub async fn server_info(&self, session: Uuid) -> Result<crate::ServerInfo> {
        let session = self.session(session).await?;
        let mut state = session.state.lock().await;
        session.ensure_open(&state)?;
        if state
            .cursor
            .as_ref()
            .is_some_and(|cursor| cursor.stream.is_some())
        {
            return Err(CoreError::config(
                "Finish fetching before inspecting the session",
            ));
        }
        state.connection.server_info().await
    }

    pub async fn set_dbms_output(&self, session: Uuid, enabled: bool) -> Result<()> {
        let session = self.session(session).await?;
        let mut state = session.state.lock().await;
        session.ensure_open(&state)?;
        if state
            .cursor
            .as_ref()
            .is_some_and(|cursor| cursor.stream.is_some())
        {
            return Err(CoreError::config(
                "Finish fetching this result before changing DBMS_OUTPUT",
            ));
        }
        state.connection.set_dbms_output(enabled).await
    }

    pub async fn set_explain(&self, session: Uuid, enabled: bool) -> Result<()> {
        let session = self.session(session).await?;
        let mut state = session.state.lock().await;
        session.ensure_open(&state)?;
        state.discard().await?;
        state.connection.set_explain(enabled).await
    }

    pub async fn set_schema(&self, session: Uuid, schema: &str) -> Result<Option<String>> {
        let schema = schema.trim();
        if schema.is_empty() {
            return Err(CoreError::config("Schema name cannot be empty"));
        }
        let session = self.session(session).await?;
        let mut state = session.state.lock().await;
        session.ensure_open(&state)?;
        if state.transaction_open {
            return Err(CoreError::config(
                "Commit or roll back the open transaction first",
            ));
        }
        state.discard().await?;
        state.connection.set_schema(schema).await?;
        state.resolution_path = state.connection.resolution_path().await?;
        Ok(state.connection.server_info().await?.schema)
    }

    pub async fn resolution_path(&self, session: Uuid) -> Result<Vec<String>> {
        let session = self.session(session).await?;
        Ok(session.state.lock().await.resolution_path.clone())
    }

    pub async fn clear_results(&self, session: Uuid) -> Result<()> {
        let session = self.session(session).await?;
        let mut state = session.state.lock().await;
        state.previous.clear();
        state.discard().await
    }

    pub async fn preserve_results(&self, session: Uuid) -> Result<()> {
        let session = self.session(session).await?;
        let mut state = session.state.lock().await;
        if let Some(mut cursor) = state.cursor.take() {
            if let Some(mut stream) = cursor.stream.take() {
                cursor.cancel.cancel();
                let result = cancel_and_drain(state.connection.cancel_handle(), &mut stream).await;
                state.transaction_failed |= state.transaction_open;
                state.broken |= result.is_err();
                result?;
            }
            if !cursor.columns.is_empty() {
                state.previous.insert(cursor.id, cursor);
            }
        }
        Ok(())
    }

    pub async fn drop_result(&self, session: Uuid, cursor: Uuid) -> Result<()> {
        let session = self.session(session).await?;
        let mut state = session.state.lock().await;
        if state.previous.remove(&cursor).is_some() {
            return Ok(());
        }
        if state
            .cursor
            .as_ref()
            .is_some_and(|value| value.id == cursor)
        {
            state.discard().await?;
        }
        Ok(())
    }

    pub async fn retain_result(&self, session: Uuid, cursor: Uuid) -> Result<()> {
        let session = self.session(session).await?;
        let mut state = session.state.lock().await;
        if state
            .cursor
            .as_ref()
            .is_some_and(|value| value.id == cursor && value.stream.is_none())
            && let Some(value) = state.cursor.take()
        {
            state.previous.insert(cursor, value);
        }
        Ok(())
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

    async fn read(
        &mut self,
        count: usize,
        cap: usize,
        cancellation: Option<&CancellationToken>,
    ) -> Result<Batch> {
        let cursor = self
            .cursor
            .as_mut()
            .ok_or_else(|| CoreError::config("Cursor does not exist"))?;
        let from = cursor.delivered;
        let target = from.saturating_add(count).min(cap);
        let mut messages = Vec::new();
        while cursor.next_columns.is_none() && (cursor.rows.len() < target || cap == 0) {
            let Some(stream) = cursor.stream.as_mut() else {
                break;
            };
            let next = tokio::select! {
                biased;
                _ = async {
                    match cancellation {
                        Some(run) => tokio::select! {
                            () = run.cancelled() => (),
                            () = cursor.cancel.cancelled() => (),
                        },
                        None => cursor.cancel.cancelled().await,
                    }
                } => {
                    cursor.cancel.cancel();
                    let result = cancel_and_drain(self.connection.cancel_handle(), stream).await;
                    cursor.stream = None;
                    self.broken |= result.is_err();
                    result?;
                    return Err(CoreError::Cancelled);
                }
                event = stream.next() => event,
            };
            match next {
                Some(Ok(ExecEvent::ResultStart(columns))) => {
                    if cursor.columns.is_empty() {
                        cursor.columns = columns;
                    } else {
                        cursor.next_columns = Some(columns);
                    }
                }
                Some(Ok(ExecEvent::Row(_))) if cap == 0 => break,
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
            cursor.next_columns = None;
            cursor.cancel.cancel();
            let result = cancel_and_drain(self.connection.cancel_handle(), stream).await;
            cursor.stream = None;
            cursor.capped = true;
            self.broken |= result.is_err();
            result?;
        }
        let delivered = target.min(cursor.rows.len());
        cursor.delivered = delivered;
        let next_result = cursor.next_columns.is_some();
        let exhausted = (cursor.stream.is_none() || next_result) && delivered == cursor.rows.len();
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
            next_result,
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{CancelHandle, DriverOptions, Environment, ServerInfo, Tls};
    use async_trait::async_trait;
    use futures_util::stream;

    struct FakeDriver {
        kind: DbKind,
        supports_schema: bool,
    }

    struct FakeConnection {
        schema: String,
        supports_schema: bool,
    }

    #[async_trait]
    impl Driver for FakeDriver {
        fn kind(&self) -> DbKind {
            self.kind
        }

        async fn connect(
            &self,
            _profile: &Profile,
            _secret: &Secret,
        ) -> Result<Box<dyn DbConnection>> {
            Ok(Box::new(FakeConnection {
                schema: "public".into(),
                supports_schema: self.supports_schema,
            }))
        }

        async fn introspector(
            &self,
            _profile: &Profile,
            _secret: &Secret,
        ) -> Result<Box<dyn Introspector>> {
            Err(CoreError::config("unused"))
        }
    }

    #[async_trait]
    impl DbConnection for FakeConnection {
        async fn execute(&mut self, _sql: &str, _cancel: CancellationToken) -> Result<ExecStream> {
            Ok(Box::pin(stream::empty()))
        }

        fn cancel_handle(&self) -> CancelHandle {
            Arc::new(|| Box::pin(async { Ok(()) }))
        }

        async fn set_read_only(&mut self, _on: bool) -> Result<()> {
            Ok(())
        }
        async fn set_statement_timeout(&mut self, _milliseconds: u32) -> Result<()> {
            Ok(())
        }
        async fn begin(&mut self) -> Result<()> {
            Ok(())
        }
        async fn commit(&mut self) -> Result<()> {
            Ok(())
        }
        async fn rollback(&mut self) -> Result<()> {
            Ok(())
        }
        async fn server_info(&mut self) -> Result<ServerInfo> {
            Ok(ServerInfo {
                version: "Fake 1".into(),
                database: "db".into(),
                schema: Some(self.schema.clone()),
                user: "user".into(),
            })
        }
        async fn set_schema(&mut self, schema: &str) -> Result<()> {
            if !self.supports_schema {
                return Err(CoreError::config(
                    "This database does not support changing the session schema",
                ));
            }
            self.schema = schema.into();
            Ok(())
        }
        async fn ping(&mut self) -> Result<()> {
            Ok(())
        }
        fn is_closed(&self) -> bool {
            false
        }
    }

    fn test_profile(kind: DbKind) -> Profile {
        Profile {
            id: Uuid::now_v7(),
            name: "test".into(),
            kind,
            env: Environment::Dev,
            color: None,
            folder: None,
            host: "localhost".into(),
            port: 5432,
            database: "db".into(),
            user: "user".into(),
            secret: "prompt".into(),
            read_only: true,
            agent_access: crate::AgentAccess::None,
            allow_agent_ddl: false,
            tls: Tls::default(),
            options: DriverOptions::default(),
        }
    }

    #[tokio::test]
    async fn set_schema_updates_resolution_path_and_guards_transactions() {
        let core = Core::new(
            [
                Arc::new(FakeDriver {
                    kind: DbKind::Postgres,
                    supports_schema: true,
                }) as Arc<dyn Driver>,
                Arc::new(FakeDriver {
                    kind: DbKind::SqlServer,
                    supports_schema: false,
                }) as Arc<dyn Driver>,
            ],
            Limits::default(),
        )
        .unwrap();
        let secret = Secret::new("secret".into());

        // Works even on a read-only profile and updates resolution_path.
        let pg = core
            .open_session(&test_profile(DbKind::Postgres), &secret)
            .await
            .unwrap();
        assert_eq!(core.resolution_path(pg).await.unwrap(), ["public"]);
        let applied = core.set_schema(pg, "  analytics  ").await.unwrap();
        assert_eq!(applied.as_deref(), Some("analytics"));
        assert_eq!(core.resolution_path(pg).await.unwrap(), ["analytics"]);

        // Rejects empty schema names.
        assert!(core.set_schema(pg, "   ").await.is_err());

        // Rejects while a manual transaction is open.
        core.set_manual_transactions(pg, true).await.unwrap();
        core.run(pg, "SELECT 1").await.unwrap();
        assert!(core.set_schema(pg, "other").await.is_err());
        core.rollback(pg).await.unwrap();
        assert_eq!(
            core.set_schema(pg, "other").await.unwrap().as_deref(),
            Some("other")
        );

        // Unsupported drivers return a config error.
        let mssql = core
            .open_session(&test_profile(DbKind::SqlServer), &secret)
            .await
            .unwrap();
        assert!(core.set_schema(mssql, "sales").await.is_err());
    }

    struct ScriptedDriver {
        batches: Arc<Mutex<std::collections::VecDeque<Vec<ExecEvent>>>>,
    }

    struct ScriptedConnection {
        batches: Arc<Mutex<std::collections::VecDeque<Vec<ExecEvent>>>>,
    }

    #[async_trait]
    impl Driver for ScriptedDriver {
        fn kind(&self) -> DbKind {
            DbKind::Postgres
        }

        async fn connect(
            &self,
            _profile: &Profile,
            _secret: &Secret,
        ) -> Result<Box<dyn DbConnection>> {
            Ok(Box::new(ScriptedConnection {
                batches: self.batches.clone(),
            }))
        }

        async fn introspector(
            &self,
            _profile: &Profile,
            _secret: &Secret,
        ) -> Result<Box<dyn Introspector>> {
            Err(CoreError::config("unused"))
        }
    }

    #[async_trait]
    impl DbConnection for ScriptedConnection {
        async fn execute(&mut self, _sql: &str, _cancel: CancellationToken) -> Result<ExecStream> {
            let events = self.batches.lock().await.pop_front().unwrap_or_default();
            Ok(Box::pin(stream::iter(events.into_iter().map(Ok))))
        }

        fn cancel_handle(&self) -> CancelHandle {
            Arc::new(|| Box::pin(async { Ok(()) }))
        }

        async fn set_read_only(&mut self, _on: bool) -> Result<()> {
            Ok(())
        }
        async fn set_statement_timeout(&mut self, _milliseconds: u32) -> Result<()> {
            Ok(())
        }
        async fn begin(&mut self) -> Result<()> {
            Ok(())
        }
        async fn commit(&mut self) -> Result<()> {
            Ok(())
        }
        async fn rollback(&mut self) -> Result<()> {
            Ok(())
        }
        async fn server_info(&mut self) -> Result<ServerInfo> {
            Ok(ServerInfo {
                version: "Fake 1".into(),
                database: "db".into(),
                schema: Some("public".into()),
                user: "user".into(),
            })
        }
        async fn ping(&mut self) -> Result<()> {
            Ok(())
        }
        fn is_closed(&self) -> bool {
            false
        }
    }

    fn text_column(name: &str) -> ColumnMeta {
        ColumnMeta {
            name: name.into(),
            db_type: "text".into(),
            kind: CellKind::Text,
            nullable: Some(false),
            table_oid: None,
            column_id: None,
            foreign_key: None,
        }
    }

    #[tokio::test]
    async fn preserve_results_keeps_previous_cells_and_drop_result_frees_row_cap() {
        let batches = Arc::new(Mutex::new(std::collections::VecDeque::from([
            vec![
                ExecEvent::ResultStart(vec![text_column("label")]),
                ExecEvent::Row(vec![Cell::Text("first-1".into())]),
                ExecEvent::Row(vec![Cell::Text("first-2".into())]),
                ExecEvent::Row(vec![Cell::Text("first-3".into())]),
                ExecEvent::ResultEnd,
            ],
            vec![
                ExecEvent::ResultStart(vec![text_column("label")]),
                ExecEvent::Row(vec![Cell::Text("second-1".into())]),
                ExecEvent::ResultEnd,
            ],
            vec![
                ExecEvent::ResultStart(vec![text_column("label")]),
                ExecEvent::Row(vec![Cell::Text("third-1".into())]),
                ExecEvent::Row(vec![Cell::Text("third-2".into())]),
                ExecEvent::ResultEnd,
            ],
        ])));
        let core = Core::new(
            [Arc::new(ScriptedDriver { batches }) as Arc<dyn Driver>],
            Limits {
                fetch_size: 2,
                row_cap: 4,
                timeout_ms: 0,
            },
        )
        .unwrap();
        let session = core
            .open_session(&test_profile(DbKind::Postgres), &Secret::new("s".into()))
            .await
            .unwrap();

        // First query pauses after 2 rows (still streaming).
        let first = core.run_batch(session, "SELECT 1", 2, None).await.unwrap();
        assert!(!first.exhausted);
        assert_eq!(first.rows.len(), 2);

        // Preserving drains the paused stream and retains its fetched rows for get_cell.
        core.preserve_results(session).await.unwrap();
        let second = core.run_batch(session, "SELECT 2", 2, None).await.unwrap();
        assert!(second.exhausted);
        assert_eq!(
            core.get_cell(session, first.cursor, 0, 0).await.unwrap(),
            Cell::Text("first-1".into())
        );
        assert_eq!(
            core.get_cell(session, second.cursor, 0, 0).await.unwrap(),
            Cell::Text("second-1".into())
        );

        // Dropping the first result removes it and frees row_cap budget for a third query.
        core.drop_result(session, first.cursor).await.unwrap();
        assert!(core.get_cell(session, first.cursor, 0, 0).await.is_err());

        core.preserve_results(session).await.unwrap();
        let third = core.run_batch(session, "SELECT 3", 2, None).await.unwrap();
        assert_eq!(third.rows.len(), 2);
        assert!(!third.capped);
        assert_eq!(
            core.get_cell(session, second.cursor, 0, 0).await.unwrap(),
            Cell::Text("second-1".into())
        );
        assert_eq!(
            core.get_cell(session, third.cursor, 1, 0).await.unwrap(),
            Cell::Text("third-2".into())
        );
    }
}
