use std::fs;

use strata_core::{CoreError, Profile, Secret};
use strata_store::{ConfigStore, Database, HistoryEntry, HistoryStatus, Keychain, Paths, Source};

const PROFILE: &str = r#"
id = "0193a0c2-5555-7000-8000-999999999999"
name = "Pagila"
kind = "postgres"
host = "postgres"
port = 5432
database = "pagila"
user = "postgres"
secret = "prompt"
"#;

fn profile() -> Profile {
    toml::from_str(PROFILE).expect("profile")
}

#[test]
fn profile_and_settings_edits_preserve_comments_and_reject_duplicates() {
    let directory = tempfile::tempdir().expect("tempdir");
    let paths = Paths::under(directory.path().into());
    let store = ConfigStore::new(paths.config.clone());
    assert!(store.load().expect("fresh config").connections.is_empty());
    let mut profile = profile();
    store.save_profile(&profile).expect("save profile");
    let initial = fs::read_to_string(&paths.config).expect("read config");
    let commented = format!(
        "# Profile comments\n{}",
        initial.replace("port = 5432", "port = 5432 # local tunnel")
    );
    fs::write(&paths.config, &commented).expect("commented config");
    profile.port = 15432;
    store.save_profile(&profile).expect("update profile");
    let updated = fs::read_to_string(&paths.config).expect("updated");
    assert!(updated.starts_with("# Profile comments"));
    assert!(updated.contains("port = 15432 # local tunnel"));
    let mut settings = store.load().expect("load").settings;
    settings.fetch_size = 75;
    store.save_settings(&settings).expect("save settings");
    assert_eq!(store.load().expect("round trip").settings.fetch_size, 75);

    let mut duplicate = profile.clone();
    duplicate.id = "0193a0c2-5555-7000-8000-999999999998"
        .parse()
        .expect("second ID");
    assert!(matches!(
        store.save_profile(&duplicate),
        Err(CoreError::Config { .. })
    ));
    assert_eq!(store.load().expect("original remains").connections.len(), 1);
    store
        .delete_profile(&profile.id.to_string())
        .expect("delete");
    assert!(
        store
            .load()
            .expect("empty profile list")
            .connections
            .is_empty()
    );
}

#[test]
fn invalid_secret_values_are_never_persisted_or_displayed() {
    let directory = tempfile::tempdir().expect("tempdir");
    let paths = Paths::under(directory.path().into());
    let store = ConfigStore::new(paths.config.clone());
    let mut profile = profile();
    let sample = "example-password";
    let secret = Secret::new(sample.into());
    assert_eq!(format!("{secret} {secret:?}"), "[redacted] [redacted]");
    assert!(Keychain::resolve(&profile, None).is_err());
    assert_eq!(
        Keychain::resolve(&profile, Some(secret))
            .expect("prompted value")
            .expose(),
        sample
    );
    profile.secret = sample.into();
    assert!(store.save_profile(&profile).is_err());
    assert!(!paths.config.exists());
    fs::write(
        &paths.config,
        format!("version = 1\npassword = \"{sample}\""),
    )
    .expect("invalid external edit");
    assert!(
        !store
            .load()
            .expect_err("invalid config")
            .to_string()
            .contains(sample)
    );
}

#[test]
fn sqlite_migrations_are_repeatable_and_history_prunes_per_connection() {
    let directory = tempfile::tempdir().expect("tempdir");
    let paths = Paths::under(directory.path().into());
    let mut db = Database::open(&paths.database).expect("open");
    let mut entry = HistoryEntry {
        connection_id: "one".into(),
        source: Source::Ui,
        sql: "SELECT 1".into(),
        started_at: 0,
        duration_ms: 2,
        rows: 1,
        status: HistoryStatus::Ok,
        error: None,
    };
    rusqlite::Connection::open(&paths.database).expect("bulk fixture").execute_batch(
         "WITH RECURSIVE n(value) AS (SELECT 0 UNION ALL SELECT value + 1 FROM n WHERE value < 9999)
          INSERT INTO history (conn_id, source, sql, started_at, duration_ms, rows, status)
          SELECT 'one', 'ui', 'SELECT 1', value, 2, 1, 'ok' FROM n;"
    ).expect("seed history");
    for timestamp in 10_000..10_004 {
        entry.started_at = timestamp;
        db.record_history(&entry).expect("record");
    }
    entry.connection_id = "two".into();
    db.record_history(&entry).expect("other connection");
    drop(db);

    let reader = Database::open(&paths.database).expect("open existing");
    let history = reader.history("one", 10_004).expect("history");
    assert_eq!(history.len(), 10_000);
    assert_eq!(history.first().expect("newest").started_at, 10_003);
    assert_eq!(history.last().expect("oldest retained").started_at, 4);
    assert_eq!(reader.history("two", 10).expect("other history"), [entry]);
}

#[tokio::test]
async fn watcher_keeps_last_good_config_after_an_invalid_edit() {
    let directory = tempfile::tempdir().expect("tempdir");
    let paths = Paths::under(directory.path().into());
    let store = ConfigStore::new(paths.config.clone());
    store.save_profile(&profile()).expect("initial config");
    let watched = store.watch().expect("watch config");
    let mut updates = watched.updates();
    fs::write(&paths.config, "version = invalid").expect("external edit");
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while updates.borrow().error.is_none() {
            updates.changed().await.expect("watch still active");
        }
    })
    .await
    .expect("invalid edit reported");
    assert_eq!(updates.borrow().config.connections[0].name, "Pagila");
    fs::write(&paths.config, "version = 1\n").expect("repaired config");
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while updates.borrow().error.is_some() {
            updates.changed().await.expect("watch still active");
        }
    })
    .await
    .expect("valid edit reported");
    assert!(updates.borrow().config.connections.is_empty());
}
