use std::{sync::Arc, time::Duration};

use futures_util::StreamExt;
use strata_core::{
    AgentAccess, Batch, Cell, CellKind, Core, CoreError, DbKind, Driver, DriverOptions,
    Environment, ExecEvent, Limits, ObjectKind, Profile, Secret, Tls, TlsMode,
};
use strata_driver_postgres::Postgres;
use tokio_util::sync::CancellationToken;

fn fixture() -> (Profile, Secret) {
    assert_eq!(
        std::env::var("STRATA_IT").as_deref(),
        Ok("1"),
        "Use ./x test-int"
    );
    let password = std::env::var("POSTGRES_PASSWORD").expect("missing fixture password");
    (
        Profile {
            id: Default::default(),
            name: "Pagila".into(),
            kind: DbKind::Postgres,
            env: Environment::Dev,
            color: None,
            folder: None,
            host: "postgres".into(),
            port: 5432,
            database: "pagila".into(),
            user: "postgres".into(),
            secret: "env:POSTGRES_PASSWORD".into(),
            read_only: false,
            agent_access: AgentAccess::None,
            allow_agent_ddl: false,
            tls: Tls::default(),
            options: DriverOptions::default(),
        },
        Secret::new(password),
    )
}

fn engine(limits: Limits) -> Core {
    Core::new([Arc::new(Postgres) as Arc<dyn Driver>], limits).expect("valid core")
}

#[tokio::test]
#[ignore = "requires the Compose PostgreSQL fixture"]
async fn streams_a_million_rows_and_limits_the_session_cursor() {
    let (profile, secret) = fixture();
    let mut driver = Postgres.connect(&profile, &secret).await.expect("connect");
    let sql = "SELECT id FROM strata_demo.people ORDER BY id";
    let mut stream = driver
        .execute(sql, CancellationToken::new())
        .await
        .expect("execute");
    let mut total = 0;
    while let Some(event) = stream.next().await {
        if let ExecEvent::Row(cells) = event.expect("read row") {
            total += 1;
            assert_eq!(cells, [Cell::Int(total)]);
            if total == 500 {
                tokio::time::sleep(Duration::from_millis(40)).await;
            }
        }
    }
    assert_eq!(total, 1_000_000);

    let app = engine(Limits {
        row_cap: 1050,
        ..Default::default()
    });
    let session = app.open_session(&profile, &secret).await.expect("session");
    let first = app.run(session, sql).await.expect("first batch");
    assert_eq!((first.rows.len(), first.exhausted), (500, false));
    let Batch {
        capped,
        exhausted,
        fetched,
        rows,
        ..
    } = app
        .fetch_more(session, first.cursor, 1000)
        .await
        .expect("resume");
    assert!(capped && exhausted);
    assert_eq!(
        (fetched, rows.len(), &rows[0]),
        (1050, 550, &vec![Cell::Int(501)])
    );
    assert_eq!(
        app.get_cell(session, first.cursor, 1049, 0)
            .await
            .expect("cached row"),
        Cell::Int(1050)
    );
    let next = app
        .run(session, "SELECT 7")
        .await
        .expect("session reusable after cap");
    assert_eq!(next.rows, [vec![Cell::Int(7)]]);
    app.close_session(session).await.expect("close");
}

#[tokio::test]
#[ignore = "requires the Compose PostgreSQL fixture"]
async fn snapshots_types_and_lob_previews() {
    let (profile, secret) = fixture();
    let app = engine(Limits::default());
    let session = app.open_session(&profile, &secret).await.expect("session");
    let batch = app
        .run(session, "SELECT * FROM strata_demo.type_zoo ORDER BY id")
        .await
        .expect("types");
    let kinds: Vec<_> = batch.columns.iter().map(|column| column.kind).collect();
    assert_eq!(
        kinds,
        [
            CellKind::Int,
            CellKind::Bool,
            CellKind::Decimal,
            CellKind::Int,
            CellKind::Int,
            CellKind::Timestamptz,
            CellKind::Interval,
            CellKind::Array,
            CellKind::Json,
            CellKind::Binary,
            CellKind::Uuid
        ]
    );
    assert_eq!(batch.columns[2].db_type, "numeric(38,10)");
    assert!(
        batch
            .columns
            .iter()
            .all(|column| column.table_oid.is_some() && column.column_id.is_some())
    );
    assert_eq!(
        batch.rows[0],
        vec![
            Cell::Int(1),
            Cell::Bool(true),
            Cell::Text("9999999999999999999999999999.9999999999".into()),
            Cell::Text("-9223372036854775808".into()),
            Cell::Text("9223372036854775807".into()),
            Cell::Text("2026-01-20 15:30:00+00".into()),
            Cell::Text("1 year 2 days".into()),
            Cell::Text("{Muñoz,Bogotá,🤖}".into()),
            Cell::Text("{\"city\": \"Medellín\"}".into()),
            Cell::Text("0x00ff (2 bytes)".into()),
            Cell::Text("a144e09d-e626-40bb-95ad-0560fb123456".into()),
        ]
    );
    assert_eq!(batch.rows[1][1..], vec![Cell::Null; 10]);
    let lob = app
        .run(session, "SELECT repeat('🤖', 2100)")
        .await
        .expect("LOB");
    assert_eq!(
        lob.rows[0][0],
        Cell::Text(format!("{}…", "🤖".repeat(2000)))
    );
    assert_eq!(
        app.get_cell(session, lob.cursor, 0, 0)
            .await
            .expect("full LOB"),
        Cell::Text("🤖".repeat(2100))
    );
}

