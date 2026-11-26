use serde::{Deserialize, Serialize};
use strata_core::{Batch, Cell, ColumnMeta, CoreError, Environment, TlsMode};
use ts_rs::TS;
use uuid::Uuid;

#[derive(Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    pub id: Option<Uuid>,
    pub name: String,
    #[ts(type = "'postgres' | 'sqlserver' | 'oracle'")]
    pub kind: strata_core::DbKind,
    #[ts(type = "'dev' | 'staging' | 'prod'")]
    pub env: Environment,
    pub color: Option<String>,
    pub folder: Option<String>,
    pub host: String,
    pub port: u16,
    pub database: String,
    pub user: String,
    pub secret: String,
    pub read_only: bool,
    #[serde(default)]
    #[ts(type = "'none' | 'read' | 'write'")]
    pub agent_access: strata_core::AgentAccess,
    #[serde(default)]
    pub allow_agent_ddl: bool,
    pub options: Option<strata_core::DriverOptions>,
    #[ts(type = "'disable' | 'prefer' | 'require' | 'verify-ca' | 'verify-full'")]
    pub tls: TlsMode,
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub id: Uuid,
    pub version: String,
    pub database: String,
    pub schema: Option<String>,
    pub elapsed_ms: u32,
}

#[derive(Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub tabs: Vec<SavedTab>,
    pub active_tab: Option<Uuid>,
}

#[derive(Serialize, TS)]
pub struct WorkspaceBootstrap {
    pub connections: Vec<Connection>,
    pub workspace: Workspace,
    pub settings: strata_store::Settings,
}

#[derive(Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SavedTab {
    pub id: Uuid,
    pub connection_id: Uuid,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub file_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub database: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub schema: Option<String>,
    pub text: String,
}

#[derive(Debug, Serialize, TS)]
pub struct ErrorDto {
    pub kind: String,
    pub message: String,
    pub code: Option<String>,
    pub position: Option<u32>,
    pub line: Option<u32>,
}

impl From<CoreError> for ErrorDto {
    fn from(error: CoreError) -> Self {
        let message = error.to_string();
        let (code, position, line) = match &error {
            CoreError::Db {
                code,
                position,
                line,
                ..
            } => (Some(code.clone()), *position, *line),
            _ => (None, None, None),
        };
        let kind = match error {
            CoreError::Connect { .. } => "connect",
            CoreError::Auth => "auth",
            CoreError::Tls { .. } => "tls",
            CoreError::Timeout => "timeout",
            CoreError::Cancelled => "cancelled",
            CoreError::Db { .. } => "db",
            CoreError::ReadOnlyViolation { .. } => "read_only_violation",
            CoreError::Config { .. } => "config",
            CoreError::Secret { .. } => "secret",
            CoreError::Io { .. } => "io",
            CoreError::Bridge { .. } => "bridge",
        }
        .into();
        Self {
            kind,
            message,
            code,
            position,
            line,
        }
    }
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct NextResult {
    pub cursor_id: Uuid,
    #[ts(type = "ColumnMeta[]")]
    pub columns: Vec<ColumnMeta>,
    pub page: Page,
}

#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RunRequest {
    pub run_id: Uuid,
    pub session_id: Uuid,
    pub text: String,
    pub target: Target,
    pub mode: RunMode,
    pub confirmed: bool,
    #[serde(default)]
    #[ts(optional)]
    pub keep_results: Option<bool>,
}

#[derive(Deserialize, TS)]
#[serde(untagged)]
pub enum Target {
    Cursor { cursor: u32 },
    Selection { selection: [u32; 2] },
}

#[derive(Clone, Copy, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum RunMode {
    Statement,
    Script,
    Explain,
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct QueryPlan {
    pub statements: Vec<[u32; 2]>,
    pub confirmation: Option<String>,
}

#[derive(Serialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum RunEvent {
    StatementStart {
        index: usize,
        span: [u32; 2],
    },
    ResultStart {
        cursor_id: Uuid,
        result_index: usize,
        #[ts(type = "ColumnMeta[]")]
        columns: Vec<ColumnMeta>,
        #[serde(default)]
        #[ts(type = "Cell[][]")]
        rows: Vec<Vec<WireCell>>,
    },
    Rows {
        cursor_id: Uuid,
        #[ts(type = "Cell[][]")]
        rows: Vec<Vec<WireCell>>,
    },
    ResultPaused {
        cursor_id: Uuid,
        fetched: usize,
    },
    ResultEnd {
        cursor_id: Uuid,
        fetched: usize,
        capped: bool,
    },
    Affected {
        statement_index: usize,
        rows: u32,
    },
    Message {
        level: String,
        text: String,
    },
    Error {
        statement_index: usize,
        error: ErrorDto,
    },
    TransactionState {
        manual: bool,
        open: bool,
    },
    SessionContext {
        database: String,
        schema: Option<String>,
    },
    CatalogChanged {
        connection_id: Uuid,
    },
    Done {
        elapsed_ms: u32,
        statements: usize,
    },
}

