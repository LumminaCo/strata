use std::collections::BTreeMap;

use async_trait::async_trait;
use deadpool_postgres::{Pool, PoolError};
use strata_core::{
    CoreError, Definition, Introspector, Object, ObjectKind, ObjectKindCount, ObjectPage,
    ObjectReference, Result, TableColumn, TableDetail,
};
use tokio_postgres::{Row, types::ToSql};

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

    async fn object_counts(&self, schema: &str) -> Result<Vec<ObjectKindCount>> {
        let client = self.client().await?;
        let rows = client
            .query(include_str!("queries/object_counts.sql"), &[&schema])
            .await
            .map_err(query_error)?;
        let mut counts = BTreeMap::new();
        for row in rows {
            let raw_kind: String = row.try_get(0).map_err(query_error)?;
            let raw_count: i64 = row.try_get(1).map_err(query_error)?;
            let Some(kind) = parse_count_kind(&raw_kind) else {
                continue;
            };
            if let Ok(count) = usize::try_from(raw_count)
                && count > 0
            {
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
        let search = search.map(str::trim).filter(|value| !value.is_empty());
        let Some(sql) = objects_page_sql(kinds, search.is_some()) else {
            return Ok(ObjectPage::default());
        };
        let client = self.client().await?;
        let limit_plus_one = limit.saturating_add(1) as i64;
        let offset_i64 = offset as i64;
        let pattern = search.map(like_pattern);
        let mut params: Vec<&(dyn ToSql + Sync)> = vec![&schema];
        if let Some(pattern) = &pattern {
            params.push(pattern);
        }
        params.push(&limit_plus_one);
        params.push(&offset_i64);
        let rows = client.query(&sql, &params).await.map_err(query_error)?;
        let mut objects = rows.iter().map(object).collect::<Result<Vec<_>>>()?;
        let has_more = objects.len() > limit;
        objects.truncate(limit);
        Ok(ObjectPage { objects, has_more })
    }

    async fn column_names(
        &self,
        schema: &str,
    ) -> Result<std::collections::BTreeMap<u32, Vec<String>>> {
        let client = self.client().await?;
        let rows = client
            .query(include_str!("queries/completion_columns.sql"), &[&schema])
            .await
            .map_err(query_error)?;
        let mut columns = std::collections::BTreeMap::<_, Vec<_>>::new();
        for row in rows {
            let oid: u32 = row.try_get(0).map_err(query_error)?;
            columns
                .entry(oid)
                .or_default()
                .push(row.try_get(1).map_err(query_error)?);
        }
        Ok(columns)
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
            Synonym => Err(CoreError::config("PostgreSQL does not expose synonyms")),
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

fn parse_count_kind(raw: &str) -> Option<ObjectKind> {
    match raw {
        "table" => Some(ObjectKind::Table),
        "view" => Some(ObjectKind::View),
        "materialized_view" => Some(ObjectKind::MaterializedView),
        "foreign_table" => Some(ObjectKind::ForeignTable),
        "sequence" => Some(ObjectKind::Sequence),
        "function" => Some(ObjectKind::Function),
        "procedure" => Some(ObjectKind::Procedure),
        _ => None,
    }
}

fn like_pattern(search: &str) -> String {
    let mut pattern = String::with_capacity(search.len() + 2);
    pattern.push('%');
    for ch in search.chars() {
        if matches!(ch, '\\' | '%' | '_') {
            pattern.push('\\');
        }
        pattern.push(ch);
    }
    pattern.push('%');
    pattern
}

fn objects_page_sql(kinds: &[ObjectKind], has_search: bool) -> Option<String> {
    let mut relkinds = Vec::new();
    let mut prokinds = Vec::new();
    if kinds.is_empty() {
        relkinds.extend(["'r'", "'p'", "'v'", "'m'", "'f'", "'S'"]);
        prokinds.extend(["'f'", "'p'"]);
    } else {
        for kind in kinds {
            match kind {
                ObjectKind::Table => {
                    for literal in ["'r'", "'p'"] {
                        if !relkinds.contains(&literal) {
                            relkinds.push(literal);
                        }
                    }
                }
                ObjectKind::View => {
                    if !relkinds.contains(&"'v'") {
                        relkinds.push("'v'");
                    }
                }
                ObjectKind::MaterializedView => {
                    if !relkinds.contains(&"'m'") {
                        relkinds.push("'m'");
                    }
                }
                ObjectKind::ForeignTable => {
                    if !relkinds.contains(&"'f'") {
                        relkinds.push("'f'");
                    }
                }
                ObjectKind::Sequence => {
                    if !relkinds.contains(&"'S'") {
                        relkinds.push("'S'");
                    }
                }
                ObjectKind::Function => {
                    if !prokinds.contains(&"'f'") {
                        prokinds.push("'f'");
                    }
                }
                ObjectKind::Procedure => {
                    if !prokinds.contains(&"'p'") {
                        prokinds.push("'p'");
                    }
                }
                ObjectKind::Synonym => {}
            }
        }
    }
    if relkinds.is_empty() && prokinds.is_empty() {
        return None;
    }

    let (rel_search, proc_search, limit_bind, offset_bind) = if has_search {
        (
            " AND c.relname ILIKE $2::text ESCAPE '\\'",
            " AND p.proname ILIKE $2::text ESCAPE '\\'",
            "$3::bigint",
            "$4::bigint",
        )
    } else {
        ("", "", "$2::bigint", "$3::bigint")
    };

    let mut branches = Vec::new();
    if !relkinds.is_empty() {
        branches.push(format!(
            "SELECT c.oid, n.nspname::text, c.relname::text, c.relkind::text, \
             CASE WHEN c.reltuples >= 0 AND c.relkind IN ('r', 'p', 'm', 'f') THEN c.reltuples::bigint END AS row_estimate, \
             pg_catalog.obj_description(c.oid, 'pg_class') \
             FROM pg_catalog.pg_class AS c \
             JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace \
             WHERE n.nspname = $1::text AND c.relkind IN ({}){}",
            relkinds.join(", "),
            rel_search
        ));
    }
    if !prokinds.is_empty() {
        branches.push(format!(
            "SELECT p.oid, n.nspname::text, p.proname::text, \
             CASE p.prokind WHEN 'p' THEN 'procedure' ELSE 'function' END, \
             NULL::bigint, pg_catalog.obj_description(p.oid, 'pg_proc') \
             FROM pg_catalog.pg_proc AS p \
             JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace \
             WHERE n.nspname = $1::text AND p.prokind IN ({}){}",
            prokinds.join(", "),
            proc_search
        ));
    }
    Some(format!(
        "{} ORDER BY 3, 4, 1 LIMIT {} OFFSET {}",
        branches.join(" UNION ALL "),
        limit_bind,
        offset_bind
    ))
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
                related: if row.len() > 2 {
                    row.try_get::<_, Option<String>>(2)
                        .map_err(query_error)?
                        .zip(row.try_get::<_, Option<String>>(3).map_err(query_error)?)
                        .map(|(schema, name)| ObjectReference { schema, name })
                } else {
                    None
                },
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn like_pattern_escapes_wildcards() {
        assert_eq!(like_pattern("orders"), "%orders%");
        assert_eq!(like_pattern("pay_100%\\x"), "%pay\\_100\\%\\\\x%");
    }

    #[test]
    fn objects_page_sql_queries_only_requested_catalog_tables() {
        let table_sql = objects_page_sql(&[ObjectKind::Table], false).unwrap();
        assert!(table_sql.contains("FROM pg_catalog.pg_class"));
        assert!(table_sql.contains("c.relkind IN ('r', 'p')"));
        assert!(!table_sql.contains("pg_proc"));
        assert!(table_sql.contains("LIMIT $2::bigint OFFSET $3::bigint"));

        let proc_sql = objects_page_sql(&[ObjectKind::Procedure], true).unwrap();
        assert!(proc_sql.contains("FROM pg_catalog.pg_proc"));
        assert!(proc_sql.contains("p.prokind IN ('p')"));
        assert!(proc_sql.contains("p.proname ILIKE $2::text ESCAPE '\\'"));
        assert!(!proc_sql.contains("pg_class"));
        assert!(proc_sql.contains("LIMIT $3::bigint OFFSET $4::bigint"));

        let mixed_sql =
            objects_page_sql(&[ObjectKind::Table, ObjectKind::Function], false).unwrap();
        assert!(mixed_sql.contains("UNION ALL"));

        assert!(objects_page_sql(&[ObjectKind::Synonym], false).is_none());
    }
}
