//! Commands shared by the desktop and browser development transports.

pub mod cli;
mod inspection;
mod protocol;
mod query;

use std::{collections::HashMap, sync::Arc, time::Instant};

use percent_encoding::percent_decode_str;
use serde::Serialize;
use serde_json::Value;
use strata_core::{
    AgentAccess, CoreError, DbKind, Environment, Profile, Result, Secret, Tls, TlsMode,
};
use strata_store::{Keychain, Paths};
use tokio::sync::{Mutex, RwLock};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

pub use cli::CliStatus;
pub use inspection::{ObjectDetails, ResolvedObject};
pub use protocol::*;
pub use strata_engine::{CatalogScope, CatalogSnapshot, Engine, Metadata, WireCell};

pub struct AppService {
    engine: Engine,
    sessions: RwLock<HashMap<Uuid, Arc<Session>>>,
    profile_edit: Mutex<()>,
    metadata: Metadata,
    keychain: bool,
}

struct Session {
    kind: DbKind,
    connection_id: Uuid,
    database: RwLock<String>,
    schema: RwLock<Option<String>>,
    password: Option<Secret>,
    production: bool,
    lifetime: CancellationToken,
    control: Mutex<RunControl>,
}

#[derive(Default)]
struct RunControl {
    active: Option<(Uuid, CancellationToken)>,
    cancelled: Option<Uuid>,
}

#[derive(Serialize)]
pub struct Health {
    pub version: &'static str,
}

impl AppService {
    pub fn open(keychain: bool) -> Result<Self> {
        Self::at(Paths::discover()?, keychain)
    }

    pub fn at(paths: Paths, keychain: bool) -> Result<Self> {
        Ok(Self {
            engine: Engine::open(paths)?,
            sessions: RwLock::default(),
            profile_edit: Mutex::default(),
            metadata: Metadata::default(),
            keychain,
        })
    }

    pub fn health(&self) -> Health {
        Health {
            version: env!("CARGO_PKG_VERSION"),
        }
    }

    pub async fn has_open_transactions(&self) -> std::result::Result<bool, ErrorDto> {
        let sessions = self.sessions.read().await;
        for &id in sessions.keys() {
            if self.engine.core().transaction_open(id).await? {
                return Ok(true);
            }
        }
        Ok(false)
    }

    pub async fn dispatch(
        &self,
        command: Command,
        lifetime: CancellationToken,
    ) -> std::result::Result<Value, ErrorDto> {
        self.execute(command, lifetime).await.map_err(Into::into)
    }

