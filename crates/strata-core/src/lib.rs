//! Database driver contracts and pull-based query sessions.

mod session;

use std::{future::Future, pin::Pin, sync::Arc};

use async_trait::async_trait;
use futures_util::Stream;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use ts_rs::TS;
use uuid::Uuid;
use zeroize::Zeroizing;

pub use session::{Batch, Core, Limits};

pub type Result<T> = std::result::Result<T, CoreError>;

#[derive(Debug, Error, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CoreError {
    #[error("Connection failed: {message}")]
    Connect { message: String },
    #[error("Authentication failed")]
    Auth,
    #[error("TLS failed: {message}")]
    Tls { message: String },
    #[error("The database operation timed out")]
    Timeout,
    #[error("The query was cancelled")]
    Cancelled,
    #[error("{message}")]
    Db {
        code: String,
        message: String,
        #[serde(skip)]
        detail: Option<String>,
        #[serde(skip)]
        hint: Option<String>,
        position: Option<u32>,
        line: Option<u32>,
    },
    #[error("This connection is read-only: {reason}")]
    ReadOnlyViolation { reason: String },
    #[error("Invalid configuration: {message}")]
    Config { message: String },
    #[error("Secret unavailable: {message}")]
    Secret { message: String },
    #[error("Storage error: {message}")]
    Io { message: String },
}

impl CoreError {
    pub fn config(message: impl Into<String>) -> Self {
        Self::Config {
            message: message.into(),
        }
    }
}

pub struct Secret(Zeroizing<String>);

impl Secret {
    pub fn new(value: String) -> Self {
        Self(Zeroizing::new(value))
    }

    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Debug for Secret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("[redacted]")
    }
}

