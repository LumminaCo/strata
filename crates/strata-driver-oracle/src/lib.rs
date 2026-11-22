//! Oracle sessions supervised through the pure-Go sidecar.

mod bridge;
mod catalog;

use std::sync::Arc;

use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{Value, json};
use strata_core::{
    CancelHandle, Cell, CellKind, ColumnMeta, CoreError, DbConnection, DbKind, Driver, ExecEvent,
    ExecStream, Introspector, Profile, Result, Secret, ServerInfo,
};
use tokio_util::sync::CancellationToken;

use crate::bridge::{Bridge, Supervisor};

#[derive(Default)]
pub struct Oracle {
    supervisor: Supervisor,
}

#[async_trait]
impl Driver for Oracle {
    fn kind(&self) -> DbKind {
        DbKind::Oracle
    }

    async fn connect(&self, profile: &Profile, secret: &Secret) -> Result<Box<dyn DbConnection>> {
        Ok(Box::new(self.session(profile, secret).await?))
    }

    async fn introspector(
        &self,
        profile: &Profile,
        secret: &Secret,
    ) -> Result<Box<dyn Introspector>> {
        Ok(Box::new(catalog::Catalog {
            session: tokio::sync::Mutex::new(self.session(profile, secret).await?),
            service: profile.database.clone(),
        }))
    }
}

impl Oracle {
    async fn session(&self, profile: &Profile, secret: &Secret) -> Result<Session> {
        let bridge = self.supervisor.bridge().await?;
        #[derive(Deserialize)]
        struct Connected {
            conn_id: u64,
        }
        let params = json!({
            "host": profile.host, "port": profile.port, "service": profile.options.service_name.as_deref().unwrap_or(&profile.database),
            "sid": profile.options.sid, "descriptor": profile.options.descriptor, "role": profile.options.role,
            "user": profile.user, "password": secret.expose(), "tls": profile.tls.mode,
            "wallet": profile.options.wallet,
        });
        let result: Connected = bridge.rpc("connect", params).await?;
        Ok(Session {
            bridge,
            id: result.conn_id,
            timeout: 0,
        })
    }
}

pub(crate) struct Session {
    bridge: Arc<Bridge>,
    id: u64,
    timeout: u32,
}

#[derive(Deserialize)]
struct Columns {
    name: String,
    db_type: String,
}

#[derive(Deserialize)]
struct Executed {
    query_id: u64,
    columns: Option<Vec<Columns>>,
    affected: Option<u64>,
    #[serde(default)]
    messages: Vec<String>,
}

#[derive(Deserialize)]
struct Page {
    rows: Vec<Vec<Value>>,
    exhausted: bool,
}

impl Session {
    async fn command(&self, method: &str) -> Result<()> {
        self.bridge
            .rpc::<Value>(method, json!({"conn_id": self.id}))
            .await
            .map(|_| ())
    }

    pub(crate) async fn query(&self, sql: &str, bind: &[Value]) -> Result<Vec<Vec<Value>>> {
        let result: Executed = self.bridge.rpc("execute", json!({
            "conn_id": self.id, "sql": sql, "bind": bind, "returns_rows": true, "timeout_ms": 15_000,
        })).await?;
        let mut rows = Vec::new();
        loop {
            let page: Page = self
                .bridge
                .rpc(
                    "fetch",
                    json!({
                        "conn_id": self.id, "query_id": result.query_id, "n": 128,
                    }),
                )
                .await?;
            rows.extend(page.rows);
            if page.exhausted {
                return Ok(rows);
            }
        }
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        let bridge = self.bridge.clone();
        let id = self.id;
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            handle.spawn(async move {
                let _ = bridge.rpc::<Value>("close", json!({"conn_id": id})).await;
            });
        }
    }
}

#[async_trait]
impl DbConnection for Session {
    async fn execute(&mut self, sql: &str, cancel: CancellationToken) -> Result<ExecStream> {
        let (sql, returns_rows) = strata_sql::oracle_execution(sql);
        let sql = sql.to_owned();
        let bridge = self.bridge.clone();
        let conn_id = self.id;
        let timeout = self.timeout;
        Ok(Box::pin(async_stream::try_stream! {
            if cancel.is_cancelled() { Err(CoreError::Cancelled)?; }
            let result: Executed = bridge.rpc("execute", json!({
                "conn_id": conn_id, "sql": sql, "returns_rows": returns_rows, "timeout_ms": timeout,
            })).await?;
            if let Some(columns) = result.columns {
                yield ExecEvent::ResultStart(columns.into_iter().map(ColumnMeta::from).collect());
                loop {
                    if cancel.is_cancelled() {
                        let _ = bridge.rpc::<Value>("close_query", json!({
                            "conn_id": conn_id, "query_id": result.query_id,
                        })).await;
                        Err(CoreError::Cancelled)?;
                    }
                    let page: Page = bridge.rpc("fetch", json!({
                        "conn_id": conn_id, "query_id": result.query_id, "n": 128,
                    })).await?;
                    for row in page.rows {
                        yield ExecEvent::Row(row.into_iter().map(cell).collect());
                    }
                    if page.exhausted { break; }
                }
                yield ExecEvent::ResultEnd;
            } else if let Some(affected) = result.affected {
                yield ExecEvent::Affected(affected);
            }
            for text in result.messages {
                yield ExecEvent::Message { level: "notice".into(), text };
            }
        }))
    }

