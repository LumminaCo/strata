use std::collections::{BTreeMap, HashSet};

use async_trait::async_trait;
use serde_json::{Value, json};
use strata_core::{
    CoreError, Definition, Introspector, Object, ObjectKind, ObjectReference, Result, TableColumn,
    TableDetail,
};
use strata_sql::{Dialect, relation_at};
use tokio::sync::Mutex;

use crate::Session;

pub struct Catalog {
    pub session: Mutex<Session>,
    pub service: String,
}

impl Catalog {
    async fn query(&self, sql: &str, bind: &[Value]) -> Result<Vec<Vec<Value>>> {
        self.session.lock().await.query(sql, bind).await
    }

    async fn named(&self, owner: &str, name: Option<&str>) -> Result<Vec<Object>> {
        let rows = self
            .query(
                include_str!("queries/objects.sql"),
                &[json!(owner), json!(name), json!(name)],
            )
            .await?;
        let mut seen = HashSet::new();
        Ok(rows
            .iter()
            .filter_map(|row| object(row))
            .filter(|object| seen.insert(object.name.clone()))
            .collect())
    }

    async fn synonym(&self, schema: &str, name: &str) -> Result<Option<ObjectReference>> {
        let rows = self.query("SELECT table_owner, table_name FROM all_synonyms WHERE owner=:1 AND synonym_name=:2 AND db_link IS NULL",
            &[json!(schema), json!(name)]).await?;
        Ok(rows.first().map(|row| ObjectReference {
            schema: text(row, 0),
            name: text(row, 1),
        }))
    }
}

#[async_trait]
impl Introspector for Catalog {
    async fn databases(&self) -> Result<Vec<String>> {
        Ok(vec![self.service.clone()])
    }

    async fn schemas(&self, include_system: bool) -> Result<Vec<String>> {
        let sql = if include_system {
            "SELECT username FROM all_users ORDER BY username"
        } else {
            "SELECT username FROM all_users WHERE oracle_maintained='N' ORDER BY username"
        };
        let result = self.query(sql, &[]).await;
        let rows = match result {
            Err(CoreError::Db { code, .. }) if code == "ORA-00904" => self.query(
                "SELECT username FROM all_users WHERE username NOT IN ('SYS','SYSTEM','OUTLN','XDB','CTXSYS','MDSYS','ORDSYS','DBSNMP','APEX_PUBLIC_USER','ANONYMOUS','FLOWS_FILES','XS$NULL') AND username NOT LIKE 'APEX_%' ORDER BY username", &[],
            ).await?,
            other => other?,
        };
        Ok(rows.iter().map(|row| text(row, 0)).collect())
    }

    async fn objects(&self, schema: &str, kinds: &[ObjectKind]) -> Result<Vec<Object>> {
        Ok(self
            .named(schema, None)
            .await?
            .into_iter()
            .filter(|object| kinds.is_empty() || kinds.contains(&object.kind))
            .collect())
    }

    async fn column_names(&self, schema: &str) -> Result<BTreeMap<u32, Vec<String>>> {
        let rows = self.query("SELECT o.object_id, c.column_name FROM all_objects o JOIN all_tab_columns c ON c.owner=o.owner AND c.table_name=o.object_name WHERE o.owner=:1 AND o.object_type IN ('TABLE','VIEW','MATERIALIZED VIEW') ORDER BY o.object_id,c.column_id",
            &[json!(schema)]).await?;
        let mut columns = BTreeMap::<_, Vec<_>>::new();
        for row in rows {
            if let Some(oid) = number(&row, 0).and_then(|id| id.try_into().ok()) {
                columns.entry(oid).or_default().push(text(&row, 1));
            }
        }
        Ok(columns)
    }

