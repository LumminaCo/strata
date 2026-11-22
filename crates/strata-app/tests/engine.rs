use std::fs;

use strata_app::Engine;
use strata_core::Cell;
use strata_store::{HistoryEntry, HistoryStatus, Paths, Source};
use uuid::Uuid;

#[tokio::test]
#[ignore = "requires the Compose PostgreSQL fixture"]
async fn opens_a_saved_profile_and_persists_its_history() {
    assert_eq!(
        std::env::var("STRATA_IT").as_deref(),
        Ok("1"),
        "Use ./x test-int"
    );
    let directory = tempfile::tempdir().expect("isolated Strata home");
    let paths = Paths::under(directory.path().into());
    let id = Uuid::now_v7();
    let configuration = format!(
        r#"
version = 1

[settings]
fetch_size = 20

[[connection]]
id = "{id}"
name = "Pagila fixture"
kind = "postgres"
host = "postgres"
port = 5432
database = "pagila"
user = "postgres"
secret = "env:POSTGRES_PASSWORD"
"#
    );
    fs::write(&paths.config, configuration).expect("write fixture config");
    let app = Engine::open(paths.clone()).expect("open engine");
    let session = app
        .open_session(id, None)
        .await
        .expect("open saved profile");
    let sql = "SELECT count(*) FROM strata_demo.people";
    let batch = app.core().run(session, sql).await.expect("execute");
    assert_eq!(batch.rows, [vec![Cell::Int(1_000_000)]]);
    assert!(batch.exhausted);
    app.record_history(HistoryEntry {
        connection_id: id.to_string(),
        source: Source::Ui,
        sql: sql.into(),
        started_at: 0,
        duration_ms: 0,
        rows: 1,
        status: HistoryStatus::Ok,
        error: None,
    })
    .await
    .expect("record");
    app.core().close_session(session).await.expect("close");
    drop(app);

    let reopened = Engine::open(paths).expect("reopen");
    assert_eq!(
        reopened.history(id, 10).await.expect("query history")[0].sql,
        sql
    );
}