    async fn execute(&self, command: Command, lifetime: CancellationToken) -> Result<Value> {
        match command {
            Command::ListConnections => json(
                self.engine
                    .config()
                    .connections
                    .into_iter()
                    .map(Connection::from)
                    .collect::<Vec<_>>(),
            ),
            Command::SaveConnection { profile, password } => {
                let connection = self.save_connection(profile, password).await?;
                if let Some(id) = connection.id {
                    self.metadata.invalidate(&self.engine, id).await?;
                }
                json(connection)
            }
            Command::DeleteConnection { id } => {
                self.delete_connection(id).await?;
                self.metadata.invalidate(&self.engine, id).await?;
                Ok(Value::Null)
            }
            Command::TestConnection { profile, password } => {
                let profile = self.candidate(profile)?;
                let password = if profile.secret == "keychain" {
                    password.filter(|value| !value.is_empty())
                } else {
                    password
                };
                let started = Instant::now();
                let id = self
                    .engine
                    .open_profile(profile, password.map(Secret::new))
                    .await?;
                let info = self.session_info(id, started).await;
                self.engine.core().close_session(id).await?;
                json(info?)
            }
            Command::ParseConnectionUrl { url } => json(parse_url(&url)?),
            Command::OpenSession {
                connection_id,
                database,
                schema,
                password,
            } => {
                let mut profile = self.engine.profile(connection_id)?;
                if let Some(database) = database {
                    profile.database = database;
                }
                self.open_session(profile, schema, password, lifetime)
                    .await
                    .and_then(json)
            }
            Command::CloseSession { session_id } => {
                self.close_session(session_id).await?;
                Ok(Value::Null)
            }
            Command::Stop { session_id, run_id } => {
                self.stop(session_id, run_id).await?;
                Ok(Value::Null)
            }
            Command::FetchMore {
                session_id,
                cursor_id,
                count,
            } => {
                let session = self.session(session_id).await?;
                let control = session.control.lock().await;
                if control.active.is_some() {
                    return Err(CoreError::config(
                        "Wait for the script to finish before fetching more",
                    ));
                }
                // A separate Stop command can cancel the active core cursor.
                drop(control);
                json(Page::from(
                    self.engine
                        .core()
                        .fetch_more(session_id, cursor_id, count.clamp(1, 500))
                        .await?,
                ))
            }
            Command::SetDbmsOutput {
                session_id,
                enabled,
            } => {
                self.engine
                    .core()
                    .set_dbms_output(session_id, enabled)
                    .await?;
                Ok(Value::Null)
            }
            Command::SetSchema { session_id, schema } => {
                let session = self.session(session_id).await?;
                let control = session.control.lock().await;
                if control.active.is_some() {
                    return Err(CoreError::config("Wait for the running query to finish"));
                }
                let applied = self.engine.core().set_schema(session_id, &schema).await?;
                *session.schema.write().await = applied.clone().or(Some(schema));
                json(applied)
            }
            Command::NextResult {
                session_id,
                cursor_id,
                count,
            } => {
                let mut batch = self
                    .engine
                    .core()
                    .next_result(session_id, cursor_id, count.clamp(1, 500), None)
                    .await?;
                json(NextResult {
                    cursor_id: batch.cursor,
                    columns: std::mem::take(&mut batch.columns),
                    page: batch.into(),
                })
            }
            Command::GetCell {
                session_id,
                cursor_id,
                row,
                column,
            } => json(WireCell::from(
                self.engine
                    .core()
                    .get_cell(session_id, cursor_id, row, column)
                    .await?,
            )),
            Command::DropResult {
                session_id,
                cursor_id,
            } => {
                let session = self.session(session_id).await?;
                let control = session.control.lock().await;
                if control.active.is_some() {
                    return Err(CoreError::config("Wait for the running query to finish"));
                }
                drop(control);
                self.engine
                    .core()
                    .drop_result(session_id, cursor_id)
                    .await?;
                Ok(Value::Null)
            }
            Command::PlanQuery {
                kind,
                text,
                target,
                mode,
                production,
            } => {
                let plan = query::plan(
                    &text,
                    target,
                    mode,
                    self.engine.config().settings.blank_line_delimiter,
                    production && self.engine.config().settings.confirm_production,
                    inspection::dialect(kind.unwrap_or(DbKind::Postgres)),
                )?;
                json(QueryPlan {
                    statements: plan
                        .spans
                        .iter()
                        .map(|span| [span.start, span.end])
                        .collect(),
                    confirmation: plan.confirmation,
                })
            }
            Command::ListDatabases { scope } => json(
                self.metadata
                    .catalog(&self.engine, &scope)
                    .await?
                    .databases()
                    .await?,
            ),
            Command::ListSchemas { scope } => json(
                self.metadata
                    .catalog(&self.engine, &scope)
                    .await?
                    .schemas(self.engine.config().settings.show_system_objects)
                    .await?,
            ),
            Command::CatalogSnapshot { scope, schema } => json(
                self.metadata
                    .snapshot(&self.engine, &scope, schema)
                    .await?
                    .as_ref(),
            ),
            Command::CatalogCounts { scope, schema } => json(
                self.metadata
                    .object_counts(&self.engine, &scope, schema)
                    .await?
                    .as_ref(),
            ),
            Command::CatalogObjects {
                scope,
                schema,
                kinds,
                search,
                offset,
                limit,
            } => json(
                self.metadata
                    .objects_page(
                        &self.engine,
                        &scope,
                        &schema,
                        &kinds,
                        search.as_deref(),
                        offset,
                        limit
                            .unwrap_or(strata_engine::TABLE_PAGE_SIZE)
                            .clamp(1, 500),
                    )
                    .await?,
            ),
            Command::RefreshMetadata { connection_id } => {
                self.metadata
                    .invalidate(&self.engine, connection_id)
                    .await?;
                Ok(Value::Null)
            }
            Command::HistoryList {
                connection_id,
                limit,
            } => json(
                self.engine
                    .history(connection_id, limit.unwrap_or(100).clamp(1, 1_000))
                    .await?
                    .into_iter()
                    .map(HistoryItem::from)
                    .collect::<Vec<_>>(),
            ),
            Command::ResolveAt {
                scope,
                session_id,
                schema,
                text,
                offset,
            } => json(
                self.resolve_at(&scope, session_id, schema.as_deref(), &text, offset)
                    .await?,
            ),
            Command::ObjectDetails { scope, object } => {
                json(self.object_details(&scope, &object).await?)
            }
            Command::ResolveObject { scope, reference } => {
                let dialect = inspection::dialect(self.engine.profile(scope.connection_id)?.kind);
                let object = self
                    .metadata
                    .catalog(&self.engine, &scope)
                    .await?
                    .resolve(&inspection::qualified(
                        &[reference.schema, reference.name],
                        dialect,
                    ))
                    .await?;
                json(object)
            }
            Command::OpenInspectionSession { scope } => {
                let mut profile = self.engine.profile(scope.connection_id)?;
                profile.read_only = true;
                if let Some(database) = scope.database {
                    profile.database = database;
                }
                json(
                    self.open_session(profile, None, scope.password, lifetime)
                        .await?,
                )
            }
            Command::SettingsGet => json(self.engine.config().settings),
            Command::SettingsSave { settings } => {
                self.engine.save_settings(settings).await?;
                Ok(Value::Null)
            }
            Command::SetTransactionMode { session_id, manual } => {
                let session = self.session(session_id).await?;
                let control = session.control.lock().await;
                if control.active.is_some() {
                    return Err(CoreError::config("Wait for the running query to finish"));
                }
                self.engine
                    .core()
                    .set_manual_transactions(session_id, manual)
                    .await?;
                let (manual, open) = self.engine.core().transaction_state(session_id).await?;
                json(TransactionState { manual, open })
            }
            Command::FinishTransaction { session_id, commit } => {
                let session = self.session(session_id).await?;
                let control = session.control.lock().await;
                if control.active.is_some() {
                    return Err(CoreError::config("Wait for the running query to finish"));
                }
                if commit {
                    self.engine.core().commit(session_id).await?;
                } else {
                    self.engine.core().rollback(session_id).await?;
                }
                let (manual, open) = self.engine.core().transaction_state(session_id).await?;
                json(TransactionState { manual, open })
            }
            Command::AuditList { limit } => json(self.engine.audit(limit.unwrap_or(200)).await?),
            Command::CliStatus => {
                if !self.keychain {
                    return Err(CoreError::config(
                        "Open the native app to check the Strata CLI status",
                    ));
                }
                tokio::task::spawn_blocking(cli::cli_status)
                    .await
                    .map_err(join_error)
                    .and_then(json)
            }
            Command::InstallCli => {
                if !self.keychain {
                    return Err(CoreError::config(
                        "Open the native app to install the Strata CLI",
                    ));
                }
                tokio::task::spawn_blocking(cli::install_cli)
                    .await
                    .map_err(join_error)?
                    .and_then(json)
            }
            Command::McpConfig => {
                if !self.keychain {
                    return Err(CoreError::config(
                        "Open the native app to copy the MCP configuration",
                    ));
                }
                tokio::task::spawn_blocking(cli::mcp_config)
                    .await
                    .map_err(join_error)?
            }
            Command::WorkspaceLoad => json(self.load_workspace().await?),
            Command::WorkspaceBootstrap => {
                let config = self.engine.config();
                json(protocol::WorkspaceBootstrap {
                    connections: config
                        .connections
                        .into_iter()
                        .map(Connection::from)
                        .collect(),
                    workspace: self.load_workspace().await?,
                    settings: config.settings,
                })
            }
            Command::WorkspaceSave { workspace } => {
                let content = serde_json::to_string(&workspace)
                    .map_err(|_| CoreError::config("Cannot encode workspace"))?;
                if workspace.tabs.len() > 100 || content.len() > 8_000_000 {
                    return Err(CoreError::config(
                        "Workspace exceeds 100 tabs or 8 MB of SQL",
                    ));
                }
                self.engine.save_workspace(content).await?;
                Ok(Value::Null)
            }
        }
    }