    async fn table_detail(&self, object: &Object) -> Result<TableDetail> {
        let key = [json!(object.schema), json!(object.name)];
        let columns = self
            .query(include_str!("queries/columns.sql"), &key)
            .await?
            .iter()
            .map(|row| TableColumn {
                name: text(row, 0),
                db_type: text(row, 1),
                nullable: text(row, 2) == "Y",
                default: optional(row, 3),
                identity: String::new(),
                generated: String::new(),
                comment: optional(row, 4),
            })
            .collect();
        let mut constraints: Vec<_> = self
            .query(include_str!("queries/keys.sql"), &key)
            .await?
            .iter()
            .map(|row| Definition {
                name: text(row, 0),
                sql: format!(
                    "{} ({})",
                    if text(row, 1) == "P" {
                        "PRIMARY KEY"
                    } else {
                        "UNIQUE"
                    },
                    text(row, 2)
                ),
                related: None,
            })
            .collect();
        for row in self.query("SELECT constraint_name, search_condition FROM all_constraints WHERE owner=:1 AND table_name=:2 AND constraint_type='C'", &key).await? {
            let predicate = text(&row, 1);
            if !predicate.ends_with(" IS NOT NULL") {
                constraints.push(Definition { name: text(&row, 0), sql: format!("CHECK ({predicate})"), related: None });
            }
        }
        let mut referenced_by = Vec::new();
        for row in self
            .query(
                include_str!("queries/references.sql"),
                &[
                    key[0].clone(),
                    key[1].clone(),
                    key[0].clone(),
                    key[1].clone(),
                ],
            )
            .await?
        {
            let from = ObjectReference {
                schema: text(&row, 1),
                name: text(&row, 2),
            };
            let to = ObjectReference {
                schema: text(&row, 3),
                name: text(&row, 4),
            };
            let delete = text(&row, 7);
            let action = if delete == "NO ACTION" {
                String::new()
            } else {
                format!(" ON DELETE {delete}")
            };
            let sql = format!(
                "FOREIGN KEY ({}) REFERENCES {} ({}){action}",
                text(&row, 5),
                qualified(&to.schema, &to.name),
                text(&row, 6)
            );
            let name = text(&row, 0);
            if from.schema == object.schema && from.name == object.name {
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
        let indexes = self
            .query(include_str!("queries/indexes.sql"), &key)
            .await?
            .iter()
            .map(|row| {
                let name = text(row, 0);
                Definition {
                    sql: format!(
                        "CREATE {}INDEX {} ON {} ({})",
                        if text(row, 1) == "UNIQUE" {
                            "UNIQUE "
                        } else {
                            ""
                        },
                        quote(&name),
                        qualified(&object.schema, &object.name),
                        text(row, 2)
                    ),
                    name,
                    related: None,
                }
            })
            .collect();
        Ok(TableDetail {
            columns,
            constraints,
            indexes,
            referenced_by,
            size_bytes: 0,
        })
    }

    async fn ddl(&self, object: &Object) -> Result<String> {
        let kind = match object.kind {
            ObjectKind::Table => "TABLE",
            ObjectKind::View => "VIEW",
            ObjectKind::MaterializedView => "MATERIALIZED_VIEW",
            ObjectKind::Function => "FUNCTION",
            ObjectKind::Procedure => "PROCEDURE",
            ObjectKind::Sequence => "SEQUENCE",
            ObjectKind::Synonym => "SYNONYM",
            ObjectKind::ForeignTable => {
                return Err(CoreError::config("Oracle does not expose foreign tables"));
            }
        };
        if let Ok(rows) = self
            .query(
                "SELECT DBMS_METADATA.GET_DDL(:1,:2,:3) FROM dual",
                &[json!(kind), json!(object.name), json!(object.schema)],
            )
            .await
            && let Some(ddl) = rows.first().and_then(|row| optional(row, 0))
        {
            return Ok(ddl.trim().into());
        }
        let name = qualified(&object.schema, &object.name);
        let key = [json!(object.schema), json!(object.name)];
        match object.kind {
            ObjectKind::Table => {
                let detail = self.table_detail(object).await?;
                let mut fields: Vec<_> = detail
                    .columns
                    .iter()
                    .map(|column| {
                        format!(
                            "    {} {}{}{}",
                            quote(&column.name),
                            column.db_type,
                            column
                                .default
                                .as_ref()
                                .map_or(String::new(), |value| format!(
                                    " DEFAULT {}",
                                    value.trim()
                                )),
                            if column.nullable { "" } else { " NOT NULL" }
                        )
                    })
                    .collect();
                fields.extend(
                    detail.constraints.iter().map(|entry| {
                        format!("    CONSTRAINT {} {}", quote(&entry.name), entry.sql)
                    }),
                );
                Ok(format!("CREATE TABLE {name} (\n{}\n);", fields.join(",\n")))
            }
            ObjectKind::View | ObjectKind::MaterializedView => {
                let sql = if object.kind == ObjectKind::View {
                    "SELECT text FROM all_views WHERE owner=:1 AND view_name=:2"
                } else {
                    "SELECT query FROM all_mviews WHERE owner=:1 AND mview_name=:2"
                };
                let rows = self.query(sql, &key).await?;
                let definition =
                    rows.first()
                        .and_then(|row| optional(row, 0))
                        .ok_or_else(|| {
                            CoreError::config("Oracle did not expose the view definition")
                        })?;
                Ok(format!(
                    "CREATE {} {name} AS\n{}",
                    kind.replace('_', " "),
                    definition.trim()
                ))
            }
            ObjectKind::Function | ObjectKind::Procedure => {
                let rows = self
                    .query(
                        "SELECT text FROM all_source WHERE owner=:1 AND name=:2 ORDER BY line",
                        &key,
                    )
                    .await?;
                if rows.is_empty() {
                    return Err(CoreError::config(
                        "Oracle did not expose the routine source",
                    ));
                }
                Ok(format!(
                    "CREATE OR REPLACE {}",
                    rows.iter().map(|row| text(row, 0)).collect::<String>()
                ))
            }
            ObjectKind::Sequence => {
                let rows = self.query("SELECT min_value, max_value, increment_by, cycle_flag, cache_size FROM all_sequences WHERE sequence_owner=:1 AND sequence_name=:2", &key).await?;
                let row = rows
                    .first()
                    .ok_or_else(|| CoreError::config("Oracle did not expose the sequence"))?;
                Ok(format!(
                    "CREATE SEQUENCE {name} MINVALUE {} MAXVALUE {} INCREMENT BY {} {} {};",
                    text(row, 0),
                    text(row, 1),
                    text(row, 2),
                    if text(row, 3) == "Y" {
                        "CYCLE"
                    } else {
                        "NOCYCLE"
                    },
                    if text(row, 4) == "0" {
                        "NOCACHE".into()
                    } else {
                        format!("CACHE {}", text(row, 4))
                    }
                ))
            }
            ObjectKind::Synonym => {
                let target = self
                    .synonym(&object.schema, &object.name)
                    .await?
                    .ok_or_else(|| {
                        CoreError::config("Oracle did not expose a local synonym target")
                    })?;
                Ok(format!(
                    "CREATE SYNONYM {name} FOR {};",
                    qualified(&target.schema, &target.name)
                ))
            }
            ObjectKind::ForeignTable => unreachable!(),
        }
    }

    async fn resolve(&self, identifier: &str) -> Result<Option<Object>> {
        let Some(path) = relation_at(identifier, 0, Dialect::Oracle) else {
            return Ok(None);
        };
        let (mut owner, mut name, public) = match path.parts.as_slice() {
            [name] => {
                let schema = self
                    .query(
                        "SELECT SYS_CONTEXT('USERENV','CURRENT_SCHEMA') FROM dual",
                        &[],
                    )
                    .await?;
                let owner = schema.first().map(|row| text(row, 0)).unwrap_or_default();
                (owner, name.clone(), true)
            }
            [owner, name] => (owner.clone(), name.clone(), false),
            _ => return Ok(None),
        };
        for depth in 0..8 {
            let item = self.named(&owner, Some(&name)).await?.into_iter().next();
            if item
                .as_ref()
                .is_some_and(|object| object.kind != ObjectKind::Synonym)
            {
                return Ok(item);
            }
            let mut target = self.synonym(&owner, &name).await?;
            if depth == 0 && target.is_none() && public {
                target = self.synonym("PUBLIC", &name).await?;
            }
            let Some(target) = target else {
                return Ok(item);
            };
            owner = target.schema;
            name = target.name;
        }
        Ok(None)
    }
}

fn object(row: &[Value]) -> Option<Object> {
    let kind = match text(row, 3).as_str() {
        "TABLE" => ObjectKind::Table,
        "VIEW" => ObjectKind::View,
        "MATERIALIZED VIEW" => ObjectKind::MaterializedView,
        "FUNCTION" => ObjectKind::Function,
        "PROCEDURE" => ObjectKind::Procedure,
        "SEQUENCE" => ObjectKind::Sequence,
        "SYNONYM" => ObjectKind::Synonym,
        _ => return None,
    };
    Some(Object {
        oid: number(row, 0)?.try_into().ok()?,
        schema: text(row, 1),
        name: text(row, 2),
        kind,
        rows: number(row, 4),
        comment: optional(row, 5),
    })
}

fn optional(row: &[Value], column: usize) -> Option<String> {
    row.get(column).and_then(|value| match value {
        Value::String(value) => Some(value.clone()),
        Value::Number(value) => Some(value.to_string()),
        _ => None,
    })
}
pub(crate) fn text(row: &[Value], column: usize) -> String {
    optional(row, column).unwrap_or_default()
}
fn number(row: &[Value], column: usize) -> Option<i64> {
    text(row, column).parse().ok()
}
fn quote(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}
fn qualified(schema: &str, name: &str) -> String {
    format!("{}.{}", quote(schema), quote(name))
}
