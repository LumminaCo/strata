use async_trait::async_trait;
use deadpool_postgres::{Pool, PoolError};
use strata_core::{
    CoreError, Definition, Introspector, Object, ObjectKind, Result, TableColumn, TableDetail,
};
use tokio_postgres::Row;

use crate::{connection_error, query_error};

pub(crate) struct Catalog {
    pub pool: Pool,
}

impl Catalog {
    async fn client(&self) -> Result<deadpool_postgres::Object> {
        self.pool.get().await.map_err(|error| match error {
            PoolError::Backend(error) => connection_error(error),
            PoolError::Timeout(_) => CoreError::Timeout,
            _ => CoreError::Connect {
                message: "PostgreSQL metadata connection is unavailable".into(),
            },
        })
    }
}

#[async_trait]
impl Introspector for Catalog {
    async fn databases(&self) -> Result<Vec<String>> {
        let client = self.client().await?;
        let rows = client
            .query(include_str!("queries/databases.sql"), &[])
            .await
            .map_err(query_error)?;
        rows.iter()
            .map(|row| row.try_get(0).map_err(query_error))
            .collect()
    }

    async fn schemas(&self, include_system: bool) -> Result<Vec<String>> {
        let client = self.client().await?;
        let rows = client
            .query(include_str!("queries/schemas.sql"), &[&include_system])
            .await
            .map_err(query_error)?;
        rows.iter()
            .map(|row| row.try_get(0).map_err(query_error))
            .collect()
    }

    async fn objects(&self, schema: &str, kinds: &[ObjectKind]) -> Result<Vec<Object>> {
        let client = self.client().await?;
        let rows = client
            .query(include_str!("queries/objects.sql"), &[&schema])
            .await
            .map_err(query_error)?;
        let objects = rows.iter().map(object).collect::<Result<Vec<_>>>()?;
        Ok(objects
            .into_iter()
            .filter(|object| kinds.is_empty() || kinds.contains(&object.kind))
            .collect())
    }

    async fn table_detail(&self, object: &Object) -> Result<TableDetail> {
        let mut client = self.client().await?;
        let tx = client
            .build_transaction()
            .read_only(true)
            .isolation_level(tokio_postgres::IsolationLevel::RepeatableRead)
            .start()
            .await
            .map_err(query_error)?;
        let id = object.oid;
        let columns = tx
            .query(include_str!("queries/columns.sql"), &[&id])
            .await
            .map_err(query_error)?;
        let columns = columns
            .iter()
            .map(|row| {
                Ok(TableColumn {
                    name: row.try_get(0).map_err(query_error)?,
                    db_type: row.try_get(1).map_err(query_error)?,
                    nullable: row.try_get(2).map_err(query_error)?,
                    default: row.try_get(3).map_err(query_error)?,
                    identity: row.try_get(4).map_err(query_error)?,
                    generated: row.try_get(5).map_err(query_error)?,
                    comment: row.try_get(6).map_err(query_error)?,
                })
            })
            .collect::<Result<Vec<_>>>()?;
        let constraints = definitions(
            tx.query(include_str!("queries/constraints.sql"), &[&id])
                .await
                .map_err(query_error)?,
        )?;
        let indexes = definitions(
            tx.query(include_str!("queries/indexes.sql"), &[&id])
                .await
                .map_err(query_error)?,
        )?;
        let referenced_by = definitions(
            tx.query(include_str!("queries/references.sql"), &[&id])
                .await
                .map_err(query_error)?,
        )?;
        let size_bytes = tx
            .query_one(include_str!("queries/table_size.sql"), &[&id])
            .await
            .map_err(query_error)?
            .try_get::<_, Option<i64>>(0)
            .map_err(query_error)?
            .ok_or_else(|| CoreError::config("The relation no longer exists"))?;
        tx.commit().await.map_err(query_error)?;
        Ok(TableDetail {
            columns,
            constraints,
            indexes,
            referenced_by,
            size_bytes,
        })
    }

