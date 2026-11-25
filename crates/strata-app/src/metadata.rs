use std::{
    collections::{BTreeMap, HashMap, HashSet},
    sync::Arc,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use strata_core::{Introspector, Object, ObjectKind, ObjectPage, Result, Secret};
use strata_store::Database;
use tokio::sync::{Mutex, OnceCell};
use ts_rs::TS;
use uuid::Uuid;

use crate::engine::{Engine, background_error};

const TTL: Duration = Duration::from_secs(300);
pub const TABLE_PAGE_SIZE: usize = 100;
const NON_TABLE_KINDS: [ObjectKind; 7] = [
    ObjectKind::View,
    ObjectKind::MaterializedView,
    ObjectKind::ForeignTable,
    ObjectKind::Function,
    ObjectKind::Procedure,
    ObjectKind::Sequence,
    ObjectKind::Synonym,
];

#[derive(Clone, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CatalogScope {
    pub connection_id: Uuid,
    pub database: Option<String>,
    pub password: Option<String>,
}

#[derive(Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CatalogSnapshot {
    pub objects: Vec<Object>,
    #[ts(type = "Record<string, string[]>")]
    pub columns: BTreeMap<u32, Vec<String>>,
    #[serde(default)]
    pub has_more_tables: bool,
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
                let snapshot = Arc::new(load_snapshot(catalog.as_ref(), &schema).await?);

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

    #[allow(clippy::too_many_arguments)]
    pub async fn objects_page(
        &self,
        engine: &Engine,
        scope: &CatalogScope,
        schema: &str,
        kinds: &[ObjectKind],
        search: Option<&str>,
        offset: usize,
        limit: usize,
    ) -> Result<ObjectPage> {
        let catalog = self.catalog(engine, scope).await?;
        catalog
            .objects_page(schema, kinds, search, offset, limit)
            .await
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

async fn load_snapshot(catalog: &dyn Introspector, schema: &str) -> Result<CatalogSnapshot> {
    let tables = catalog
        .objects_page(schema, &[ObjectKind::Table], None, 0, TABLE_PAGE_SIZE)
        .await?;
    let others = catalog.objects(schema, &NON_TABLE_KINDS).await?;
    let mv_names: HashSet<&str> = others
        .iter()
        .filter(|object| object.kind == ObjectKind::MaterializedView)
        .map(|object| object.name.as_str())
        .collect();
    let mut objects = tables.objects;
    if !mv_names.is_empty() {
        objects.retain(|object| !mv_names.contains(object.name.as_str()));
    }
    objects.extend(others);
    let columns = catalog
        .columns_for_objects(schema, &objects)
        .await
        .unwrap_or_default();
    Ok(CatalogSnapshot {
        objects,
        columns,
        has_more_tables: tables.has_more,
    })
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

#[cfg(test)]
mod tests {
    use strata_core::{CoreError, TableDetail, async_trait};

    use super::*;

    struct FakeCatalog {
        objects: Vec<Object>,
        fail_columns: bool,
    }

    #[async_trait]
    impl Introspector for FakeCatalog {
        async fn databases(&self) -> Result<Vec<String>> {
            Ok(vec!["ORCL".into()])
        }

        async fn schemas(&self, _include_system: bool) -> Result<Vec<String>> {
            Ok(vec!["SFBZ0800".into()])
        }

        async fn objects(&self, schema: &str, kinds: &[ObjectKind]) -> Result<Vec<Object>> {
            Ok(self
                .objects
                .iter()
                .filter(|object| {
                    object.schema == schema && (kinds.is_empty() || kinds.contains(&object.kind))
                })
                .cloned()
                .collect())
        }

        async fn column_names(&self, _schema: &str) -> Result<BTreeMap<u32, Vec<String>>> {
            if self.fail_columns {
                return Err(CoreError::Timeout);
            }
            let mut map = BTreeMap::new();
            for object in &self.objects {
                if matches!(object.kind, ObjectKind::Table | ObjectKind::View) {
                    map.insert(object.oid, vec!["ID".into()]);
                }
            }
            Ok(map)
        }

        async fn table_detail(&self, _object: &Object) -> Result<TableDetail> {
            Err(CoreError::config("unused"))
        }

        async fn ddl(&self, _object: &Object) -> Result<String> {
            Err(CoreError::config("unused"))
        }

        async fn resolve(&self, _identifier: &str) -> Result<Option<Object>> {
            Ok(None)
        }
    }

    fn make_object(oid: u32, name: &str, kind: ObjectKind) -> Object {
        Object {
            oid,
            schema: "SFBZ0800".into(),
            name: name.into(),
            kind,
            rows: None,
            comment: None,
        }
    }

    #[tokio::test]
    async fn load_snapshot_caps_initial_tables_and_tolerates_column_timeout() {
        let mut objects: Vec<Object> = (1..=125)
            .map(|i| make_object(i, &format!("TBL_{i:03}"), ObjectKind::Table))
            .collect();
        objects.push(make_object(500, "TBL_001", ObjectKind::MaterializedView));
        objects.push(make_object(501, "SP_REPORT", ObjectKind::Procedure));
        objects.push(make_object(502, "V_SUMMARY", ObjectKind::View));

        let catalog = FakeCatalog {
            objects,
            fail_columns: true,
        };
        let snapshot = load_snapshot(&catalog, "SFBZ0800")
            .await
            .expect("load snapshot");

        assert!(snapshot.has_more_tables);
        assert!(snapshot.columns.is_empty());
        let tables: Vec<_> = snapshot
            .objects
            .iter()
            .filter(|object| object.kind == ObjectKind::Table)
            .collect();
        // 100 initial tables minus 1 deduplicated materialized-view container table.
        assert_eq!(tables.len(), 99);
        assert!(
            snapshot
                .objects
                .iter()
                .any(|object| object.kind == ObjectKind::Procedure && object.name == "SP_REPORT")
        );
        assert!(
            snapshot
                .objects
                .iter()
                .any(|object| object.kind == ObjectKind::View && object.name == "V_SUMMARY")
        );

        let page2 = catalog
            .objects_page("SFBZ0800", &[ObjectKind::Table], None, 100, 100)
            .await
            .expect("second page");
        assert_eq!(page2.objects.len(), 25);
        assert!(!page2.has_more);

        let filtered = catalog
            .objects_page("SFBZ0800", &[ObjectKind::Table], Some("tbl_12"), 0, 100)
            .await
            .expect("filtered tables");
        assert_eq!(filtered.objects.len(), 6);
        assert!(!filtered.has_more);
    }

    #[tokio::test]
    async fn load_snapshot_marks_small_schema_complete_and_loads_columns() {
        let catalog = FakeCatalog {
            objects: vec![
                make_object(1, "USERS", ObjectKind::Table),
                make_object(2, "SP_SYNC", ObjectKind::Procedure),
            ],
            fail_columns: false,
        };
        let snapshot = load_snapshot(&catalog, "SFBZ0800")
            .await
            .expect("load small snapshot");
        assert!(!snapshot.has_more_tables);
        assert_eq!(snapshot.objects.len(), 2);
        assert_eq!(snapshot.columns.get(&1), Some(&vec!["ID".to_owned()]));
    }
}