    async fn load_workspace(&self) -> Result<Workspace> {
        match self.engine.workspace().await? {
            Some(value) => decode(&value),
            None => Ok(Workspace::default()),
        }
    }

    fn candidate(&self, input: Connection) -> Result<Profile> {
        if input.secret == "keychain" && !self.keychain {
            return Err(CoreError::config(
                "Use a password prompt or environment variable in browser mode",
            ));
        }
        let previous = input.id.map(|id| self.engine.profile(id)).transpose()?;
        let mut profile = previous.unwrap_or_else(|| Profile {
            id: Uuid::now_v7(),
            name: String::new(),
            kind: input.kind,
            env: Environment::Dev,
            color: None,
            folder: None,
            host: String::new(),
            port: 5432,
            database: String::new(),
            user: String::new(),
            secret: "prompt".into(),
            read_only: false,
            agent_access: AgentAccess::None,
            allow_agent_ddl: false,
            tls: Tls::default(),
            options: Default::default(),
        });
        profile.name = input.name.trim().into();
        profile.kind = input.kind;
        if let Some(options) = input.options {
            profile.options = options;
        }
        profile.env = input.env;
        profile.color = input.color.filter(|value| !value.is_empty());
        profile.folder = input
            .folder
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty());
        profile.host = input.host.trim().into();
        profile.port = input.port;
        profile.database = input.database;
        profile.user = input.user;
        profile.secret = input.secret;
        profile.read_only = input.read_only;
        profile.agent_access = input.agent_access;
        profile.allow_agent_ddl = input.allow_agent_ddl;
        profile.tls.mode = input.tls;
        profile.validate()?;
        Ok(profile)
    }

    async fn save_connection(
        &self,
        input: Connection,
        password: Option<String>,
    ) -> Result<Connection> {
        let _edit = self.profile_edit.lock().await;
        let previous = input.id.map(|id| self.engine.profile(id)).transpose()?;
        let profile = self.candidate(input)?;
        let store = self.engine.config_store();
        let keychain = self.keychain;
        let password = password.filter(|value| !value.is_empty());
        tokio::task::spawn_blocking(move || {
            if store
                .load()?
                .connections
                .iter()
                .any(|existing| existing.id != profile.id && existing.name == profile.name)
            {
                return Err(CoreError::config("A connection already uses this name"));
            }
            let new_credential = profile.secret == "keychain"
                && previous.as_ref().is_none_or(|old| old.secret != "keychain");
            let mut wrote_credential = false;
            if profile.secret == "keychain" {
                if let Some(password) = password {
                    Keychain::save(&profile, &Secret::new(password))?;
                    wrote_credential = true;
                } else if new_credential {
                    return Err(CoreError::config(
                        "Enter the password to store in the OS keychain",
                    ));
                }
            }
            if let Err(error) = store.save_profile(&profile) {
                if new_credential && wrote_credential {
                    let _ = Keychain::delete(&profile);
                }
                return Err(error);
            }
            if keychain
                && let Some(previous) =
                    previous.filter(|old| old.secret == "keychain" && profile.secret != "keychain")
            {
                Keychain::delete(&previous)?;
            }
            Ok(Connection::from(profile))
        })
        .await
        .map_err(join_error)?
    }

    async fn delete_connection(&self, id: Uuid) -> Result<()> {
        let _edit = self.profile_edit.lock().await;
        let profile = self.engine.profile(id)?;
        let store = self.engine.config_store();
        let keychain = self.keychain;
        tokio::task::spawn_blocking(move || {
            if profile.secret == "keychain" && keychain {
                Keychain::delete(&profile)?;
            }
            store.delete_profile(&id.to_string())
        })
        .await
        .map_err(join_error)?
    }

    async fn open_session(
        &self,
        profile: Profile,
        schema: Option<String>,
        password: Option<String>,
        lifetime: CancellationToken,
    ) -> Result<SessionInfo> {
        if lifetime.is_cancelled() {
            return Err(CoreError::Cancelled);
        }
        let connection_id = profile.id;
        let kind = profile.kind;
        let production = profile.env == Environment::Prod;
        let started = Instant::now();
        let stored_password = password.clone().map(Secret::new);
        let id = self
            .engine
            .open_profile(profile, password.map(Secret::new))
            .await?;
        if let Some(schema) = schema
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            && let Err(error) = self.engine.core().set_schema(id, schema).await
        {
            let _ = self.engine.core().close_session(id).await;
            return Err(error);
        }
        let info = self.session_info(id, started).await;
        let mut sessions = self.sessions.write().await;
        if info.is_err() || lifetime.is_cancelled() {
            drop(sessions);
            self.engine.core().close_session(id).await?;
            return info.and(Err(CoreError::Cancelled));
        }
        let (session_database, session_schema) = match &info {
            Ok(session_info) => (session_info.database.clone(), session_info.schema.clone()),
            Err(_) => unreachable!(),
        };
        sessions.insert(
            id,
            Arc::new(Session {
                kind,
                connection_id,
                database: RwLock::new(session_database),
                schema: RwLock::new(session_schema),
                password: stored_password,
                production,
                lifetime,
                control: Mutex::default(),
            }),
        );
        info
    }

    async fn session_info(&self, id: Uuid, started: Instant) -> Result<SessionInfo> {
        let server = self.engine.core().server_info(id).await?;
        Ok(SessionInfo {
            id,
            version: server.version,
            database: server.database,
            schema: server.schema,
            elapsed_ms: elapsed_ms(started),
        })
    }

    async fn session(&self, id: Uuid) -> Result<Arc<Session>> {
        self.sessions
            .read()
            .await
            .get(&id)
            .cloned()
            .ok_or_else(|| CoreError::config("Session does not exist"))
    }

    async fn close_session(&self, id: Uuid) -> Result<()> {
        let Some(session) = self.sessions.write().await.remove(&id) else {
            return Ok(());
        };
        if let Some((_, run)) = session.control.lock().await.active.as_ref() {
            run.cancel();
        }
        self.engine.core().close_session(id).await
    }

    pub async fn close_disconnected_sessions(&self) {
        let ids: Vec<_> = self
            .sessions
            .read()
            .await
            .iter()
            .filter(|(_, session)| session.lifetime.is_cancelled())
            .map(|(&id, _)| id)
            .collect();
        for id in ids {
            let _ = self.close_session(id).await;
        }
    }

    async fn stop(&self, id: Uuid, run_id: Option<Uuid>) -> Result<()> {
        let session = self.session(id).await?;
        let mut control = session.control.lock().await;
        if let Some(run_id) = run_id {
            control.cancelled = Some(run_id);
        }
        if let Some((active_id, run)) = &control.active {
            if run_id.is_some_and(|id| id != *active_id) {
                return Ok(());
            }
            run.cancel();
        }
        self.engine.core().stop(id).await
    }
}

