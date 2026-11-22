//! PostgreSQL transport, text-protocol decoding, and catalog introspection.

mod catalog;
mod tls;
mod values;

use std::{sync::Arc, time::Duration};

use async_trait::async_trait;
use futures_util::{StreamExt, future::poll_fn};
use strata_core::{
    CancelHandle, CoreError, DbConnection, DbKind, Driver, ExecEvent, ExecStream, Introspector,
    Profile, Result, Secret, ServerInfo, TlsMode,
};
use tokio::{sync::broadcast, task::JoinHandle};
use tokio_postgres::{AsyncMessage, Client, Config, SimpleQueryMessage, config::SslMode};
use tokio_postgres_rustls::MakeRustlsConnect;
use tokio_util::sync::CancellationToken;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Default)]
pub struct Postgres;

#[async_trait]
impl Driver for Postgres {
    fn kind(&self) -> DbKind {
        DbKind::Postgres
    }

    async fn connect(&self, profile: &Profile, secret: &Secret) -> Result<Box<dyn DbConnection>> {
        let config = config(profile, secret);
        let tls = tls::connector(profile.tls.mode)?;
        let (client, mut connection) =
            tokio::time::timeout(CONNECT_TIMEOUT, config.connect(tls.clone()))
                .await
                .map_err(|_| CoreError::Timeout)?
                .map_err(connection_error)?;
        let (notices, _) = broadcast::channel(128);
        let publisher = notices.clone();
        let task = tokio::spawn(async move {
            while let Some(Ok(message)) = poll_fn(|cx| connection.poll_message(cx)).await {
                if let AsyncMessage::Notice(notice) = message {
                    let _ = publisher.send((notice.severity().into(), notice.message().into()));
                }
            }
        });
        Ok(Box::new(PostgresConnection {
            client: Arc::new(client),
            tls,
            notices,
            task,
            read_only: false,
        }))
    }

    async fn introspector(
        &self,
        profile: &Profile,
        secret: &Secret,
    ) -> Result<Box<dyn Introspector>> {
        let manager = deadpool_postgres::Manager::new(
            config(profile, secret),
            tls::connector(profile.tls.mode)?,
        );
        let pool = deadpool_postgres::Pool::builder(manager)
            .max_size(2)
            .runtime(deadpool_postgres::Runtime::Tokio1)
            .wait_timeout(Some(CONNECT_TIMEOUT))
            .create_timeout(Some(CONNECT_TIMEOUT))
            .build()
            .map_err(|_| CoreError::config("Cannot configure the PostgreSQL metadata pool"))?;
        Ok(Box::new(catalog::Catalog { pool }))
    }
}

fn config(profile: &Profile, secret: &Secret) -> Config {
    let mut config = Config::new();
    // Passing fields individually prevents connection-string interpolation and leaking secrets.
    config
        .host(&profile.host)
        .port(profile.port)
        .dbname(&profile.database)
        .user(&profile.user)
        .password(secret.expose())
        .application_name("Strata")
        .options("-c DateStyle=ISO,YMD -c bytea_output=hex -c standard_conforming_strings=on")
        .connect_timeout(CONNECT_TIMEOUT)
        .ssl_mode(match profile.tls.mode {
            TlsMode::Disable => SslMode::Disable,
            TlsMode::Prefer => SslMode::Prefer,
            _ => SslMode::Require,
        });
    config
}

struct PostgresConnection {
    client: Arc<Client>,
    tls: MakeRustlsConnect,
    notices: broadcast::Sender<(String, String)>,
    task: JoinHandle<()>,
    read_only: bool,
}

impl Drop for PostgresConnection {
    fn drop(&mut self) {
        self.task.abort();
    }
}

#[async_trait]
impl DbConnection for PostgresConnection {
    async fn execute(&mut self, sql: &str, cancel: CancellationToken) -> Result<ExecStream> {
        let client = self.client.clone();
        let sql = sql.to_owned();
        let mut notices = self.notices.subscribe();
        let read_only = self.read_only;
        let stream = async_stream::try_stream! {
            if cancel.is_cancelled() { Err(CoreError::Cancelled)?; }
            // Reapply this default so a read can never carry a relaxed setting
            // forward into the next query on a read-only profile.
            if read_only {
                client.batch_execute("SET default_transaction_read_only = on").await.map_err(query_error)?;
            }
            let prepared = match client.prepare(&sql).await {
                Ok(statement) => Some(values::columns(&client, statement.columns()).await.map_err(query_error)?),
                Err(error) if error.code().is_some_and(|code| code.code() != "42601"
                    && code.code() != "57014" && code.code() != "25P02") => None,
                Err(error) => Err(error_at(error, &sql))?,
            };
            if cancel.is_cancelled() { Err(CoreError::Cancelled)?; }
            let rows = client.simple_query_raw(&sql).await.map_err(|error| error_at(error, &sql))?;
            let mut rows = std::pin::pin!(rows);
            let mut columns = Vec::new();
            let mut started = false;
            while let Some(item) = rows.next().await {
                for event in drain_notices(&mut notices) {
                    yield event;
                }
                match item.map_err(|error| error_at(error, &sql))? {
                    SimpleQueryMessage::RowDescription(description) => {
                        columns = values::describe(&description, prepared.as_deref());
                        started = true;
                        yield ExecEvent::ResultStart(columns.clone());
                    }
                    SimpleQueryMessage::Row(row) => {
                        let mut cells = Vec::with_capacity(row.len());
                        for (index, column) in columns.iter().enumerate() {
                            let value = row.try_get(index).map_err(query_error)?;
                            cells.push(values::decode(value, column.kind));
                        }
                        yield ExecEvent::Row(cells);
                    }
                    SimpleQueryMessage::CommandComplete(rows) => {
                        yield ExecEvent::Affected(rows);
                        if started {
                            yield ExecEvent::ResultEnd;
                            started = false;
                        }
                    }
                    _ => {}
                }
            }
            for event in drain_notices(&mut notices) {
                yield event;
            }
        };
        Ok(Box::pin(stream))
    }

