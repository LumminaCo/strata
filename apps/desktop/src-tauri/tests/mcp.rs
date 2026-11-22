use std::fs;

use rmcp::{
    RoleClient, ServiceExt,
    model::{CallToolRequestParams, CallToolResult},
    service::RunningService,
    transport::{ConfigureCommandExt, TokioChildProcess},
};
use serde_json::{Value, json};
use strata_store::{Database, Paths};

async fn call(client: &RunningService<RoleClient, ()>, tool: &str, args: Value) -> CallToolResult {
    client
        .call_tool(
            CallToolRequestParams::new(tool.to_owned())
                .with_arguments(args.as_object().cloned().unwrap_or_default()),
        )
        .await
        .expect("complete the MCP call")
}

#[tokio::test]
#[ignore = "requires the Compose database fixtures"]
async fn native_stdio_guards_audits_and_redacts_agent_queries() {
    assert_eq!(
        std::env::var("STRATA_IT").as_deref(),
        Ok("1"),
        "Use ./x test-int"
    );
    let actual_password = std::env::var("POSTGRES_PASSWORD").expect("fixture secret");
    let scratch = tempfile::tempdir().expect("isolated Strata home");
    let paths = Paths::under(scratch.path().into());
    fs::write(
        &paths.config,
        r#"
version = 1

[settings]
agent_default_row_limit = 2
agent_max_row_limit = 5

[[connection]]
id = "0193a0c2-0000-7000-8000-000000000001"
name = "Reader"
kind = "postgres"
env = "prod"
host = "postgres"
port = 5432
database = "pagila"
user = "postgres"
secret = "env:POSTGRES_PASSWORD"
agent_access = "read"

[[connection]]
id = "0193a0c2-0000-7000-8000-000000000002"
name = "Writer"
kind = "postgres"
host = "postgres"
port = 5432
database = "pagila"
user = "postgres"
secret = "env:POSTGRES_PASSWORD"
agent_access = "write"

[[connection]]
id = "0193a0c2-0000-7000-8000-000000000003"
name = "Prompted"
kind = "postgres"
host = "postgres"
port = 5432
database = "pagila"
user = "postgres"
secret = "prompt"
agent_access = "read"

[[connection]]
id = "0193a0c2-0000-7000-8000-000000000004"
name = "Unlisted"
kind = "postgres"
host = "postgres"
port = 5432
database = "pagila"
user = "postgres"
secret = "env:POSTGRES_PASSWORD"

[[connection]]
id = "0193a0c2-0000-7000-8000-000000000005"
name = "TDS"
kind = "sqlserver"
host = "mssql"
port = 1433
database = "AdventureWorksLT2022"
user = "sa"
secret = "env:SQLCMDPASSWORD"
agent_access = "read"
[connection.options]
trust_server_cert = true

[[connection]]
id = "0193a0c2-0000-7000-8000-000000000006"
name = "Oracle"
kind = "oracle"
host = "oracle"
port = 1521
database = "FREEPDB1"
user = "hr"
secret = "env:ORACLE_APP_PASSWORD"
agent_access = "read"
"#,
    )
    .expect("write profiles");
    let transport = TokioChildProcess::new(
        tokio::process::Command::new(env!("CARGO_BIN_EXE_strata")).configure(|cmd| {
            cmd.arg("mcp")
                .arg("--only")
                .arg("Reader,Writer,Prompted,TDS,Oracle")
                .env("STRATA_HOME", scratch.path());
        }),
    )
    .expect("start Strata MCP");
    let client = ().serve(transport).await.expect("MCP initialize");
    let names = client.list_all_tools().await.unwrap();
    assert_eq!(names.len(), 9);
    assert!(names.iter().any(|tool| tool.name == "run_write"));

    let profiles = call(&client, "list_connections", json!({}))
        .await
        .structured_content
        .unwrap();
    assert_eq!(profiles["connections"].as_array().unwrap().len(), 5);
    assert!(
        !profiles.to_string().contains(&actual_password),
        "connection list redaction"
    );
    let detail = call(
        &client,
        "describe_table",
        json!({"connection":"Reader", "object":"strata_demo.people"}),
    )
    .await;
    assert_eq!(detail.is_error, Some(false));
    assert!(
        !detail.structured_content.unwrap()["detail"]["columns"]
            .as_array()
            .unwrap()
            .is_empty()
    );

    let query = call(&client, "run_query", json!({"connection":"Reader","sql":"SELECT id FROM strata_demo.people ORDER BY id","max_rows":99})).await;
    assert_eq!(query.is_error, Some(false));
    let page = query.structured_content.unwrap();
    assert_eq!(page["row_count"], 5);
    assert_eq!(page["truncated"], true);
    for (connection, sql) in [
        (
            "Reader",
            "UPDATE strata_demo.people SET id = id WHERE id = -1",
        ),
        (
            "Reader",
            "WITH d AS (DELETE FROM strata_demo.people WHERE id = -1 RETURNING *) SELECT * FROM d",
        ),
        (
            "Reader",
            "SELECT id INTO TEMP TABLE mcp_denied_fixture FROM strata_demo.people LIMIT 1",
        ),
        (
            "Reader",
            "COMMIT; DELETE FROM strata_demo.people WHERE id = -1",
        ),
        ("Reader", "SET default_transaction_read_only = off"),
        ("Reader", "SELECT strata_demo.local_write_probe()"),
        ("Oracle", "CREATE TABLE mcp_denied_fixture (id NUMBER)"),
        ("TDS", "EXEC('SELECT 1')"),
        ("TDS", "SELECT 1; SELECT 2;"),
        ("Prompted", "SELECT 1"),
        ("Unlisted", "SELECT 1"),
    ] {
        let result = call(
            &client,
            "run_query",
            json!({"connection":connection,"sql":sql}),
        )
        .await;
        assert_eq!(result.structured_content.unwrap()["decision"], "denied");
    }

    let input = format!(
        "SELECT '{}' AS secret_probe",
        actual_password.replace('\'', "''")
    );
    let redacted = call(
        &client,
        "run_query",
        json!({"connection":"Reader","sql":input}),
    )
    .await;
    assert_eq!(redacted.is_error, Some(false));
    assert!(
        !redacted
            .structured_content
            .unwrap()
            .to_string()
            .contains(&actual_password),
        "query value redaction"
    );
    let dry_run = call(&client, "run_write", json!({"connection":"Writer","sql":"UPDATE strata_demo.people SET id=id WHERE id=-1","dry_run":true})).await;
    assert_eq!(dry_run.is_error, Some(false));
    assert_eq!(dry_run.structured_content.unwrap()["dry_run"], true);

    let tds = call(
        &client,
        "run_query",
        json!({"connection":"TDS","sql":"SELECT TOP (1) id FROM strata_demo.people"}),
    )
    .await;
    assert_eq!(tds.is_error, Some(false));
    let oracle = call(
        &client,
        "run_query",
        json!({"connection":"Oracle","sql":"SELECT id FROM people WHERE id = 1"}),
    )
    .await;
    assert_eq!(oracle.is_error, Some(false));

    let audit = Database::open(&paths.database).unwrap().audit(200).unwrap();
    assert!(
        audit
            .iter()
            .any(|entry| entry.decision == "allowed" && entry.tool == "describe_table")
    );
    assert_eq!(
        audit
            .iter()
            .filter(|entry| entry.decision == "denied")
            .count(),
        11
    );
    assert!(
        !audit.iter().any(|entry| entry
            .sql
            .as_ref()
            .is_some_and(|sql| sql.contains(&actual_password))),
        "audit redaction"
    );
    client.cancel().await.expect("stop MCP server");
}