#[tokio::test]
#[ignore = "requires the Compose PostgreSQL fixture"]
async fn stops_an_active_query_and_reports_timeouts_and_utf16_errors() {
    let (profile, secret) = fixture();
    let app = Arc::new(engine(Limits::default()));
    let session = app.open_session(&profile, &secret).await.expect("session");
    let running = {
        let app = Arc::clone(&app);
        tokio::spawn(async move { app.run(session, "SELECT pg_sleep(30)").await })
    };
    tokio::time::sleep(Duration::from_millis(200)).await;
    tokio::time::timeout(Duration::from_secs(2), app.stop(session))
        .await
        .expect("stop before deadline")
        .expect("stop");
    assert!(matches!(
        running.await.expect("worker"),
        Err(CoreError::Cancelled)
    ));
    assert_eq!(
        app.run(session, "SELECT 42")
            .await
            .expect("reusable session")
            .rows,
        [vec![Cell::Int(42)]]
    );

    let sql = "SELECT 'á🤖', )";
    let result = app.run(session, sql).await;
    let expected = "SELECT 'á🤖', ".encode_utf16().count() as u32;
    assert!(
        matches!(result, Err(CoreError::Db { position: Some(offset), .. }) if offset == expected)
    );

    let app = engine(Limits {
        timeout_ms: 100,
        ..Default::default()
    });
    let session = app
        .open_session(&profile, &secret)
        .await
        .expect("session with timeout");
    assert!(matches!(
        app.run(session, "SELECT pg_sleep(3)").await,
        Err(CoreError::Timeout)
    ));
}

#[tokio::test]
#[ignore = "requires the Compose PostgreSQL fixture"]
async fn browses_catalog_and_preserves_the_tab_connection() {
    let (profile, secret) = fixture();
    let app = engine(Limits::default());
    let metadata = app
        .introspector(&profile, &secret)
        .await
        .expect("metadata pool");
    assert!(
        metadata
            .databases()
            .await
            .expect("databases")
            .contains(&"pagila".into())
    );
    assert!(
        metadata
            .schemas(false)
            .await
            .expect("schemas")
            .contains(&"strata_demo".into())
    );
    assert!(
        !metadata
            .schemas(false)
            .await
            .expect("user schemas")
            .contains(&"pg_catalog".into())
    );
    let people = metadata
        .resolve("strata_demo.people")
        .await
        .expect("resolve")
        .expect("people");
    let table = metadata.table_detail(&people).await.expect("details");
    assert_eq!(
        table
            .columns
            .iter()
            .map(|column| column.name.as_str())
            .collect::<Vec<_>>(),
        ["id", "full_name", "city", "joined_on"]
    );
    assert_eq!(table.constraints[0].sql, "PRIMARY KEY (id)");
    assert!(table.size_bytes > 0);
    assert_eq!(
        metadata.ddl(&people).await.expect("DDL"),
        concat!(
            "CREATE TABLE \"strata_demo\".\"people\" (\n",
            "    \"id\" integer NOT NULL,\n",
            "    \"full_name\" text NOT NULL,\n",
            "    \"city\" text NOT NULL,\n",
            "    \"joined_on\" date NOT NULL,\n",
            "    CONSTRAINT \"people_pkey\" PRIMARY KEY (id)\n);"
        )
    );
    let film = metadata
        .resolve("film")
        .await
        .expect("search path")
        .expect("film");
    assert!(
        metadata
            .table_detail(&film)
            .await
            .expect("film detail")
            .referenced_by
            .len()
            >= 2
    );
    assert!(
        !metadata
            .objects("public", &[ObjectKind::View])
            .await
            .expect("views")
            .is_empty()
    );

    let first = app
        .open_session(&profile, &secret)
        .await
        .expect("first tab");
    let second = app
        .open_session(&profile, &secret)
        .await
        .expect("second tab");
    app.run(first, "CREATE TEMP TABLE only_in_tab (id int)")
        .await
        .expect("create temp table");
    app.run(first, "INSERT INTO only_in_tab VALUES (3)")
        .await
        .expect("insert");
    assert_eq!(
        app.run(first, "SELECT id FROM only_in_tab")
            .await
            .expect("read temp table")
            .rows,
        [vec![Cell::Int(3)]]
    );
    assert!(matches!(
        app.run(second, "SELECT id FROM only_in_tab").await,
        Err(CoreError::Db { .. })
    ));
    let notice = app
        .run(first, "DO $$ BEGIN RAISE NOTICE 'fixture notice'; END $$")
        .await
        .expect("notice");
    assert!(
        notice
            .messages
            .iter()
            .any(|(_, message)| message == "fixture notice")
    );
}

