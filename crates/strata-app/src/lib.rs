//! Commands shared by the desktop and browser development transports.

mod engine;
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

pub use engine::Engine;
pub use protocol::*;

pub struct AppService {
    engine: Engine,
    sessions: RwLock<HashMap<Uuid, Arc<Session>>>,
    profile_edit: Mutex<()>,
    keychain: bool,
}

struct Session {
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
            keychain,
        })
    }

    pub fn health(&self) -> Health {
        Health {
            version: env!("CARGO_PKG_VERSION"),
        }
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
                json(self.save_connection(profile, password).await?)
            }
            Command::DeleteConnection { id } => {
                self.delete_connection(id).await?;
                Ok(Value::Null)
            }
            Command::TestConnection { profile, password } => {
                let profile = self.candidate(profile)?;
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
                password,
            } => {
                let profile = self.engine.profile(connection_id)?;
                self.open_session(profile, password, lifetime)
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
            Command::PlanQuery {
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
                    production,
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
            Command::WorkspaceLoad => {
                let workspace = self.engine.workspace().await?;
                let saved: Workspace = match workspace {
                    Some(value) => decode(&value)?,
                    None => Workspace::default(),
                };
                json(saved)
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

    fn candidate(&self, input: Connection) -> Result<Profile> {
        if input.kind != DbKind::Postgres {
            return Err(CoreError::config("Only PostgreSQL is available"));
        }
        if input.secret == "keychain" && !self.keychain {
            return Err(CoreError::config(
                "Use a password prompt or environment variable in browser mode",
            ));
        }
        let previous = input.id.map(|id| self.engine.profile(id)).transpose()?;
        let mut profile = previous.unwrap_or_else(|| Profile {
            id: Uuid::now_v7(),
            name: String::new(),
            kind: DbKind::Postgres,
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
            if let Some(previous) =
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
        password: Option<String>,
        lifetime: CancellationToken,
    ) -> Result<SessionInfo> {
        if lifetime.is_cancelled() {
            return Err(CoreError::Cancelled);
        }
        let production = profile.env == Environment::Prod;
        let started = Instant::now();
        let id = self
            .engine
            .open_profile(profile, password.map(Secret::new))
            .await?;
        let info = self.session_info(id, started).await;
        let mut sessions = self.sessions.write().await;
        if info.is_err() || lifetime.is_cancelled() {
            drop(sessions);
            self.engine.core().close_session(id).await?;
            return info.and(Err(CoreError::Cancelled));
        }
        sessions.insert(
            id,
            Arc::new(Session {
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
            tls: profile.tls.mode,
        }
    }
}

#[derive(Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct ParsedUrl {
    host: String,
    port: u16,
    database: String,
    user: String,
    password: Option<String>,
    #[ts(type = "Connection['tls']")]
    tls: TlsMode,
}

fn parse_url(value: &str) -> Result<ParsedUrl> {
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
        host: host.trim_matches(['[', ']']).into(),
        port: url.port().unwrap_or(5432),
        database: decode(url.path().trim_start_matches('/'))?,
        user: decode(url.username())?,
        password: url.password().map(decode).transpose()?,
        tls,
    })
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
