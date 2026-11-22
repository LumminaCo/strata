//! SQL Server sessions over TDS with Rustls transport.

mod catalog;
mod values;

use std::{
    future::pending,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use async_trait::async_trait;
use futures_util::TryStreamExt;
use strata_core::{
    CancelHandle, CoreError, DbConnection, DbKind, Driver, ExecEvent, ExecStream, Introspector,
    Profile, Result, Secret, ServerInfo,
};
use tiberius::{AuthMethod, Client, Config, EncryptionLevel, QueryItem, SqlBrowser, error::Error};
use tokio::{net::TcpStream, sync::Mutex, time::Instant};
use tokio_util::{
    compat::{Compat, TokioAsyncWriteCompatExt},
    sync::CancellationToken,
};

pub struct SqlServer;
type TdsClient = Client<Compat<TcpStream>>;

#[async_trait]
impl Driver for SqlServer {
    fn kind(&self) -> DbKind {
        DbKind::SqlServer
    }

    async fn connect(&self, profile: &Profile, secret: &Secret) -> Result<Box<dyn DbConnection>> {
        let configuration = config(profile, secret)?;
        let client = open(&configuration).await?;
        Ok(Box::new(Connection {
            client: Arc::new(Mutex::new(Some(client))),
            config: Arc::new(configuration),
            reset: Arc::default(),
            deadline: None,
        }))
    }

    async fn introspector(
        &self,
        profile: &Profile,
        secret: &Secret,
    ) -> Result<Box<dyn Introspector>> {
        let config = config(profile, secret)?;
        let client = open(&config).await?;
        Ok(Box::new(catalog::Catalog {
            config,
            client: Mutex::new(Some(client)),
        }))
    }
}

fn config(profile: &Profile, secret: &Secret) -> Result<Config> {
    let mut config = Config::new();
    config.host(&profile.host);
    config.port(profile.port);
    config.database(&profile.database);
    config.application_name("Strata");
    if let Some(instance) = &profile.options.instance {
        config.instance_name(instance);
    }
    let encryption = match profile.options.encryption.as_deref() {
        Some("off") => EncryptionLevel::Off,
        Some("strict") => EncryptionLevel::Strict,
        Some("on") | None if profile.options.encrypt != Some(false) => EncryptionLevel::Required,
        Some("on") => EncryptionLevel::Required,
        None => EncryptionLevel::Off,
        Some(_) => return Err(CoreError::config("Unknown SQL Server encryption mode")),
    };
    config.encryption(encryption);
    if profile.options.trust_server_cert == Some(true) && encryption != EncryptionLevel::Strict {
        config.trust_cert();
    }
    if profile.options.auth.as_deref() == Some("windows") {
        #[cfg(target_os = "windows")]
        config.authentication(AuthMethod::Integrated);
        #[cfg(not(target_os = "windows"))]
        return Err(CoreError::config(
            "Windows integrated authentication needs the native Windows application",
        ));
    } else {
        config.authentication(AuthMethod::sql_server(&profile.user, secret.expose()));
    }
    Ok(config)
}

async fn open(config: &Config) -> Result<TdsClient> {
    tokio::time::timeout(Duration::from_secs(10), async {
        let tcp = TcpStream::connect_named(config)
            .await
            .map_err(connection_error)?;
        tcp.set_nodelay(true).map_err(|_| CoreError::Connect {
            message: "Could not configure SQL Server socket".into(),
        })?;
        Client::connect(config.clone(), tcp.compat_write())
            .await
            .map_err(connection_error)
    })
    .await
    .map_err(|_| CoreError::Timeout)?
}

struct Connection {
    client: Arc<Mutex<Option<TdsClient>>>,
    config: Arc<Config>,
    reset: Arc<AtomicBool>,
    deadline: Option<Duration>,
}

impl Connection {
    async fn command(&mut self, sql: &str) -> Result<()> {
        let mut client = self.client.lock().await;
        ensure_client(&mut client, &self.config)
            .await?
            .simple_query(sql)
            .await
            .map_err(query_error)?
            .into_results()
            .await
            .map_err(query_error)?;
        Ok(())
    }
}

#[async_trait]
impl DbConnection for Connection {
    async fn execute(&mut self, sql: &str, cancel: CancellationToken) -> Result<ExecStream> {
        let client = self.client.clone();
        let config = self.config.clone();
        let reset = self.reset.clone();
        let sql = sql.to_owned();
        let deadline = self.deadline;
        let output = async_stream::try_stream! {
            let mut guard = client.lock().await;
            let client = ensure_client(&mut guard, &config).await?;
            if reset.swap(false, Ordering::AcqRel) {
                yield ExecEvent::Message { level: "warning".into(), text: "SQL Server session state was reset after cancellation.".into() };
            }
            let timeout = async {
                if let Some(duration) = deadline {
                    tokio::time::sleep_until(Instant::now() + duration).await;
                } else {
                    pending::<()>().await;
                }
            };
            tokio::pin!(timeout);
            if strata_sql::sql_server_dml_without_output(&sql) {
                let result = tokio::select! {
                    biased;
                    _ = cancel.cancelled() => Err(CoreError::Cancelled),
                    _ = &mut timeout => Err(CoreError::Timeout),
                    result = client.execute(&sql, &[]) => result.map_err(query_error),
                };
                match result {
                    Ok(result) => yield ExecEvent::Affected(result.total()),
                    Err(reason @ (CoreError::Cancelled | CoreError::Timeout)) => {
                        if !matches!(tokio::time::timeout(Duration::from_millis(1500), client.cancel_query()).await, Ok(Ok(()))) {
                            guard.take();
                            reset.store(true, Ordering::Release);
                        }
                        Err(reason)?;
                    }
                    Err(error) => Err(error)?,
                }
                return;
            }
            let interrupted = {
                let initial = tokio::select! {
                    biased;
                    _ = cancel.cancelled() => Err(CoreError::Cancelled),
                    _ = &mut timeout => Err(CoreError::Timeout),
                    result = client.simple_query(&sql) => result.map_err(query_error),
                };
                match initial {
                    Ok(mut stream) => {
                        let mut started = false;
                        loop {
                            let next = tokio::select! {
                                biased;
                                _ = cancel.cancelled() => break Some(CoreError::Cancelled),
                                _ = &mut timeout => break Some(CoreError::Timeout),
                                result = stream.try_next() => result,
                            };
                            match next {
                                Ok(Some(QueryItem::Metadata(meta))) => {
                                    if started { yield ExecEvent::ResultEnd; }
                                    started = true;
                                    yield ExecEvent::ResultStart(meta.columns().iter().map(values::column).collect());
                                }
                                Ok(Some(QueryItem::Row(row))) => yield ExecEvent::Row(values::row(&row)?),
                                Ok(None) => {
                                    if started { yield ExecEvent::ResultEnd; }
                                    break None;
                                }
                                Err(error) => Err(query_error(error))?,
                            }
                        }
                    }
                    Err(CoreError::Cancelled) => Some(CoreError::Cancelled),
                    Err(CoreError::Timeout) => Some(CoreError::Timeout),
                    Err(error) => { Err(error)?; None }
                }
            };
            if let Some(reason) = interrupted {
                match tokio::time::timeout(Duration::from_millis(1500), client.cancel_query()).await {
                    Ok(Ok(())) => {}
                    _ => {
                        guard.take();
                        reset.store(true, Ordering::Release);
                    }
                }
                Err(reason)?;
            }
        };
        Ok(Box::pin(output))
    }

    // The stream owns the TDS connection until it observes the cancellation token.
    fn cancel_handle(&self) -> CancelHandle {
        Arc::new(|| Box::pin(async { Ok(()) }))
    }

    async fn set_read_only(&mut self, _on: bool) -> Result<()> {
        Ok(())
    }
    async fn set_statement_timeout(&mut self, ms: u32) -> Result<()> {
        self.deadline = (ms > 0).then(|| Duration::from_millis(ms.into()));
        Ok(())
    }
    async fn begin(&mut self) -> Result<()> {
        self.command("SET XACT_ABORT ON; BEGIN TRANSACTION").await
    }
    async fn commit(&mut self) -> Result<()> {
        self.command("COMMIT TRANSACTION").await
    }
    async fn rollback(&mut self) -> Result<()> {
        self.command("IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION")
            .await
    }

    async fn server_info(&mut self) -> Result<ServerInfo> {
        let mut client = self.client.lock().await;
        let row = ensure_client(&mut client, &self.config).await?.simple_query("SELECT CONVERT(nvarchar(128), SERVERPROPERTY('ProductVersion')), DB_NAME(), SCHEMA_NAME(), USER_NAME()")
            .await.map_err(query_error)?.into_row().await.map_err(query_error)?
            .ok_or_else(|| CoreError::config("SQL Server did not return session information"))?;
        Ok(ServerInfo {
            version: format!("SQL Server {}", values::text(&row, 0)?),
            database: values::text(&row, 1)?,
            schema: row
                .try_get::<&str, _>(2)
                .map_err(query_error)?
                .map(str::to_owned),
            user: values::text(&row, 3)?,
        })
    }

    async fn set_explain(&mut self, enabled: bool) -> Result<()> {
        self.command(if enabled {
            "SET SHOWPLAN_TEXT ON"
        } else {
            "SET SHOWPLAN_TEXT OFF"
        })
        .await
    }

    async fn ping(&mut self) -> Result<()> {
        self.command("SELECT 1").await
    }
    fn is_closed(&self) -> bool {
        false
    }
}

async fn ensure_client<'a>(
    client: &'a mut Option<TdsClient>,
    config: &Config,
) -> Result<&'a mut TdsClient> {
    if client.is_none() {
        *client = Some(open(config).await?);
    }
    client
        .as_mut()
        .ok_or_else(|| CoreError::config("SQL Server session is unavailable"))
}

fn connection_error(error: Error) -> CoreError {
    match error {
        Error::Server(ref token) if token.code() == 18456 => CoreError::Auth,
        Error::Tls(_) => CoreError::Tls {
            message: "The SQL Server TLS handshake failed".into(),
        },
        _ => CoreError::Connect {
            message: "Could not open the SQL Server connection".into(),
        },
    }
}

fn query_error(error: Error) -> CoreError {
    match error {
        Error::Server(token) => CoreError::Db {
            code: token.code().to_string(),
            message: token.message().to_owned(),
            detail: None,
            hint: None,
            position: None,
            line: Some(token.line()),
        },
        Error::Io { .. } => CoreError::Connect {
            message: "The SQL Server connection was lost".into(),
        },
        _ => CoreError::Db {
            code: "TDS".into(),
            message: "Could not process the SQL Server response".into(),
            detail: None,
            hint: None,
            position: None,
            line: None,
        },
    }
}