impl From<Profile> for Connection {
    fn from(profile: Profile) -> Self {
        Self {
            id: Some(profile.id),
            name: profile.name,
            kind: profile.kind,
            env: profile.env,
            color: profile.color,
            folder: profile.folder,
            host: profile.host,
            port: profile.port,
            database: profile.database,
            user: profile.user,
            secret: profile.secret,
            read_only: profile.read_only,
            agent_access: profile.agent_access,
            allow_agent_ddl: profile.allow_agent_ddl,
            tls: profile.tls.mode,
            options: Some(profile.options),
        }
    }
}

#[derive(Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct ParsedUrl {
    #[ts(type = "Connection['kind']")]
    kind: DbKind,
    options: Option<strata_core::DriverOptions>,
    host: String,
    port: u16,
    database: String,
    user: String,
    password: Option<String>,
    #[ts(type = "Connection['tls']")]
    tls: TlsMode,
}

fn parse_url(value: &str) -> Result<ParsedUrl> {
    let value = value.trim();
    if let Some(value) = value.strip_prefix("jdbc:sqlserver://") {
        return parse_sql_server_url(value);
    }
    if value.starts_with("oracle://")
        || value.starts_with("//")
        || value.starts_with("(DESCRIPTION")
        || (!value.contains("://") && value.contains('/'))
    {
        return parse_oracle_url(value);
    }
    let url = url::Url::parse(value.trim())
        .map_err(|_| CoreError::config("Enter a valid PostgreSQL URL"))?;
    if !matches!(url.scheme(), "postgres" | "postgresql") {
        return Err(CoreError::config(
            "Enter a postgres:// or postgresql:// URL",
        ));
    }
    let host = url
        .host_str()
        .ok_or_else(|| CoreError::config("The URL needs a host"))?;
    let decode = |text: &str| {
        percent_decode_str(text)
            .decode_utf8()
            .map(|value| value.into_owned())
            .map_err(|_| CoreError::config("The URL contains invalid UTF-8"))
    };
    let mut tls = TlsMode::Prefer;
    for (key, value) in url.query_pairs() {
        if key != "sslmode" {
            return Err(CoreError::config(
                "The URL contains an unsupported connection parameter",
            ));
        }
        tls = match value.as_ref() {
            "disable" => TlsMode::Disable,
            "prefer" => TlsMode::Prefer,
            "require" => TlsMode::Require,
            "verify-ca" => TlsMode::VerifyCa,
            "verify-full" => TlsMode::VerifyFull,
            _ => return Err(CoreError::config("The URL uses an unsupported sslmode")),
        };
    }
    Ok(ParsedUrl {
        kind: DbKind::Postgres,
        options: None,
        host: host.trim_matches(['[', ']']).into(),
        port: url.port().unwrap_or(5432),
        database: decode(url.path().trim_start_matches('/'))?,
        user: decode(url.username())?,
        password: url.password().map(decode).transpose()?,
        tls,
    })
}