    fn cancel_handle(&self) -> CancelHandle {
        let token = self.client.cancel_token();
        let tls = self.tls.clone();
        Arc::new(move || {
            let token = token.clone();
            let tls = tls.clone();
            Box::pin(async move { token.cancel_query(tls).await.map_err(connection_error) })
        })
    }

    async fn set_read_only(&mut self, on: bool) -> Result<()> {
        self.client
            .batch_execute(if on {
                "SET default_transaction_read_only = on"
            } else {
                "SET default_transaction_read_only = off"
            })
            .await
            .map_err(query_error)?;
        self.read_only = on;
        Ok(())
    }

    async fn set_statement_timeout(&mut self, milliseconds: u32) -> Result<()> {
        self.client
            .query_one(
                "SELECT set_config('statement_timeout', $1, false)",
                &[&milliseconds.to_string()],
            )
            .await
            .map(|_| ())
            .map_err(query_error)
    }

    async fn begin(&mut self) -> Result<()> {
        self.client
            .batch_execute("BEGIN")
            .await
            .map_err(query_error)
    }
    async fn commit(&mut self) -> Result<()> {
        self.client
            .batch_execute("COMMIT")
            .await
            .map_err(query_error)
    }
    async fn rollback(&mut self) -> Result<()> {
        self.client
            .batch_execute("ROLLBACK")
            .await
            .map_err(query_error)
    }
    async fn ping(&mut self) -> Result<()> {
        self.client.check_connection().await.map_err(query_error)
    }
    fn is_closed(&self) -> bool {
        self.client.is_closed()
    }

    async fn server_info(&mut self) -> Result<ServerInfo> {
        let row = self.client.query_one(
            "SELECT version(), current_database()::text, current_schema()::text, current_user::text", &[]
        ).await.map_err(query_error)?;
        Ok(ServerInfo {
            version: row.try_get(0).map_err(query_error)?,
            database: row.try_get(1).map_err(query_error)?,
            schema: row.try_get(2).map_err(query_error)?,
            user: row.try_get(3).map_err(query_error)?,
        })
    }
}

fn drain_notices(receiver: &mut broadcast::Receiver<(String, String)>) -> Vec<ExecEvent> {
    let mut events = Vec::new();
    // Bound the work even if the server is issuing notices continuously.
    for _ in 0..128 {
        match receiver.try_recv() {
            Ok((level, text)) => events.push(ExecEvent::Message { level, text }),
            Err(broadcast::error::TryRecvError::Lagged(count)) => events.push(ExecEvent::Message {
                level: "WARNING".into(),
                text: format!("{count} PostgreSQL notices were dropped"),
            }),
            Err(_) => break,
        }
    }
    events
}

fn connection_error(error: tokio_postgres::Error) -> CoreError {
    use std::error::Error;
    if error
        .code()
        .is_some_and(|code| code.code().starts_with("28"))
    {
        return CoreError::Auth;
    }
    let mut cause: &dyn Error = &error;
    loop {
        if cause
            .downcast_ref::<std::io::Error>()
            .is_some_and(|io| io.kind() == std::io::ErrorKind::TimedOut)
        {
            return CoreError::Timeout;
        }
        if cause.is::<rustls::Error>() || cause.to_string().contains("TLS") {
            return CoreError::Tls {
                message: "PostgreSQL TLS negotiation or verification failed".into(),
            };
        }
        let Some(next) = cause.source() else { break };
        cause = next;
    }
    CoreError::Connect {
        message: "Could not reach the PostgreSQL server or open the requested database".into(),
    }
}

pub(crate) fn query_error(error: tokio_postgres::Error) -> CoreError {
    error_at(error, "")
}

fn error_at(error: tokio_postgres::Error, sql: &str) -> CoreError {
    if let Some(db) = error.as_db_error() {
        if db.code().code() == "57014" {
            return if db.message().contains("statement timeout") {
                CoreError::Timeout
            } else {
                CoreError::Cancelled
            };
        }
        let position = match db.position() {
            Some(tokio_postgres::error::ErrorPosition::Original(offset)) if !sql.is_empty() => {
                let count = offset.saturating_sub(1) as usize;
                Some(
                    sql.chars()
                        .take(count)
                        .map(|ch| ch.len_utf16() as u32)
                        .sum(),
                )
            }
            _ => None,
        };
        return CoreError::Db {
            code: db.code().code().into(),
            message: db.message().into(),
            detail: db.detail().map(str::to_owned),
            hint: db.hint().map(str::to_owned),
            position,
            line: None,
        };
    }
    connection_error(error)
}
