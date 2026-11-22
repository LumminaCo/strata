use std::collections::BTreeMap;

use async_trait::async_trait;
use strata_core::{
    CoreError, Definition, Introspector, Object, ObjectKind, ObjectReference, Result, TableColumn,
    TableDetail,
};
use tiberius::{Config, Row, ToSql};
use tokio::sync::Mutex;

use crate::{TdsClient, open, query_error, values::text};

pub struct Catalog {
    pub config: Config,
    pub client: Mutex<Option<TdsClient>>,
}

impl Catalog {
    async fn query(&self, sql: &str, args: &[&dyn ToSql]) -> Result<Vec<Row>> {
        let mut lock = self.client.lock().await;
        if lock.is_none() {
            *lock = Some(open(&self.config).await?);
        }
        let client = lock
            .as_mut()
            .ok_or_else(|| CoreError::config("SQL Server catalog connection is unavailable"))?;
        let result = async { client.query(sql, args).await?.into_first_result().await }
            .await
            .map_err(query_error);
        if matches!(result, Err(CoreError::Connect { .. })) {
            *lock = None;
        }
        result
    }
}

#[async_trait]
impl Introspector for Catalog {
    async fn databases(&self) -> Result<Vec<String>> {
        self.query("SELECT name FROM sys.databases WHERE state = 0 AND HAS_DBACCESS(name) = 1 ORDER BY name", &[])
            .await?.iter().map(|row| text(row, 0)).collect()
    }

    async fn schemas(&self, include_system: bool) -> Result<Vec<String>> {
        self.query("SELECT name FROM sys.schemas WHERE @P1 = 1 OR (name NOT IN ('sys','INFORMATION_SCHEMA','guest') AND LEFT(name, 3) <> 'db_') ORDER BY name", &[&include_system])
            .await?.iter().map(|row| text(row, 0)).collect()
    }

    async fn objects(&self, schema: &str, kinds: &[ObjectKind]) -> Result<Vec<Object>> {
        self.query(include_str!("queries/objects.sql"), &[&schema, &""])
            .await?
            .iter()
            .map(object)
            .filter(|item| {
                item.as_ref().is_err()
                    || item
                        .as_ref()
                        .is_ok_and(|object| kinds.is_empty() || kinds.contains(&object.kind))
            })
            .collect()
    }

    async fn column_names(&self, schema: &str) -> Result<BTreeMap<u32, Vec<String>>> {
        let rows = self.query("SELECT c.object_id, c.name FROM sys.columns c JOIN sys.objects o ON c.object_id=o.object_id JOIN sys.schemas s ON s.schema_id=o.schema_id WHERE s.name=@P1 ORDER BY c.object_id, c.column_id", &[&schema]).await?;
        let mut names = BTreeMap::<_, Vec<_>>::new();
        for row in rows {
            names
                .entry(int(&row, 0)? as u32)
                .or_default()
                .push(text(&row, 1)?);
        }
        Ok(names)
    }

    async fn table_detail(&self, object: &Object) -> Result<TableDetail> {
        let id = object.oid as i32;
        let columns = self
            .query(include_str!("queries/columns.sql"), &[&id])
            .await?
            .iter()
            .map(|row| {
                Ok(TableColumn {
                    name: text(row, 0)?,
                    db_type: text(row, 1)?,
                    nullable: boolean(row, 2)?,
                    default: optional(row, 3)?,
                    identity: if boolean(row, 4)? {
                        "a".into()
                    } else {
                        String::new()
                    },
                    generated: if boolean(row, 5)? {
                        "s".into()
                    } else {
                        String::new()
                    },
                    comment: optional(row, 6)?,
                })
            })
            .collect::<Result<_>>()?;
        let mut constraints = Vec::new();
        let mut indexes = Vec::new();
        for row in self
            .query(include_str!("queries/indexes.sql"), &[&id])
            .await?
        {
            let definition = Definition {
                name: text(&row, 0)?,
                sql: text(&row, 1)?,
                related: None,
            };
            if boolean(&row, 2)? || boolean(&row, 3)? {
                constraints.push(definition);
            } else {
                indexes.push(definition);
            }
        }
        for row in self.query("SELECT name, definition FROM sys.check_constraints WHERE parent_object_id=@P1 ORDER BY name", &[&id]).await? {
            constraints.push(Definition { name: text(&row, 0)?, sql: format!("CHECK {}", text(&row, 1)?), related: None });
        }
        let mut referenced_by = Vec::new();
        for row in self
            .query(include_str!("queries/references.sql"), &[&id])
            .await?
        {
            let from = ObjectReference {
                schema: text(&row, 1)?,
                name: text(&row, 2)?,
            };
            let to = ObjectReference {
                schema: text(&row, 3)?,
                name: text(&row, 4)?,
            };
            let sql = format!(
                "FOREIGN KEY ({}) REFERENCES {} ({}) ON DELETE {} ON UPDATE {}",
                text(&row, 5)?,
                qualified(&to.schema, &to.name),
                text(&row, 6)?,
                text(&row, 7)?.replace('_', " "),
                text(&row, 8)?.replace('_', " ")
            );
            let name = text(&row, 0)?;
            if int(&row, 9)? == id {
                constraints.push(Definition {
                    name: name.clone(),
                    sql: sql.clone(),
                    related: Some(to.clone()),
                });
            }
            if to.schema == object.schema && to.name == object.name {
                referenced_by.push(Definition {
                    name,
                    sql,
                    related: Some(from),
                });
            }
        }
        let size_bytes = self.query("SELECT COALESCE(SUM(CONVERT(bigint, a.total_pages)) * 8192, 0) FROM sys.allocation_units a JOIN sys.partitions p ON a.container_id = p.hobt_id WHERE p.object_id=@P1", &[&id])
            .await?.first().and_then(|row| row.get::<i64, _>(0)).unwrap_or(0);
        Ok(TableDetail {
            columns,
            constraints,
            indexes,
            referenced_by,
            size_bytes,
        })
    }