fn parse_sql_server_url(value: &str) -> Result<ParsedUrl> {
    let (address, options) = value.split_once(';').unwrap_or((value, ""));
    let (address, instance) = address
        .split_once('\\')
        .map_or((address, None), |(host, instance)| {
            (host, Some(instance.to_owned()))
        });
    let url = url::Url::parse(&format!("tcp://{address}"))
        .map_err(|_| CoreError::config("Enter a valid SQL Server host and port"))?;
    let host = url
        .host_str()
        .ok_or_else(|| CoreError::config("The URL needs a host"))?;
    let mut parsed = ParsedUrl {
        kind: DbKind::SqlServer,
        options: None,
        host: host.trim_matches(['[', ']']).into(),
        port: url.port().unwrap_or(1433),
        database: "master".into(),
        user: String::new(),
        password: None,
        tls: TlsMode::Require,
    };
    let mut properties = strata_core::DriverOptions {
        instance,
        ..Default::default()
    };
    let mut rest = options;
    while !rest.trim().is_empty() {
        let (key, value) = rest
            .split_once('=')
            .ok_or_else(|| CoreError::config("Invalid SQL Server URL property"))?;
        let (value, next) = if let Some(braced) = value.strip_prefix('{') {
            let mut decoded = String::new();
            let mut chars = braced.char_indices().peekable();
            let end = loop {
                let Some((at, ch)) = chars.next() else {
                    return Err(CoreError::config("Unterminated SQL Server URL value"));
                };
                if ch == '}' {
                    if chars.next_if(|(_, next)| *next == '}').is_some() {
                        decoded.push('}');
                    } else {
                        break at + 1;
                    }
                } else {
                    decoded.push(ch);
                }
            };
            let next = &braced[end..];
            (
                decoded,
                if next.is_empty() {
                    next
                } else {
                    next.strip_prefix(';').ok_or_else(|| {
                        CoreError::config("Invalid SQL Server URL property separator")
                    })?
                },
            )
        } else {
            let (value, next) = value.split_once(';').unwrap_or((value, ""));
            (value.to_owned(), next)
        };
        rest = next;
        match key.trim().to_ascii_lowercase().as_str() {
            "databasename" | "database" => parsed.database = value,
            "user" | "username" => parsed.user = value,
            "password" => parsed.password = Some(value),
            "instancename" => properties.instance = Some(value),
            "encrypt" => {
                properties.encryption = Some(
                    match value.to_ascii_lowercase().as_str() {
                        "false" | "off" => "off",
                        "true" | "on" => "on",
                        "strict" => "strict",
                        _ => {
                            return Err(CoreError::config(
                                "Unsupported SQL Server encryption mode",
                            ));
                        }
                    }
                    .into(),
                )
            }
            "trustservercertificate" => {
                properties.trust_server_cert = Some(value.eq_ignore_ascii_case("true"))
            }
            "integratedsecurity" if value.eq_ignore_ascii_case("true") => {
                properties.auth = Some("windows".into())
            }
            "integratedsecurity" => {}
            _ => {
                return Err(CoreError::config(
                    "The URL contains an unsupported SQL Server property",
                ));
            }
        }
    }
    parsed.options = Some(properties);
    Ok(parsed)
}