    fn cancel_handle(&self) -> CancelHandle {
        let bridge = self.bridge.clone();
        let id = self.id;
        Arc::new(move || {
            let bridge = bridge.clone();
            Box::pin(async move {
                bridge
                    .rpc::<Value>("cancel", json!({"conn_id": id}))
                    .await
                    .map(|_| ())
            })
        })
    }

    async fn set_read_only(&mut self, enabled: bool) -> Result<()> {
        self.bridge
            .rpc::<Value>(
                "set_read_only",
                json!({"conn_id": self.id, "enabled": enabled}),
            )
            .await
            .map(|_| ())
    }
    async fn set_statement_timeout(&mut self, milliseconds: u32) -> Result<()> {
        self.timeout = milliseconds;
        Ok(())
    }
    async fn set_dbms_output(&mut self, enabled: bool) -> Result<()> {
        self.bridge
            .rpc::<Value>(
                "dbms_output",
                json!({"conn_id": self.id, "enabled": enabled}),
            )
            .await
            .map(|_| ())
    }
    async fn begin(&mut self) -> Result<()> {
        self.command("begin").await
    }
    async fn commit(&mut self) -> Result<()> {
        self.command("commit").await
    }
    async fn rollback(&mut self) -> Result<()> {
        self.command("rollback").await
    }
    async fn ping(&mut self) -> Result<()> {
        self.command("ping").await
    }

    async fn server_info(&mut self) -> Result<ServerInfo> {
        let version = self
            .query("SELECT banner FROM v$version WHERE ROWNUM = 1", &[])
            .await
            .ok()
            .and_then(|rows| {
                rows.first()
                    .and_then(|row| row.first())
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            })
            .unwrap_or_else(|| "Oracle Database".into());
        let rows = self.query("SELECT SYS_CONTEXT('USERENV','SERVICE_NAME'), SYS_CONTEXT('USERENV','CURRENT_SCHEMA'), SYS_CONTEXT('USERENV','SESSION_USER') FROM dual", &[]).await?;
        let row = rows
            .first()
            .ok_or_else(|| CoreError::config("Oracle did not return session information"))?;
        Ok(ServerInfo {
            version,
            database: catalog::text(row, 0),
            schema: Some(catalog::text(row, 1)),
            user: catalog::text(row, 2),
        })
    }

    fn is_closed(&self) -> bool {
        self.bridge.closed()
    }
}

fn cell(value: Value) -> Cell {
    match value {
        Value::Null => Cell::Null,
        Value::Bool(value) => Cell::Bool(value),
        Value::Number(value) if value.is_i64() => Cell::Int(value.as_i64().unwrap_or_default()),
        Value::Number(value) if value.is_f64() => Cell::Float(value.as_f64().unwrap_or_default()),
        Value::String(value) => Cell::Text(value),
        other => Cell::Text(other.to_string()),
    }
}

