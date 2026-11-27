use serde::Serialize;
use strata_core::{DbKind, Object, ObjectKind, Result, TableDetail};
use strata_sql::{Dialect, relation_at};
use ts_rs::TS;
use uuid::Uuid;

use crate::{AppService, CatalogScope};

#[derive(Serialize, TS)]
pub struct ResolvedObject {
    pub database: String,
    pub object: Object,
    pub column: Option<String>,
}

#[derive(Serialize, TS)]
pub struct ObjectDetails {
    pub detail: Option<TableDetail>,
    pub ddl: String,
}

impl AppService {
    pub(crate) async fn resolve_at(
        &self,
        scope: &CatalogScope,
        session_id: Option<Uuid>,
        schema: Option<&str>,
        text: &str,
        offset: u32,
    ) -> Result<Option<ResolvedObject>> {
        let profile = self.engine.profile(scope.connection_id)?;
        let dialect = dialect(profile.kind);
        let Some(reference) = relation_at(text, offset, dialect) else {
            return Ok(None);
        };
        let mut target = scope.clone();
        let mut parts = reference.parts;
        if parts.len() == 3 && dialect == Dialect::SqlServer {
            target.database = Some(parts.remove(0));
        }
        let catalog = self.metadata.catalog(&self.engine, &target).await?;
        let mut object = None;
        if let [name] = parts.as_slice() {
            if let Some(id) = session_id
                && self
                    .session(id)
                    .await
                    .is_ok_and(|session| session.connection_id == target.connection_id)
            {
                for schema in self
                    .engine
                    .core()
                    .resolution_path(id)
                    .await
                    .unwrap_or_default()
                {
                    object = catalog
                        .resolve(&qualified(&[&schema, name], dialect))
                        .await?;
                    if object.is_some() {
                        break;
                    }
                }
            } else if let Some(schema) = schema.map(str::trim).filter(|value| !value.is_empty()) {
                object = catalog
                    .resolve(&qualified(&[schema, name], dialect))
                    .await?;
            }
        }
        if object.is_none() {
            object = catalog.resolve(&qualified(&parts, dialect)).await?;
        }
        if object.is_none()
            && let [schema, name] = parts.as_slice()
        {
            let snapshot = self
                .metadata
                .snapshot(&self.engine, &target, schema.clone())
                .await?;
            object = snapshot
                .objects
                .iter()
                .find(|object| object.name == *name)
                .cloned();
        }
        let database = strata_engine::database(&self.engine, &target)?;
        Ok(object.map(|object| ResolvedObject {
            database,
            object,
            column: reference.column,
        }))
    }

    pub(crate) async fn object_details(
        &self,
        scope: &CatalogScope,
        object: &Object,
    ) -> Result<ObjectDetails> {
        let catalog = self.metadata.catalog(&self.engine, scope).await?;
        let ddl = catalog.ddl(object);
        let details = async {
            if matches!(
                object.kind,
                ObjectKind::Table
                    | ObjectKind::View
                    | ObjectKind::ForeignTable
                    | ObjectKind::MaterializedView
            ) {
                catalog.table_detail(object).await.map(Some)
            } else {
                Ok(None)
            }
        };
        let (ddl, detail) = tokio::try_join!(ddl, details)?;
        Ok(ObjectDetails { ddl, detail })
    }
}

pub(crate) fn dialect(kind: DbKind) -> Dialect {
    match kind {
        DbKind::Postgres => Dialect::Postgres,
        DbKind::SqlServer => Dialect::SqlServer,
        DbKind::Oracle => Dialect::Oracle,
    }
}

pub(crate) fn qualified(parts: &[impl AsRef<str>], dialect: Dialect) -> String {
    parts
        .iter()
        .map(|part| {
            let name = part.as_ref();
            if dialect == Dialect::SqlServer {
                format!("[{}]", name.replace(']', "]]"))
            } else {
                format!("\"{}\"", name.replace('"', "\"\""))
            }
        })
        .collect::<Vec<_>>()
        .join(".")
}