fn parse_oracle_url(value: &str) -> Result<ParsedUrl> {
    if value.starts_with('(') {
        let host = descriptor_component(value, "HOST")
            .ok_or_else(|| CoreError::config("The Oracle descriptor needs a HOST"))?;
        let service = descriptor_component(value, "SERVICE_NAME");
        let sid = descriptor_component(value, "SID");
        let database = service.clone().or_else(|| sid.clone()).ok_or_else(|| {
            CoreError::config("The Oracle descriptor needs a SERVICE_NAME or SID")
        })?;
        return Ok(ParsedUrl {
            kind: DbKind::Oracle,
            host,
            database,
            user: String::new(),
            password: None,
            port: descriptor_component(value, "PORT")
                .and_then(|port| port.parse().ok())
                .unwrap_or(1521),
            tls: if descriptor_component(value, "PROTOCOL")
                .is_some_and(|protocol| protocol.eq_ignore_ascii_case("TCPS"))
            {
                TlsMode::Require
            } else {
                TlsMode::Prefer
            },
            options: Some(strata_core::DriverOptions {
                service_name: service,
                sid,
                descriptor: Some(value.into()),
                ..Default::default()
            }),
        });
    }
    let bare = value.strip_prefix("//").unwrap_or(value);
    let owned;
    let input = if bare.starts_with("oracle://") {
        bare
    } else {
        owned = format!("oracle://{bare}");
        &owned
    };
    let url = url::Url::parse(input)
        .map_err(|_| CoreError::config("Enter an Oracle EZConnect host and service"))?;
    let decode = |text: &str| percent_decode_str(text).decode_utf8_lossy().into_owned();
    let host = url
        .host_str()
        .ok_or_else(|| CoreError::config("The Oracle URL needs a host"))?;
    let database = decode(url.path().trim_start_matches('/'));
    if database.is_empty() || database.contains('/') {
        return Err(CoreError::config("The Oracle URL needs one service name"));
    }
    Ok(ParsedUrl {
        kind: DbKind::Oracle,
        host: host.trim_matches(['[', ']']).into(),
        port: url.port().unwrap_or(1521),
        database,
        user: decode(url.username()),
        password: url.password().map(decode),
        options: None,
        tls: TlsMode::Prefer,
    })
}

