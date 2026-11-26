use std::collections::{BTreeMap, HashMap, HashSet};

use async_trait::async_trait;
use serde_json::{Value, json};
use strata_core::{
    CoreError, Definition, ForeignKeyRef, Introspector, Object, ObjectKind, ObjectKindCount,
    ObjectPage, ObjectReference, Result, TableColumn, TableDetail, TableForeignKey,
};
use strata_sql::{Dialect, relation_at};
use tokio::sync::Mutex;

use crate::Session;

const AUTOCOMPLETE_RELATION_LIMIT: usize = 100;
const AUTOCOMPLETE_COLUMNS_TIMEOUT_MS: u32 = 8_000;

pub struct Catalog {
    pub session: Mutex<Session>,
    pub service: String,
}

impl Catalog {
    async fn query(&self, sql: &str, bind: &[Value]) -> Result<Vec<Vec<Value>>> {
        self.session.lock().await.query(sql, bind).await
    }

    async fn query_with_timeout(
        &self,
        sql: &str,
        bind: &[Value],
        timeout_ms: u32,
    ) -> Result<Vec<Vec<Value>>> {
        self.session
            .lock()
            .await
            .query_with_timeout(sql, bind, timeout_ms)
            .await
    }

    async fn named(&self, owner: &str, name: Option<&str>) -> Result<Vec<Object>> {
        let rows = self
            .query(
                include_str!("queries/objects.sql"),
                &[json!(owner), json!(name), json!(name)],
            )
            .await?;
        Ok(dedup_objects(rows))
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
        let Some(sql) = objects_list_sql(kinds) else {
            return Ok(Vec::new());
        };
        let rows = self.query(&sql, &[json!(schema)]).await?;
        Ok(dedup_objects(rows))
    }

    async fn object_counts(&self, schema: &str) -> Result<Vec<ObjectKindCount>> {
        let rows = self.query(object_counts_sql(), &[json!(schema)]).await?;
        let mut counts = BTreeMap::new();
        for row in rows {
            let Some(kind) = parse_oracle_object_kind(&text(&row, 0)) else {
                continue;
            };
            let Some(count) = number(&row, 1).and_then(|value| usize::try_from(value).ok()) else {
                continue;
            };
            if count > 0 {
                *counts.entry(kind).or_insert(0) += count;
            }
        }
        Ok(counts
            .into_iter()
            .map(|(kind, count)| ObjectKindCount { kind, count })
            .collect())
    }