impl From<Columns> for ColumnMeta {
    fn from(column: Columns) -> Self {
        let db_type = column.db_type;
        let kind = match db_type.as_str() {
            "NUMBER" | "DECIMAL" | "FLOAT" => CellKind::Decimal,
            "BINARY_FLOAT" | "BINARY_DOUBLE" => CellKind::Float,
            "BOOLEAN" => CellKind::Bool,
            "DATE" | "TIMESTAMP" => CellKind::Timestamp,
            "TIMESTAMPTZ"
            | "TIMESTAMPLTZ"
            | "TIMESTAMP WITH TIME ZONE"
            | "TIMESTAMP WITH LOCAL TIME ZONE" => CellKind::Timestamptz,
            "CHAR" | "NCHAR" | "VARCHAR2" | "NVARCHAR2" | "CLOB" | "NCLOB" | "LONG" | "ROWID" => {
                CellKind::Text
            }
            "RAW" | "LONG RAW" | "BLOB" => CellKind::Binary,
            "JSON" => CellKind::Json,
            "XMLTYPE" => CellKind::Xml,
            name if name.starts_with("INTERVAL") => CellKind::Interval,
            _ => CellKind::Other,
        };
        ColumnMeta {
            db_type,
            kind,
            name: column.name,
            nullable: None,
            table_oid: None,
            column_id: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};
    use strata_core::{AgentAccess, Core, DriverOptions, Environment, Limits, Tls};

    fn fixture(host: &str, service: &str) -> (Profile, Secret) {
        assert_eq!(
            std::env::var("STRATA_IT").as_deref(),
            Ok("1"),
            "Use ./x test-int"
        );
        let profile = Profile {
            id: uuid::Uuid::now_v7(),
            name: format!("Oracle {service} fixture"),
            kind: DbKind::Oracle,
            env: Environment::Dev,
            color: None,
            folder: None,
            host: host.into(),
            port: 1521,
            database: service.into(),
            user: "hr".into(),
            secret: "env:ORACLE_APP_PASSWORD".into(),
            read_only: false,
            agent_access: AgentAccess::None,
            allow_agent_ddl: false,
            tls: Tls::default(),
            options: DriverOptions::default(),
        };
        (
            profile,
            Secret::new(std::env::var("ORACLE_APP_PASSWORD").expect("Oracle fixture password")),
        )
    }

    async fn check_catalog(host: &str, service: &str) {
        let (profile, password) = fixture(host, service);
        let driver = Arc::new(Oracle::default());
        let core = Core::new(
            [driver.clone() as Arc<dyn Driver>],
            Limits {
                fetch_size: 1,
                ..Limits::default()
            },
        )
        .unwrap();
        let id = core
            .open_session(&profile, &password)
            .await
            .expect("open Oracle");
        let batch = core
            .run(
                id,
                "SELECT id, joined_on FROM people WHERE id <= 2 ORDER BY id;",
            )
            .await
            .unwrap();
        assert_eq!(batch.rows.len(), 1);
        assert_eq!(batch.rows[0][0], Cell::Text("1".into()));
        assert_eq!(
            core.fetch_more(id, batch.cursor, 2)
                .await
                .unwrap()
                .rows
                .len(),
            1
        );
        let type_zoo = core
            .run(id, "SELECT * FROM type_zoo WHERE id = 1;")
            .await
            .unwrap();
        assert!(
            type_zoo.rows[0]
                .iter()
                .any(|value| matches!(value, Cell::Text(text) if text.contains("Muñoz")))
        );
        let catalog = driver.introspector(&profile, &password).await.unwrap();
        assert!(catalog.schemas(false).await.unwrap().contains(&"HR".into()));
        assert!(
            catalog
                .objects("HR", &[])
                .await
                .unwrap()
                .iter()
                .any(|object| object.kind == strata_core::ObjectKind::Synonym)
        );
        let target = catalog
            .resolve("\"DEMO_PEOPLE\"")
            .await
            .unwrap()
            .expect("resolve private synonym");
        assert_eq!(target.name, "PEOPLE");
        let detail = catalog.table_detail(&target).await.unwrap();
        assert!(detail.columns.iter().any(|column| column.name == "ID"));
        assert!(catalog.ddl(&target).await.unwrap().contains("CREATE TABLE"));
        core.fetch_more(id, type_zoo.cursor, 1).await.unwrap();
        core.set_dbms_output(id, true).await.unwrap();
        let block = core
            .run(id, "BEGIN DBMS_OUTPUT.PUT_LINE('strata output'); END;")
            .await
            .unwrap();
        assert!(
            block
                .messages
                .iter()
                .any(|(_, text)| text == "strata output")
        );
        core.close_session(id).await.unwrap();
    }

    #[tokio::test]
    #[ignore = "requires Oracle 23ai Free in Compose"]
    async fn oracle_free_stream_and_catalog() {
        check_catalog("oracle", "FREEPDB1").await;
    }

    #[tokio::test]
    #[ignore = "requires the legacy Oracle 11g XE fixture"]
    async fn oracle_xe_stream_and_catalog() {
        if std::env::var("ORACLE11_TEST").as_deref() == Ok("1") {
            check_catalog("oracle11", "XE").await;
        }
    }

    #[tokio::test]
    #[ignore = "requires Oracle 23ai Free in Compose"]
    async fn cancellation_and_supervisor_recovery() {
        let (profile, password) = fixture("oracle", "FREEPDB1");
        let driver = Arc::new(Oracle::default());
        let core = Core::new([driver.clone() as Arc<dyn Driver>], Limits::default()).unwrap();
        let id = core
            .open_session(&profile, &password)
            .await
            .expect("open Oracle");
        let cancel = CancellationToken::new();
        let start = Instant::now();
        let (value, ()) = tokio::join!(
            core.run_batch(id, "BEGIN DBMS_SESSION.SLEEP(30); END;", 1, Some(&cancel)),
            async {
                tokio::time::sleep(Duration::from_millis(200)).await;
                cancel.cancel();
            }
        );
        assert!(matches!(value, Err(CoreError::Cancelled)), "{value:?}");
        assert!(start.elapsed() < Duration::from_secs(2));
        let bridge = driver.supervisor.bridge().await.unwrap();
        let (failed, ()) =
            tokio::join!(core.run(id, "BEGIN DBMS_SESSION.SLEEP(30); END;"), async {
                tokio::time::sleep(Duration::from_millis(200)).await;
                bridge.terminate().await;
            });
        assert!(
            matches!(failed, Err(CoreError::Bridge { .. })),
            "{failed:?}"
        );
        let recovered = core
            .open_session(&profile, &password)
            .await
            .expect("restart bridge");
        assert_eq!(
            core.run(recovered, "SELECT 42 FROM dual")
                .await
                .unwrap()
                .rows,
            [vec![Cell::Text("42".into())]]
        );
        core.close_session(recovered).await.unwrap();
    }
}