#[tokio::test]
#[ignore = "requires the Compose PostgreSQL fixture and generated CA"]
async fn exercises_tls_and_enforces_read_only_profiles() {
    let (mut profile, secret) = fixture();
    let app = engine(Limits::default());
    for (mode, encrypted) in [
        (TlsMode::Disable, false),
        (TlsMode::Prefer, true),
        (TlsMode::Require, true),
        (TlsMode::VerifyCa, true),
        (TlsMode::VerifyFull, true),
    ] {
        profile.tls.mode = mode;
        let session = app
            .open_session(&profile, &secret)
            .await
            .expect("TLS mode connects");
        let batch = app
            .run(
                session,
                "SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()",
            )
            .await
            .expect("SSL state");
        assert_eq!(batch.rows, [vec![Cell::Bool(encrypted)]], "{mode:?}");
        app.close_session(session).await.expect("close");
    }
    profile.host = "postgres-other-name".into();
    profile.tls.mode = TlsMode::VerifyCa;
    let ca_session = app
        .open_session(&profile, &secret)
        .await
        .expect("verify-ca accepts a different DNS name");
    app.close_session(ca_session).await.expect("close");
    profile.tls.mode = TlsMode::VerifyFull;
    assert!(matches!(
        app.open_session(&profile, &secret).await,
        Err(CoreError::Tls { .. })
    ));

    profile.host = "postgres".into();
    profile.read_only = true;
    let session = app
        .open_session(&profile, &secret)
        .await
        .expect("read-only session");
    assert_eq!(
        app.run(session, "SHOW transaction_read_only")
            .await
            .expect("read-only setting")
            .rows,
        [vec![Cell::Text("on".into())]]
    );
    assert!(matches!(
        app.run(
            session,
            "UPDATE strata_demo.people SET city = 'fixture' WHERE id = 1"
        )
        .await,
        Err(CoreError::ReadOnlyViolation { .. })
    ));
}

#[tokio::test]
#[ignore = "requires the Compose PostgreSQL fixture"]
async fn rolls_back_manual_transactions_and_retains_full_binary_cells() {
    let (profile, secret) = fixture();
    let app = engine(Limits::default());
    let session = app.open_session(&profile, &secret).await.expect("session");
    app.run(session, "CREATE TEMP TABLE manual_rows (id int)")
        .await
        .expect("table");
    app.set_manual_transactions(session, true)
        .await
        .expect("manual mode");
    app.run(session, "INSERT INTO manual_rows VALUES (1)")
        .await
        .expect("insert");
    assert!(
        app.transaction_open(session)
            .await
            .expect("active transaction")
    );
    assert!(
        app.run(session, "SELECT bad_column FROM manual_rows")
            .await
            .is_err()
    );
    assert!(app.commit(session).await.is_err());
    app.rollback(session).await.expect("rollback");
    let count = app
        .run(session, "SELECT count(*) FROM manual_rows")
        .await
        .expect("count");
    assert_eq!(count.rows, [vec![Cell::Int(0)]]);
    app.commit(session)
        .await
        .expect("commit successful transaction");
    assert!(
        !app.transaction_open(session)
            .await
            .expect("transaction closed")
    );

    let binary = app
        .run(session, "SELECT decode(repeat('ff', 80), 'hex')")
        .await
        .expect("binary");
    assert_eq!(
        binary.rows[0][0],
        Cell::Text(format!("0x{}… (80 bytes)", "ff".repeat(64)))
    );
    assert_eq!(
        app.get_cell(session, binary.cursor, 0, 0)
            .await
            .expect("full bytes"),
        Cell::Text(format!("0x{}", "ff".repeat(80)))
    );
}

#[tokio::test]
#[ignore = "requires the Compose PostgreSQL fixture"]
async fn sets_default_schema_for_unqualified_queries_including_read_only() {
    let (mut profile, secret) = fixture();
    profile.read_only = true;
    let app = engine(Limits::default());
    let session = app.open_session(&profile, &secret).await.expect("session");
    assert_eq!(
        app.set_schema(session, "strata_demo")
            .await
            .expect("set schema")
            .as_deref(),
        Some("strata_demo")
    );
    assert!(
        app.resolution_path(session)
            .await
            .expect("resolution path")
            .contains(&"strata_demo".to_owned())
    );
    let batch = app
        .run(session, "SELECT count(*) FROM people")
        .await
        .expect("query unqualified table in selected schema");
    assert_eq!(batch.rows, [vec![Cell::Int(1_000_000)]]);
    assert!(app.set_schema(session, "missing_schema_xyz").await.is_err());
    app.close_session(session).await.expect("close");
}