    async fn objects_page(
        &self,
        schema: &str,
        kinds: &[ObjectKind],
        search: Option<&str>,
        offset: usize,
        limit: usize,
    ) -> Result<ObjectPage> {
        if limit == 0 {
            return Ok(ObjectPage::default());
        }
        let Some((sql, bind)) = objects_page_query(schema, kinds, search, offset, limit) else {
            return Ok(ObjectPage::default());
        };
        let rows = self.query(&sql, &bind).await?;
        let mut objects = dedup_objects(rows);
        let has_more = objects.len() > limit;
        objects.truncate(limit);
        Ok(ObjectPage { objects, has_more })
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

    async fn columns_for_objects(
        &self,
        schema: &str,
        objects: &[Object],
    ) -> Result<BTreeMap<u32, Vec<String>>> {
        let mut oids_by_name = HashMap::new();
        let mut table_names = Vec::new();
        for object in objects {
            if !matches!(
                object.kind,
                ObjectKind::Table | ObjectKind::View | ObjectKind::MaterializedView
            ) {
                continue;
            }
            if oids_by_name.contains_key(object.name.as_str()) {
                continue;
            }
            oids_by_name.insert(object.name.as_str(), object.oid);
            table_names.push(object.name.as_str());
            if table_names.len() >= AUTOCOMPLETE_RELATION_LIMIT {
                break;
            }
        }
        if table_names.is_empty() {
            return Ok(BTreeMap::new());
        }
        let (sql, bind) = columns_for_objects_query(schema, &table_names);
        let rows = self
            .query_with_timeout(&sql, &bind, AUTOCOMPLETE_COLUMNS_TIMEOUT_MS)
            .await?;
        let mut columns = BTreeMap::<_, Vec<_>>::new();
        for row in rows {
            let table_name = text(&row, 0);
            if let Some(&oid) = oids_by_name.get(table_name.as_str()) {
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

    async fn foreign_keys(&self, object: &Object) -> Result<Vec<TableForeignKey>> {
        let key = [json!(object.schema), json!(object.name)];
        let rows = self
            .query(include_str!("queries/foreign_keys.sql"), &key)
            .await?;
        let mut seen = HashSet::new();
        let mut keys = Vec::new();
        for row in rows {
            let column = text(&row, 0);
            if column.is_empty() || !seen.insert(column.clone()) {
                continue;
            }
            keys.push(TableForeignKey {
                column,
                target: ForeignKeyRef {
                    schema: text(&row, 1),
                    table: text(&row, 2),
                    column: text(&row, 3),
                },
            });
        }
        Ok(keys)
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

fn dedup_objects(rows: Vec<Vec<Value>>) -> Vec<Object> {
    let mut seen = HashSet::new();
    rows.iter()
        .filter_map(|row| object(row))
        .filter(|object| seen.insert(object.name.clone()))
        .collect()
}

fn oracle_object_types(kinds: &[ObjectKind]) -> Vec<&'static str> {
    if kinds.is_empty() {
        return vec![
            "'TABLE'",
            "'VIEW'",
            "'MATERIALIZED VIEW'",
            "'FUNCTION'",
            "'PROCEDURE'",
            "'SEQUENCE'",
            "'SYNONYM'",
        ];
    }
    let mut types = Vec::new();
    for kind in kinds {
        let literal = match kind {
            ObjectKind::Table => "'TABLE'",
            ObjectKind::View => "'VIEW'",
            ObjectKind::MaterializedView => "'MATERIALIZED VIEW'",
            ObjectKind::Function => "'FUNCTION'",
            ObjectKind::Procedure => "'PROCEDURE'",
            ObjectKind::Sequence => "'SEQUENCE'",
            ObjectKind::Synonym => "'SYNONYM'",
            ObjectKind::ForeignTable => continue,
        };
        if !types.contains(&literal) {
            types.push(literal);
        }
    }
    types
}

fn like_pattern(search: &str) -> String {
    let mut pattern = String::with_capacity(search.len() + 2);
    pattern.push('%');
    for ch in search.chars() {
        if matches!(ch, '\\' | '%' | '_') {
            pattern.push('\\');
        }
        for upper in ch.to_uppercase() {
            pattern.push(upper);
        }
    }
    pattern.push('%');
    pattern
}

fn object_counts_sql() -> &'static str {
    "SELECT object_type, COUNT(*) \
     FROM ( \
       SELECT object_name, \
              MIN(object_type) KEEP (DENSE_RANK FIRST ORDER BY CASE WHEN object_type = 'MATERIALIZED VIEW' THEN 0 ELSE 1 END) AS object_type \
       FROM all_objects \
       WHERE owner = :1 \
         AND object_type IN ('TABLE','VIEW','MATERIALIZED VIEW','FUNCTION','PROCEDURE','SEQUENCE','SYNONYM') \
       GROUP BY object_name \
     ) \
     GROUP BY object_type"
}

fn mv_container_exclusion(kinds: &[ObjectKind]) -> &'static str {
    if kinds.is_empty() || kinds.contains(&ObjectKind::Table) {
        " AND NOT (o.object_type = 'TABLE' AND EXISTS (SELECT 1 FROM all_mviews mv WHERE mv.owner = o.owner AND mv.mview_name = o.object_name))"
    } else {
        ""
    }
}

fn objects_list_sql(kinds: &[ObjectKind]) -> Option<String> {
    let types = oracle_object_types(kinds);
    if types.is_empty() {
        return None;
    }
    Some(format!(
        "SELECT o.object_id, o.owner, o.object_name, o.object_type \
         FROM all_objects o \
         WHERE o.owner = :1 AND o.object_type IN ({}){} \
         ORDER BY o.object_name, CASE WHEN o.object_type = 'MATERIALIZED VIEW' THEN 0 ELSE 1 END",
        types.join(","),
        mv_container_exclusion(kinds)
    ))
}

fn objects_page_query(
    schema: &str,
    kinds: &[ObjectKind],
    search: Option<&str>,
    offset: usize,
    limit: usize,
) -> Option<(String, Vec<Value>)> {
    let types = oracle_object_types(kinds);
    if types.is_empty() {
        return None;
    }
    let search = search.map(str::trim).filter(|value| !value.is_empty());
    let end_row = offset.saturating_add(limit).saturating_add(1) as i64;
    let start_row = offset as i64;
    let mut bind = vec![json!(schema)];
    let (search_clause, end_bind, start_bind) = if let Some(search) = search {
        bind.push(json!(like_pattern(search)));
        bind.push(json!(end_row));
        bind.push(json!(start_row));
        (" AND UPPER(o.object_name) LIKE :2 ESCAPE '\\'", ":3", ":4")
    } else {
        bind.push(json!(end_row));
        bind.push(json!(start_row));
        ("", ":2", ":3")
    };
    let sql = format!(
        "SELECT object_id, owner, object_name, object_type \
         FROM ( \
           SELECT inner_q.object_id, inner_q.owner, inner_q.object_name, inner_q.object_type, ROWNUM AS rn \
           FROM ( \
             SELECT o.object_id, o.owner, o.object_name, o.object_type \
             FROM all_objects o \
             WHERE o.owner = :1 AND o.object_type IN ({}){}{} \
             ORDER BY o.object_name, CASE WHEN o.object_type = 'MATERIALIZED VIEW' THEN 0 ELSE 1 END, o.object_id \
           ) inner_q \
           WHERE ROWNUM <= {} \
         ) \
         WHERE rn > {} \
         ORDER BY rn",
        types.join(","),
        mv_container_exclusion(kinds),
        search_clause,
        end_bind,
        start_bind
    );
    Some((sql, bind))
}

fn columns_for_objects_query(schema: &str, table_names: &[&str]) -> (String, Vec<Value>) {
    let mut bind = Vec::with_capacity(table_names.len() + 1);
    bind.push(json!(schema));
    let mut placeholders = Vec::with_capacity(table_names.len());
    for (index, name) in table_names.iter().enumerate() {
        placeholders.push(format!(":{}", index + 2));
        bind.push(json!(name));
    }
    let sql = format!(
        "SELECT table_name, column_name \
         FROM all_tab_columns \
         WHERE owner = :1 AND table_name IN ({}) \
         ORDER BY table_name, column_id",
        placeholders.join(",")
    );
    (sql, bind)
}

fn parse_oracle_object_kind(raw: &str) -> Option<ObjectKind> {
    match raw {
        "TABLE" => Some(ObjectKind::Table),
        "VIEW" => Some(ObjectKind::View),
        "MATERIALIZED VIEW" => Some(ObjectKind::MaterializedView),
        "FUNCTION" => Some(ObjectKind::Function),
        "PROCEDURE" => Some(ObjectKind::Procedure),
        "SEQUENCE" => Some(ObjectKind::Sequence),
        "SYNONYM" => Some(ObjectKind::Synonym),
        _ => None,
    }
}

fn object(row: &[Value]) -> Option<Object> {
    let kind = parse_oracle_object_kind(text(row, 3).as_str())?;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn like_pattern_escapes_wildcards_and_uppercases() {
        assert_eq!(like_pattern("emp"), "%EMP%");
        assert_eq!(like_pattern("pay_100%\\x"), "%PAY\\_100\\%\\\\X%");
    }

    #[test]
    fn object_counts_sql_aggregates_deduped_objects_without_heavy_joins() {
        let sql = object_counts_sql();
        assert!(sql.contains("FROM all_objects"));
        assert!(sql.contains("GROUP BY object_name"));
        assert!(sql.contains("GROUP BY object_type"));
        assert!(!sql.contains("all_tables"));
        assert!(!sql.contains("all_tab_comments"));
    }

    #[test]
    fn objects_page_query_uses_rownum_without_heavy_joins() {
        let (sql, bind) =
            objects_page_query("SFBZ0800", &[ObjectKind::Table], None, 0, 100).unwrap();
        assert!(sql.contains("FROM all_objects o"));
        assert!(!sql.contains("all_tables"));
        assert!(!sql.contains("all_tab_comments"));
        assert!(sql.contains("o.object_type IN ('TABLE')"));
        assert!(sql.contains("all_mviews"));
        assert!(sql.contains("WHERE ROWNUM <= :2"));
        assert!(sql.contains("WHERE rn > :3"));
        assert_eq!(bind, vec![json!("SFBZ0800"), json!(101), json!(0)]);

        let (view_sql, view_bind) =
            objects_page_query("SFBZ0800", &[ObjectKind::View], None, 0, 100).unwrap();
        assert!(view_sql.contains("o.object_type IN ('VIEW')"));
        assert!(!view_sql.contains("all_mviews"));
        assert_eq!(view_bind, vec![json!("SFBZ0800"), json!(101), json!(0)]);

        let (filtered_sql, filtered_bind) = objects_page_query(
            "SFBZ0800",
            &[ObjectKind::Table, ObjectKind::Procedure],
            Some(" ventas_1 "),
            100,
            100,
        )
        .unwrap();
        assert!(filtered_sql.contains("o.object_type IN ('TABLE','PROCEDURE')"));
        assert!(filtered_sql.contains("UPPER(o.object_name) LIKE :2 ESCAPE '\\'"));
        assert!(filtered_sql.contains("WHERE ROWNUM <= :3"));
        assert!(filtered_sql.contains("WHERE rn > :4"));
        assert_eq!(
            filtered_bind,
            vec![
                json!("SFBZ0800"),
                json!("%VENTAS\\_1%"),
                json!(201),
                json!(100)
            ]
        );

        assert!(
            objects_page_query("SFBZ0800", &[ObjectKind::ForeignTable], None, 0, 100).is_none()
        );
    }

    #[test]
    fn columns_for_objects_query_targets_selected_tables_only() {
        let (sql, bind) = columns_for_objects_query("SFBZ0800", &["T_A", "T_B"]);
        assert!(sql.contains("FROM all_tab_columns"));
        assert!(!sql.contains("all_objects"));
        assert!(sql.contains("WHERE owner = :1 AND table_name IN (:2,:3)"));
        assert_eq!(bind, vec![json!("SFBZ0800"), json!("T_A"), json!("T_B")]);
    }
}
