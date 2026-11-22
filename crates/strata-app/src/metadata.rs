use std::{
    collections::{BTreeMap, HashMap},
    sync::Arc,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use strata_core::{Introspector, Object, Result, Secret};
use strata_store::Database;
use tokio::sync::{Mutex, OnceCell};
use ts_rs::TS;
use uuid::Uuid;

use crate::engine::{Engine, background_error};

const TTL: Duration = Duration::from_secs(300);

#[derive(Clone, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CatalogScope {
    pub connection_id: Uuid,
    pub database: Option<String>,
    pub password: Option<String>,
}

#[derive(Deserialize, Serialize, TS)]
pub struct CatalogSnapshot {
    pub objects: Vec<Object>,
    #[ts(type = "Record<string, string[]>")]
    pub columns: BTreeMap<u32, Vec<String>>,
}

type CatalogKey = (Uuid, String);
type SnapshotKey = (Uuid, String, String);
type CatalogSlot = Arc<OnceCell<Arc<dyn Introspector>>>;
type SnapshotSlot = Arc<OnceCell<Arc<CatalogSnapshot>>>;

#[derive(Default)]
pub struct Metadata {
    catalogs: Mutex<HashMap<CatalogKey, (Instant, CatalogSlot)>>,
    snapshots: Mutex<HashMap<SnapshotKey, (Instant, SnapshotSlot)>>,
    changes: Mutex<()>,
}

impl Metadata {
    pub async fn catalog(
        &self,
        engine: &Engine,
        scope: &CatalogScope,
    ) -> Result<Arc<dyn Introspector>> {
        let database = database(engine, scope)?;
        let slot = {
            let mut catalogs = self.catalogs.lock().await;
            let (_, slot) = catalogs
                .entry((scope.connection_id, database.clone()))
                .and_modify(|entry| {
                    if entry.0.elapsed() >= TTL {
                        *entry = (Instant::now(), Arc::default());
                    }
                })
                .or_insert_with(|| (Instant::now(), Arc::default()));
            slot.clone()
        };
        let catalog = slot
            .get_or_try_init(|| async {
                let password = scope.password.clone().map(Secret::new);
                engine
                    .introspector_in(scope.connection_id, Some(&database), password)
                    .await
                    .map(Arc::from)
            })
            .await?;
        Ok(catalog.clone())
    }

    pub async fn snapshot(
        &self,
        engine: &Engine,
        scope: &CatalogScope,
        schema: String,
    ) -> Result<Arc<CatalogSnapshot>> {
        let database = database(engine, scope)?;
        let slot = {
            let mut snapshots = self.snapshots.lock().await;
            let (_, slot) = snapshots
                .entry((scope.connection_id, database.clone(), schema.clone()))
                .and_modify(|entry| {
                    if entry.0.elapsed() >= TTL {
                        *entry = (Instant::now(), Arc::default());
                    }
                })
                .or_insert_with(|| (Instant::now(), Arc::default()));
            slot.clone()
        };
        let snapshot = slot
            .get_or_try_init(|| async {
                let path = engine.paths.database.clone();
                let key = (
                    scope.connection_id.to_string(),
                    database.clone(),
                    schema.clone(),
                );
                let lookup = key.clone();
                let saved = tokio::task::spawn_blocking(move || {
                    Database::open(&path)?.catalog(
                        &lookup.0,
                        &lookup.1,
                        &lookup.2,
                        now_ms() - TTL.as_millis() as i64,
                    )
                })
                .await
                .map_err(background_error)??;
                if let Some(snapshot) =
                    saved.and_then(|payload| serde_json::from_str(&payload).ok())
                {
                    return Ok(Arc::new(snapshot));
                }
                let catalog = self.catalog(engine, scope).await?;
                let (objects, columns) =
                    tokio::try_join!(catalog.objects(&schema, &[]), catalog.column_names(&schema))?;
                let snapshot = Arc::new(CatalogSnapshot { objects, columns });

                // Serialize writes against invalidation. A load that raced a refresh may still
                // finish for its requester, but the old snapshot is never put back in the cache.
                let _changes = self.changes.lock().await;
                let current = self
                    .snapshots
                    .lock()
                    .await
                    .get(&(scope.connection_id, database, schema))
                    .is_some_and(|(_, current)| Arc::ptr_eq(&slot, current));
                if current && let Ok(payload) = serde_json::to_string(snapshot.as_ref()) {
                    let path = engine.paths.database.clone();
                    tokio::task::spawn_blocking(move || {
                        Database::open(&path)?.save_catalog(
                            &key.0,
                            &key.1,
                            &key.2,
                            &payload,
                            now_ms(),
                        )
                    })
                    .await
                    .map_err(background_error)??;
                }
                Ok::<_, strata_core::CoreError>(snapshot)
            })
            .await?;
        Ok(snapshot.clone())
    }

    pub async fn invalidate(&self, engine: &Engine, connection_id: Uuid) -> Result<()> {
        let _changes = self.changes.lock().await;
        self.snapshots
            .lock()
            .await
            .retain(|key, _| key.0 != connection_id);
        self.catalogs
            .lock()
            .await
            .retain(|key, _| key.0 != connection_id);
        let path = engine.paths.database.clone();
        tokio::task::spawn_blocking(move || {
            Database::open(&path)?.clear_catalog(&connection_id.to_string())
        })
        .await
        .map_err(background_error)?
    }
}

pub(crate) fn database(engine: &Engine, scope: &CatalogScope) -> Result<String> {
    let profile = engine.profile(scope.connection_id)?;
    Ok(scope.database.clone().unwrap_or(profile.database))
}

pub(crate) fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |time| time.as_millis() as i64)
}