fn descriptor_component(value: &str, key: &str) -> Option<String> {
    let uppercase = value.to_ascii_uppercase();
    let marker = format!("({key}=");
    let start = uppercase.find(&marker)? + marker.len();
    let end = value[start..].find(')')? + start;
    Some(value[start..end].trim().into())
}

fn elapsed_ms(started: Instant) -> u32 {
    started.elapsed().as_millis().try_into().unwrap_or(u32::MAX)
}

fn json<T: Serialize>(value: T) -> Result<Value> {
    serde_json::to_value(value).map_err(|_| CoreError::config("Cannot encode response"))
}

fn decode<T: serde::de::DeserializeOwned>(value: &str) -> Result<T> {
    serde_json::from_str(value).map_err(|_| CoreError::config("Cannot read the saved workspace"))
}

fn join_error(_: tokio::task::JoinError) -> CoreError {
    CoreError::Io {
        message: "Local storage task failed".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_connection(secret: &str) -> Connection {
        Connection {
            id: None,
            name: "Local DB".into(),
            kind: DbKind::Postgres,
            env: Environment::Dev,
            color: None,
            folder: None,
            host: "127.0.0.1".into(),
            port: 5432,
            database: "postgres".into(),
            user: "postgres".into(),
            secret: secret.into(),
            read_only: false,
            agent_access: AgentAccess::None,
            allow_agent_ddl: false,
            options: None,
            tls: TlsMode::Prefer,
        }
    }

    #[tokio::test]
    async fn save_connection_requires_non_empty_password_for_new_keychain_profile() {
        let dir = tempfile::tempdir().expect("tempdir");
        let app = AppService::at(Paths::under(dir.path().into()), true).expect("open app");

        let error = app
            .dispatch(
                Command::SaveConnection {
                    profile: sample_connection("keychain"),
                    password: Some(String::new()),
                },
                CancellationToken::new(),
            )
            .await
            .expect_err("empty password must be rejected for new keychain profile");
        assert_eq!(error.kind, "config");
        assert!(error.message.contains("OS keychain"));
    }

    #[tokio::test]
    async fn save_connection_in_browser_mode_can_switch_existing_keychain_profile_to_prompt() {
        let dir = tempfile::tempdir().expect("tempdir");
        let paths = Paths::under(dir.path().into());
        let id = Uuid::now_v7();
        std::fs::write(
            &paths.config,
            format!(
                r#"
version = 1

[[connection]]
id = "{id}"
name = "Local DB"
kind = "postgres"
host = "127.0.0.1"
port = 5432
database = "postgres"
user = "postgres"
secret = "keychain"
"#
            ),
        )
        .expect("write config");

        let app = AppService::at(paths, false).expect("open app");
        let mut updated = sample_connection("prompt");
        updated.id = Some(id);
        let saved = app
            .dispatch(
                Command::SaveConnection {
                    profile: updated,
                    password: None,
                },
                CancellationToken::new(),
            )
            .await
            .expect("switch to prompt without touching OS keychain");
        assert_eq!(saved["secret"], "prompt");
    }
}