    async fn ddl(&self, object: &Object) -> Result<String> {
        use ObjectKind::*;
        let name = format!("{}.{}", quote(&object.schema), quote(&object.name));
        let id = object.oid;
        match object.kind {
            Function | Procedure => {
                let client = self.client().await?;
                client
                    .query_one(include_str!("queries/routine_ddl.sql"), &[&id])
                    .await
                    .map_err(query_error)?
                    .try_get(0)
                    .map_err(query_error)
            }
            View | MaterializedView => {
                let client = self.client().await?;
                let definition: String = client
                    .query_one(include_str!("queries/view_ddl.sql"), &[&id])
                    .await
                    .map_err(query_error)?
                    .try_get(0)
                    .map_err(query_error)?;
                let kind = if object.kind == View {
                    "VIEW"
                } else {
                    "MATERIALIZED VIEW"
                };
                Ok(format!(
                    "CREATE {kind} {name} AS\n{}",
                    definition.trim_end()
                ))
            }
            Sequence => {
                let client = self.client().await?;
                let attributes: String = client
                    .query_one(include_str!("queries/sequence_ddl.sql"), &[&id])
                    .await
                    .map_err(query_error)?
                    .try_get(0)
                    .map_err(query_error)?;
                Ok(format!("CREATE SEQUENCE {name} {attributes};"))
            }
            Table | ForeignTable => {
                let detail = self.table_detail(object).await?;
                let client = self.client().await?;
                let row = client
                    .query_one(include_str!("queries/table_ddl.sql"), &[&id])
                    .await
                    .map_err(query_error)?;
                let suffix: Option<String> = row.try_get(0).map_err(query_error)?;
                let prefix = if object.kind == ForeignTable {
                    "CREATE FOREIGN TABLE"
                } else {
                    "CREATE TABLE"
                };
                let mut entries: Vec<_> = detail.columns.into_iter().map(column_ddl).collect();
                entries.extend(detail.constraints.iter().map(|constraint| {
                    format!(
                        "    CONSTRAINT {} {}",
                        quote(&constraint.name),
                        constraint.sql
                    )
                }));
                let mut ddl = format!(
                    "{prefix} {name} (\n{}\n){};",
                    entries.join(",\n"),
                    suffix.unwrap_or_default()
                );
                let constraint_indexes: Vec<_> = detail
                    .constraints
                    .iter()
                    .filter_map(|constraint| {
                        (constraint.sql.starts_with("PRIMARY KEY")
                            || constraint.sql.starts_with("UNIQUE")
                            || constraint.sql.starts_with("EXCLUDE"))
                        .then_some(constraint.name.as_str())
                    })
                    .collect();
                for index in detail.indexes {
                    if !constraint_indexes.contains(&index.name.as_str()) {
                        ddl.push_str(&format!("\n{};", index.sql));
                    }
                }
                Ok(ddl)
            }
        }
    }

    async fn resolve(&self, identifier: &str) -> Result<Option<Object>> {
        let client = self.client().await?;
        client
            .query_opt(include_str!("queries/resolve.sql"), &[&identifier])
            .await
            .map_err(query_error)?
            .as_ref()
            .map(object)
            .transpose()
    }
}

fn object(row: &Row) -> Result<Object> {
    let raw_kind: String = row.try_get(3).map_err(query_error)?;
    let kind = match raw_kind.as_str() {
        "r" | "p" => ObjectKind::Table,
        "v" => ObjectKind::View,
        "m" => ObjectKind::MaterializedView,
        "f" => ObjectKind::ForeignTable,
        "S" => ObjectKind::Sequence,
        "function" => ObjectKind::Function,
        "procedure" => ObjectKind::Procedure,
        _ => return Err(CoreError::config("Unsupported PostgreSQL object kind")),
    };
    Ok(Object {
        oid: row.try_get(0).map_err(query_error)?,
        schema: row.try_get(1).map_err(query_error)?,
        name: row.try_get(2).map_err(query_error)?,
        kind,
        rows: row.try_get(4).map_err(query_error)?,
        comment: row.try_get(5).map_err(query_error)?,
    })
}

fn definitions(rows: Vec<Row>) -> Result<Vec<Definition>> {
    rows.iter()
        .map(|row| {
            Ok(Definition {
                name: row.try_get(0).map_err(query_error)?,
                sql: row.try_get(1).map_err(query_error)?,
            })
        })
        .collect()
}

fn quote(identifier: &str) -> String {
    format!("\"{}\"", identifier.replace('"', "\"\""))
}

fn column_ddl(column: TableColumn) -> String {
    let mut definition = format!("    {} {}", quote(&column.name), column.db_type);
    match (
        column.identity.as_str(),
        column.generated.as_str(),
        column.default,
    ) {
        ("a", _, _) => definition.push_str(" GENERATED ALWAYS AS IDENTITY"),
        ("d", _, _) => definition.push_str(" GENERATED BY DEFAULT AS IDENTITY"),
        (_, "s", Some(value)) => {
            definition.push_str(&format!(" GENERATED ALWAYS AS ({value}) STORED"))
        }
        (_, _, Some(value)) => definition.push_str(&format!(" DEFAULT {value}")),
        _ => {}
    }
    if !column.nullable {
        definition.push_str(" NOT NULL");
    }
    definition
}