    async fn ddl(&self, object: &Object) -> Result<String> {
        let id = object.oid as i32;
        if object.kind != ObjectKind::Table {
            let rows = self.query("SELECT OBJECT_DEFINITION(@P1)", &[&id]).await?;
            return rows
                .first()
                .map(|row| text(row, 0))
                .transpose()?
                .filter(|sql| !sql.is_empty())
                .ok_or_else(|| {
                    CoreError::config("SQL Server did not expose the object's definition")
                });
        }
        let detail = self.table_detail(object).await?;
        let mut entries: Vec<_> = detail
            .columns
            .iter()
            .map(|column| {
                if column.generated == "s" {
                    return format!(
                        "    {} AS {}",
                        quote(&column.name),
                        column.default.as_deref().unwrap_or("NULL")
                    );
                }
                format!(
                    "    {} {}{}{}{}",
                    quote(&column.name),
                    column.db_type,
                    if column.identity.is_empty() {
                        ""
                    } else {
                        " IDENTITY"
                    },
                    if column.nullable {
                        " NULL"
                    } else {
                        " NOT NULL"
                    },
                    column
                        .default
                        .as_ref()
                        .map_or(String::new(), |value| format!(" DEFAULT {value}"))
                )
            })
            .collect();
        entries.extend(
            detail
                .constraints
                .iter()
                .map(|entry| format!("    CONSTRAINT {} {}", quote(&entry.name), entry.sql)),
        );
        let mut sql = format!(
            "CREATE TABLE {} (\n{}\n);",
            qualified(&object.schema, &object.name),
            entries.join(",\n")
        );
        for index in detail.indexes {
            sql.push_str(&format!("\n{};", index.sql));
        }
        Ok(sql)
    }

    async fn resolve(&self, identifier: &str) -> Result<Option<Object>> {
        self.query(include_str!("queries/objects.sql"), &[&"", &identifier])
            .await?
            .first()
            .map(object)
            .transpose()
    }
}

fn object(row: &Row) -> Result<Object> {
    let kind = match text(row, 3)?.as_str() {
        "U" => ObjectKind::Table,
        "V" => ObjectKind::View,
        "P" => ObjectKind::Procedure,
        "FN" | "TF" | "IF" => ObjectKind::Function,
        "SO" => ObjectKind::Sequence,
        _ => return Err(CoreError::config("Unsupported SQL Server object type")),
    };
    Ok(Object {
        oid: int(row, 0)? as u32,
        schema: text(row, 1)?,
        name: text(row, 2)?,
        kind,
        rows: row.try_get(4).map_err(query_error)?,
        comment: optional(row, 5)?,
    })
}

fn quote(name: &str) -> String {
    format!("[{}]", name.replace(']', "]]"))
}
fn qualified(schema: &str, name: &str) -> String {
    format!("{}.{}", quote(schema), quote(name))
}
fn int(row: &Row, column: usize) -> Result<i32> {
    row.try_get(column)
        .map_err(query_error)?
        .ok_or_else(|| CoreError::config("Missing SQL Server catalog identifier"))
}
fn boolean(row: &Row, column: usize) -> Result<bool> {
    Ok(row.try_get(column).map_err(query_error)?.unwrap_or(false))
}
fn optional(row: &Row, column: usize) -> Result<Option<String>> {
    Ok(row
        .try_get::<&str, _>(column)
        .map_err(query_error)?
        .map(str::to_owned))
}
