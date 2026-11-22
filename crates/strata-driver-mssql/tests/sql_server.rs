use std::{
    sync::Arc,
    time::{Duration, Instant},
};

use strata_core::{
    AgentAccess, Cell, Core, CoreError, DbKind, Driver, DriverOptions, Environment, Limits,
    Profile, Secret, Tls,
};
use strata_driver_mssql::SqlServer;
use tokio_util::sync::CancellationToken;

fn fixture() -> (Profile, Secret) {
    assert_eq!(
        std::env::var("STRATA_IT").as_deref(),
        Ok("1"),
        "Use ./x test-int"
    );
    let profile = Profile {
        id: uuid::Uuid::now_v7(),
        name: "SQL Server fixture".into(),
        kind: DbKind::SqlServer,
        env: Environment::Dev,
        color: None,
        folder: None,
        host: "mssql".into(),
        port: 1433,
        database: "AdventureWorksLT2022".into(),
        user: "sa".into(),
        secret: "env:SQLCMDPASSWORD".into(),
        read_only: false,
        agent_access: AgentAccess::None,
        allow_agent_ddl: false,
        tls: Tls::default(),
        options: DriverOptions {
            trust_server_cert: Some(true),
            ..Default::default()
        },
    };
    (
        profile,
        Secret::new(std::env::var("SQLCMDPASSWORD").expect("SQL fixture password")),
    )
}

#[tokio::test]
#[ignore = "requires SQL Server 2022 in Compose"]
async fn streams_tds_batches_and_preserves_exact_types() {
    let (profile, password) = fixture();
    let core = Core::new(
        [Arc::new(SqlServer) as Arc<dyn Driver>],
        Limits {
            fetch_size: 2,
            ..Limits::default()
        },
    )
    .expect("core");
    let id = core
        .open_session(&profile, &password)
        .await
        .expect("connect");
    let first = core
        .run(
            id,
            "DECLARE @n int = 41; SELECT @n AS first; SELECT @n+1 AS second;",
        )
        .await
        .expect("run batch");
    assert_eq!(first.columns[0].name, "first");
    assert_eq!(first.rows, [vec![Cell::Int(41)]]);
    assert!(first.exhausted && first.next_result);
    let second = core
        .next_result(id, first.cursor, 10, None)
        .await
        .expect("second result");
    assert_eq!(second.columns[0].name, "second");
    assert_eq!(second.rows, [vec![Cell::Int(42)]]);
    assert_eq!(
        core.get_cell(id, first.cursor, 0, 0).await.unwrap(),
        Cell::Int(41)
    );

    let sql = "SELECT CAST('1234567890123456789012345678.1234567890' AS decimal(38,10)), CAST(9223372036854775807 AS bigint), CAST(N'📦' AS nvarchar(10)), CAST('2024-01-19T20:02:03-05:00' AS datetimeoffset), 0x012345, CAST(NULL AS bigint)";
    let types = core.run(id, sql).await.expect("decode native values");
    assert_eq!(
        types.rows[0],
        [
            Cell::Text("1234567890123456789012345678.1234567890".into()),
            Cell::Int(i64::MAX),
            Cell::Text("📦".into()),
            Cell::Text("2024-01-19 20:02:03-05:00".into()),
            Cell::Text("0x012345 (3 bytes)".into()),
            Cell::Null,
        ]
    );
    let zoo = core.run(id, "SELECT exact_value, label, CONVERT(decimal(19,4), price) FROM strata_demo.type_zoo ORDER BY id").await.unwrap();
    assert_eq!(
        zoo.rows,
        [
            vec![
                Cell::Text("9999999999999999999999999999.9999999999".into()),
                Cell::Text("Muñoz · Bogotá 🤖".into()),
                Cell::Text("1234.5678".into())
            ],
            vec![Cell::Null, Cell::Null, Cell::Null],
        ]
    );
    core.close_session(id).await.unwrap();
}

#[tokio::test]
#[ignore = "requires SQL Server 2022 in Compose"]
async fn cancels_with_attention_and_preserves_the_session() {
    let (profile, password) = fixture();
    let core = Core::new([Arc::new(SqlServer) as Arc<dyn Driver>], Limits::default()).unwrap();
    let id = core
        .open_session(&profile, &password)
        .await
        .expect("connect");
    let cancel = CancellationToken::new();
    let started = Instant::now();
    let (result, ()) = tokio::join!(
        core.run_batch(id, "WAITFOR DELAY '00:00:30'; SELECT 41;", 1, Some(&cancel)),
        async {
            tokio::time::sleep(Duration::from_millis(100)).await;
            cancel.cancel();
        }
    );
    assert!(matches!(result, Err(CoreError::Cancelled)));
    assert!(started.elapsed() < Duration::from_secs(2));
    assert_eq!(
        core.run(id, "SELECT 42").await.unwrap().rows,
        [vec![Cell::Int(42)]]
    );
    core.close_session(id).await.unwrap();
}

#[tokio::test]
#[ignore = "requires SQL Server 2022 in Compose"]
async fn reads_catalog_and_foreign_keys() {
    let (profile, password) = fixture();
    let catalog = SqlServer.introspector(&profile, &password).await.unwrap();
    assert!(
        catalog
            .databases()
            .await
            .unwrap()
            .contains(&profile.database)
    );
    assert!(
        catalog
            .schemas(false)
            .await
            .unwrap()
            .contains(&"SalesLT".into())
    );
    let table = catalog
        .resolve("[SalesLT].[SalesOrderDetail]")
        .await
        .unwrap()
        .unwrap();
    let detail = catalog.table_detail(&table).await.unwrap();
    assert!(
        detail
            .columns
            .iter()
            .any(|column| column.name == "SalesOrderID")
    );
    assert!(detail.constraints.iter().any(|item| {
        item.related
            .as_ref()
            .is_some_and(|reference| reference.name == "SalesOrderHeader")
    }));
    assert!(
        catalog
            .ddl(&table)
            .await
            .unwrap()
            .starts_with("CREATE TABLE [SalesLT].[SalesOrderDetail]")
    );
}