impl std::fmt::Display for Secret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        std::fmt::Debug::fmt(self, f)
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DbKind {
    Postgres,
    SqlServer,
    Oracle,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Environment {
    #[default]
    Dev,
    Staging,
    Prod,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentAccess {
    #[default]
    None,
    Read,
    Write,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum TlsMode {
    Disable,
    #[default]
    Prefer,
    Require,
    VerifyCa,
    VerifyFull,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct Tls {
    pub mode: TlsMode,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Profile {
    pub id: Uuid,
    pub name: String,
    pub kind: DbKind,
    #[serde(default)]
    pub env: Environment,
    pub color: Option<String>,
    pub folder: Option<String>,
    pub host: String,
    pub port: u16,
    pub database: String,
    pub user: String,
    pub secret: String,
    #[serde(default)]
    pub read_only: bool,
    #[serde(default)]
    pub agent_access: AgentAccess,
    #[serde(default)]
    pub allow_agent_ddl: bool,
    #[serde(default)]
    pub tls: Tls,
    #[serde(default)]
    pub options: DriverOptions,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct DriverOptions {
    pub instance: Option<String>,
    pub auth: Option<String>,
    pub encrypt: Option<bool>,
    pub trust_server_cert: Option<bool>,
    pub service_name: Option<String>,
    pub sid: Option<String>,
    pub descriptor: Option<String>,
    pub role: Option<String>,
}

impl Profile {
    pub fn validate(&self) -> Result<()> {
        if self.name.trim().is_empty()
            || self.host.trim().is_empty()
            || self.port == 0
            || self.database.trim().is_empty()
            || self.user.trim().is_empty()
        {
            return Err(CoreError::config(
                "Connection name, host, port, database and user are required",
            ));
        }
        if self.allow_agent_ddl
            && (self.env == Environment::Prod || self.agent_access != AgentAccess::Write)
        {
            return Err(CoreError::config(
                "Agent DDL requires write access on a non-production connection",
            ));
        }
        let valid_secret = matches!(self.secret.as_str(), "keychain" | "prompt")
            || self.secret.strip_prefix("env:").is_some_and(|name| {
                !name.is_empty()
                    && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
                    && !name.as_bytes()[0].is_ascii_digit()
            });
        if !valid_secret {
            return Err(CoreError::config(
                "Use keychain, prompt, or env:VARIABLE for the secret",
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(untagged)]
pub enum Cell {
    Null,
    Bool(bool),
    Int(i64),
    Float(f64),
    Text(String),
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CellKind {
    Bool,
    Int,
    Float,
    Decimal,
    Text,
    Date,
    Time,
    Timestamp,
    Timestamptz,
    Interval,
    Uuid,
    Json,
    Xml,
    Binary,
    Array,
    Other,
}

#[derive(Clone, Debug, Serialize)]
pub struct ColumnMeta {
    pub name: String,
    pub db_type: String,
    pub kind: CellKind,
    pub nullable: Option<bool>,
    pub table_oid: Option<u32>,
    pub column_id: Option<i16>,
}

#[derive(Debug)]
pub enum ExecEvent {
    ResultStart(Vec<ColumnMeta>),
    Row(Vec<Cell>),
    ResultEnd,
    Affected(u64),
    Message { level: String, text: String },
}

pub type ExecStream = Pin<Box<dyn Stream<Item = Result<ExecEvent>> + Send>>;
pub type CancelHandle =
    Arc<dyn Fn() -> Pin<Box<dyn Future<Output = Result<()>> + Send>> + Send + Sync>;

#[derive(Debug, Serialize)]
pub struct ServerInfo {
    pub version: String,
    pub database: String,
    pub schema: Option<String>,
    pub user: String,
}

#[async_trait]
pub trait Driver: Send + Sync {
    fn kind(&self) -> DbKind;
    async fn connect(&self, profile: &Profile, secret: &Secret) -> Result<Box<dyn DbConnection>>;
    async fn introspector(
        &self,
        profile: &Profile,
        secret: &Secret,
    ) -> Result<Box<dyn Introspector>>;
}

#[async_trait]
pub trait DbConnection: Send {
    async fn execute(
        &mut self,
        sql: &str,
        cancel: tokio_util::sync::CancellationToken,
    ) -> Result<ExecStream>;
    fn cancel_handle(&self) -> CancelHandle;
    async fn set_read_only(&mut self, on: bool) -> Result<()>;
    async fn set_statement_timeout(&mut self, milliseconds: u32) -> Result<()>;
    async fn begin(&mut self) -> Result<()>;
    async fn commit(&mut self) -> Result<()>;
    async fn rollback(&mut self) -> Result<()>;
    async fn server_info(&mut self) -> Result<ServerInfo>;
    async fn resolution_path(&mut self) -> Result<Vec<String>> {
        Ok(self.server_info().await?.schema.into_iter().collect())
    }
    async fn ping(&mut self) -> Result<()>;
    fn is_closed(&self) -> bool;
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Deserialize, Serialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum ObjectKind {
    Table,
    View,
    MaterializedView,
    ForeignTable,
    Function,
    Procedure,
    Sequence,
}

#[derive(Clone, Debug, Deserialize, Serialize, TS)]
pub struct Object {
    pub oid: u32,
    pub schema: String,
    pub name: String,
    pub kind: ObjectKind,
    #[ts(type = "number | null")]
    pub rows: Option<i64>,
    pub comment: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, TS)]
pub struct TableColumn {
    pub name: String,
    pub db_type: String,
    pub nullable: bool,
    pub default: Option<String>,
    pub identity: String,
    pub generated: String,
    pub comment: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, TS)]
pub struct Definition {
    pub name: String,
    pub sql: String,
    pub related: Option<ObjectReference>,
}

#[derive(Clone, Debug, Deserialize, Serialize, TS)]
pub struct ObjectReference {
    pub schema: String,
    pub name: String,
}

#[derive(Debug, Deserialize, Serialize, TS)]
pub struct TableDetail {
    pub columns: Vec<TableColumn>,
    pub constraints: Vec<Definition>,
    pub indexes: Vec<Definition>,
    pub referenced_by: Vec<Definition>,
    #[ts(type = "number")]
    pub size_bytes: i64,
}

#[async_trait]
pub trait Introspector: Send + Sync {
    async fn databases(&self) -> Result<Vec<String>>;
    async fn schemas(&self, include_system: bool) -> Result<Vec<String>>;
    async fn objects(&self, schema: &str, kinds: &[ObjectKind]) -> Result<Vec<Object>>;
    async fn column_names(
        &self,
        schema: &str,
    ) -> Result<std::collections::BTreeMap<u32, Vec<String>>> {
        let mut columns = std::collections::BTreeMap::new();
        for object in self
            .objects(
                schema,
                &[
                    ObjectKind::Table,
                    ObjectKind::View,
                    ObjectKind::MaterializedView,
                    ObjectKind::ForeignTable,
                ],
            )
            .await?
        {
            columns.insert(
                object.oid,
                self.table_detail(&object)
                    .await?
                    .columns
                    .into_iter()
                    .map(|column| column.name)
                    .collect(),
            );
        }
        Ok(columns)
    }
    async fn table_detail(&self, object: &Object) -> Result<TableDetail>;
    async fn ddl(&self, object: &Object) -> Result<String>;
    async fn resolve(&self, identifier: &str) -> Result<Option<Object>>;
}
