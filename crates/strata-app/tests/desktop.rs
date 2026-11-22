use std::{sync::Mutex, time::Duration};

use serde_json::{Value, json};
use strata_app::{AppService, Command, RunEvent, RunMode, RunRequest, Target, Workspace};
use strata_store::Paths;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

async fn call(app: &AppService, command: Command, lifetime: &CancellationToken) -> Value {
    app.dispatch(command, lifetime.clone())
        .await
        .expect("dispatch")
}

#[tokio::test]
#[ignore = "requires the Compose PostgreSQL fixture"]
async fn desktop_streams_scripts_cancels_and_restores_workspace() {
    assert_eq!(
        std::env::var("STRATA_IT").as_deref(),
        Ok("1"),
        "Use ./x test-int"
    );
    let directory = tempfile::tempdir().expect("isolated Strata home");
    let paths = Paths::under(directory.path().into());
    let app = AppService::at(paths.clone(), false).expect("open desktop service");
    let lifetime = CancellationToken::new();

    let profile = serde_json::from_value(json!({
        "id": null, "name": "Page fixture", "kind": "postgres", "env": "dev", "color": null,
        "folder": null, "host": "postgres", "port": 5432, "database": "pagila", "user": "postgres",
        "secret": "env:POSTGRES_PASSWORD", "readOnly": false, "tls": "prefer",
    }))
    .expect("connection shape");
    let saved = call(
        &app,
        Command::SaveConnection {
            profile,
            password: None,
        },
        &lifetime,
    )
    .await;
    let connection_id = serde_json::from_value(saved["id"].clone()).expect("connection id");
    let session = call(
        &app,
        Command::OpenSession {
            connection_id,
            database: None,
            password: None,
        },
        &lifetime,
    )
    .await;
    let session_id = serde_json::from_value(session["id"].clone()).expect("session id");
    let tab_id = Uuid::now_v7();
    let sql = "SELECT '🪨' AS marker, 9223372036854775807 AS exact;\nSELECT n FROM generate_series(1, 505) n;";
    let workspace = json!({
        "activeTab": tab_id, "tabs": [{"id": tab_id, "connectionId": connection_id, "text": sql}]
    });
    let snapshot: Workspace = serde_json::from_value(workspace.clone()).expect("workspace shape");
    call(
        &app,
        Command::WorkspaceSave {
            workspace: snapshot,
        },
        &lifetime,
    )
    .await;

    let frames = Mutex::new(Vec::new());
    app.run(
        RunRequest {
            run_id: Uuid::now_v7(),
            session_id,
            text: sql.into(),
            target: Target::Cursor { cursor: 0 },
            mode: RunMode::Script,
            confirmed: false,
        },
        |event| {
            frames.lock().unwrap().push(event);
            std::future::ready(true)
        },
    )
    .await
    .expect("stream script");

    let (first, last) = {
        let frames = frames.lock().unwrap();
        let [
            RunEvent::StatementStart { span, .. },
            RunEvent::ResultStart {
                cursor_id: first,
                rows,
                ..
            },
            ..,
        ] = frames.as_slice()
        else {
            panic!("expected the first row with the result header");
        };
        assert_eq!(rows.len(), 1);
        assert_eq!(span[0], 0);
        assert!(
            frames
                .iter()
                .all(|event| !matches!(event, RunEvent::Rows { rows, .. } if rows.len() > 500))
        );
        let [
            ..,
            RunEvent::ResultPaused {
                cursor_id: last,
                fetched: 500,
            },
            RunEvent::Done { statements: 2, .. },
        ] = frames.as_slice()
        else {
            panic!("expected two statements and a paused cursor");
        };
        (*first, *last)
    };

    let exact = call(
        &app,
        Command::GetCell {
            session_id,
            cursor_id: first,
            row: 0,
            column: 1,
        },
        &lifetime,
    )
    .await;
    assert_eq!(exact, json!("9223372036854775807"));
    let page = call(
        &app,
        Command::FetchMore {
            session_id,
            cursor_id: last,
            count: 500,
        },
        &lifetime,
    )
    .await;
    assert_eq!(page["exhausted"], true);
    assert_eq!(page["rows"], json!([[501], [502], [503], [504], [505]]));

    let run_id = Uuid::now_v7();
    // HTTP and WebSocket/Channel delivery can overlap. Stop may arrive before Run.
    call(
        &app,
        Command::Stop {
            session_id,
            run_id: Some(run_id),
        },
        &lifetime,
    )
    .await;
    let stopped = Mutex::new(Vec::new());
    tokio::time::timeout(
        Duration::from_secs(2),
        app.run(
            RunRequest {
                run_id,
                session_id,
                text: "SELECT pg_sleep(30); SELECT 2;".into(),
                target: Target::Cursor { cursor: 0 },
                mode: RunMode::Script,
                confirmed: false,
            },
            |event| {
                stopped.lock().unwrap().push(event);
                std::future::ready(true)
            },
        ),
    )
    .await
    .expect("cancel quickly")
    .expect("complete cancelled run");
    assert!(matches!(
        stopped.lock().unwrap().as_slice(),
        [RunEvent::Error { error, .. }, RunEvent::Done { statements: 0, .. }] if error.kind == "cancelled"
    ));

    lifetime.cancel();
    app.close_disconnected_sessions().await;
    let error = app
        .dispatch(
            Command::GetCell {
                session_id,
                cursor_id: first,
                row: 0,
                column: 0,
            },
            CancellationToken::new(),
        )
        .await
        .expect_err("closing the transport closes its sessions");
    assert_eq!(error.kind, "config");
    drop(app);

    let reopened = AppService::at(paths, false).expect("reopen desktop service");
    let bootstrap = call(
        &reopened,
        Command::WorkspaceBootstrap,
        &CancellationToken::new(),
    )
    .await;
    assert_eq!(bootstrap["workspace"], workspace);
    assert_eq!(bootstrap["connections"][0]["id"], json!(connection_id));
    assert_eq!(bootstrap["settings"]["fetch_size"], 500);
    assert_eq!(
        call(&reopened, Command::WorkspaceLoad, &CancellationToken::new()).await,
        workspace
    );
}