#[derive(Serialize)]
#[serde(untagged)]
pub enum WireCell {
    Value(Cell),
    Exact(String),
}

impl From<Cell> for WireCell {
    fn from(cell: Cell) -> Self {
        // JavaScript cannot round-trip bigint values outside its safe integer range.
        match cell {
            Cell::Int(value) if value.unsigned_abs() > (1_u64 << 53) - 1 => {
                Self::Exact(value.to_string())
            }
            other => Self::Value(other),
        }
    }
}

pub(crate) fn wire_rows(rows: Vec<Vec<Cell>>) -> Vec<Vec<WireCell>> {
    rows.into_iter()
        .map(|row| row.into_iter().map(Into::into).collect())
        .collect()
}

#[derive(Serialize, TS)]
pub struct Page {
    #[ts(type = "Cell[][]")]
    pub rows: Vec<Vec<WireCell>>,
    pub fetched: usize,
    pub exhausted: bool,
    #[serde(rename = "nextResult")]
    pub next_result: bool,
    pub capped: bool,
    pub messages: Vec<(String, String)>,
}

impl From<Batch> for Page {
    fn from(batch: Batch) -> Self {
        Self {
            rows: wire_rows(batch.rows),
            fetched: batch.fetched,
            exhausted: batch.exhausted,
            next_result: batch.next_result,
            capped: batch.capped,
            messages: batch.messages,
        }
    }
}

#[derive(Deserialize)]
#[serde(
    tag = "command",
    content = "args",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum Command {
    ListConnections,
    SaveConnection {
        profile: Connection,
        password: Option<String>,
    },
    DeleteConnection {
        id: Uuid,
    },
    TestConnection {
        profile: Connection,
        password: Option<String>,
    },
    ParseConnectionUrl {
        url: String,
    },
    OpenSession {
        connection_id: Uuid,
        database: Option<String>,
        #[serde(default)]
        schema: Option<String>,
        password: Option<String>,
    },
    CloseSession {
        session_id: Uuid,
    },
    Stop {
        session_id: Uuid,
        run_id: Option<Uuid>,
    },
    FetchMore {
        session_id: Uuid,
        cursor_id: Uuid,
        count: usize,
    },
    SetDbmsOutput {
        session_id: Uuid,
        enabled: bool,
    },
    SetSchema {
        session_id: Uuid,
        schema: String,
    },
    NextResult {
        session_id: Uuid,
        cursor_id: Uuid,
        count: usize,
    },
    GetCell {
        session_id: Uuid,
        cursor_id: Uuid,
        row: usize,
        column: usize,
    },
    DropResult {
        session_id: Uuid,
        cursor_id: Uuid,
    },
    PlanQuery {
        kind: Option<strata_core::DbKind>,
        text: String,
        target: Target,
        mode: RunMode,
        production: bool,
    },
    ListDatabases {
        scope: crate::CatalogScope,
    },
    ListSchemas {
        scope: crate::CatalogScope,
    },
    CatalogSnapshot {
        scope: crate::CatalogScope,
        schema: String,
    },
    CatalogObjects {
        scope: crate::CatalogScope,
        schema: String,
        #[serde(default)]
        kinds: Vec<strata_core::ObjectKind>,
        #[serde(default)]
        search: Option<String>,
        #[serde(default)]
        offset: usize,
        #[serde(default)]
        limit: Option<usize>,
    },
    RefreshMetadata {
        connection_id: Uuid,
    },
    HistoryList {
        connection_id: Uuid,
        limit: Option<u32>,
    },
    ResolveAt {
        scope: crate::CatalogScope,
        session_id: Option<Uuid>,
        #[serde(default)]
        schema: Option<String>,
        text: String,
        offset: u32,
    },
    ObjectDetails {
        scope: crate::CatalogScope,
        object: strata_core::Object,
    },
    ResolveObject {
        scope: crate::CatalogScope,
        reference: strata_core::ObjectReference,
    },
    OpenInspectionSession {
        scope: crate::CatalogScope,
    },
    SettingsGet,
    SettingsSave {
        settings: strata_store::Settings,
    },
    SetTransactionMode {
        session_id: Uuid,
        manual: bool,
    },
    FinishTransaction {
        session_id: Uuid,
        commit: bool,
    },
    AuditList {
        limit: Option<u32>,
    },
    McpConfig,
    WorkspaceLoad,
    WorkspaceBootstrap,
    WorkspaceSave {
        workspace: Workspace,
    },
}

#[derive(Serialize, TS)]
pub struct TransactionState {
    pub manual: bool,
    pub open: bool,
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct HistoryItem {
    pub sql: String,
    #[ts(type = "number")]
    pub started_at: i64,
    pub duration_ms: u32,
    pub rows: u32,
    pub status: String,
}

impl From<strata_store::HistoryEntry> for HistoryItem {
    fn from(entry: strata_store::HistoryEntry) -> Self {
        Self {
            sql: entry.sql,
            started_at: entry.started_at,
            duration_ms: entry.duration_ms,
            rows: entry.rows,
            status: entry.status.as_str().into(),
        }
    }
}

#[cfg(test)]
#[test]
fn typescript_bindings() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../apps/desktop/src/ipc/bindings/protocol.ts");
    let mut output = String::from("// Generated by ./x bindings.\n\n");
    output.push_str("export type Cell = null | boolean | number | string;\n");
    output.push_str("export type ColumnMeta = { name: string; db_type: string; kind: string; nullable: boolean | null; table_oid: number | null; column_id: number | null; foreign_key?: ForeignKeyRef | null };\n");
    let cfg = ts_rs::Config::default();
    for decl in [
        strata_core::ForeignKeyRef::decl(&cfg),
        strata_core::ObjectKind::decl(&cfg),
        strata_core::Object::decl(&cfg),
        strata_core::ObjectPage::decl(&cfg),
        strata_core::ObjectReference::decl(&cfg),
        strata_core::TableColumn::decl(&cfg),
        strata_core::Definition::decl(&cfg),
        strata_core::TableDetail::decl(&cfg),
        crate::ObjectDetails::decl(&cfg),
        crate::ResolvedObject::decl(&cfg),
        crate::CatalogScope::decl(&cfg),
        crate::CatalogSnapshot::decl(&cfg),
        HistoryItem::decl(&cfg),
        strata_store::AuditEntry::decl(&cfg),
        strata_store::Settings::decl(&cfg),
        strata_store::Theme::decl(&cfg),
        TransactionState::decl(&cfg),
        strata_core::DriverOptions::decl(&cfg),
        Connection::decl(&cfg),
        SessionInfo::decl(&cfg),
        Workspace::decl(&cfg),
        WorkspaceBootstrap::decl(&cfg),
        SavedTab::decl(&cfg),
        ErrorDto::decl(&cfg),
        Target::decl(&cfg),
        RunMode::decl(&cfg),
        RunRequest::decl(&cfg),
        QueryPlan::decl(&cfg),
        RunEvent::decl(&cfg),
        Page::decl(&cfg),
        NextResult::decl(&cfg),
        crate::ParsedUrl::decl(&cfg),
    ] {
        output.push_str("export ");
        output.push_str(&decl);
        output.push('\n');
    }
    if std::env::var_os("STRATA_UPDATE_BINDINGS").is_some() {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, &output).unwrap();
    }
    assert_eq!(
        std::fs::read_to_string(path).unwrap_or_default(),
        output,
        "Run ./x bindings"
    );
}

#[cfg(test)]
#[test]
fn saved_tab_title_is_optional_and_roundtrips() {
    let id = Uuid::now_v7();
    let connection_id = Uuid::now_v7();
    let legacy = serde_json::json!({
        "id": id,
        "connectionId": connection_id,
        "text": "SELECT 1;"
    });
    let parsed: SavedTab = serde_json::from_value(legacy).expect("legacy saved tab");
    assert_eq!(parsed.title, None);
    assert_eq!(parsed.file_path, None);
    let encoded = serde_json::to_value(&parsed).expect("encode legacy tab");
    assert!(encoded.get("title").is_none());
    assert!(encoded.get("filePath").is_none());

    let renamed = SavedTab {
        title: Some("Monthly report".into()),
        file_path: Some("/home/ada/Documents/Strata/monthly_report.sql".into()),
        ..parsed
    };
    let encoded_renamed = serde_json::to_value(&renamed).expect("encode renamed tab");
    assert_eq!(encoded_renamed["title"], "Monthly report");
    assert_eq!(
        encoded_renamed["filePath"],
        "/home/ada/Documents/Strata/monthly_report.sql"
    );
    let roundtrip: SavedTab = serde_json::from_value(encoded_renamed).expect("decode renamed tab");
    assert_eq!(roundtrip.title.as_deref(), Some("Monthly report"));
    assert_eq!(
        roundtrip.file_path.as_deref(),
        Some("/home/ada/Documents/Strata/monthly_report.sql")
    );
}
