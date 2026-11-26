use sqlparser::ast::{
    Expr, Ident, ObjectName, SelectItem, SelectItemQualifiedWildcardKind, SetExpr, Statement,
    TableFactor,
};

use crate::{Dialect, agent};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TableSource {
    pub parts: Vec<String>,
    pub alias: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProjectionSource {
    Wildcard,
    QualifiedWildcard(Vec<String>),
    Column {
        qualifier: Option<Vec<String>>,
        column: String,
        output_name: String,
    },
    Other,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct QueryColumnSources {
    pub tables: Vec<TableSource>,
    pub projections: Vec<ProjectionSource>,
}

/// Extract referenced base tables and projected column provenance from a SELECT statement.
pub fn query_column_sources(sql: &str, dialect: Dialect) -> Option<QueryColumnSources> {
    let statements = agent::parse(sql, dialect)?;
    let [Statement::Query(query)] = statements.as_slice() else {
        return None;
    };
    let mut cte_names = Vec::new();
    if let Some(with) = &query.with {
        for cte in &with.cte_tables {
            cte_names.push(normalize_ident(&cte.alias.name, dialect));
        }
    }
    let SetExpr::Select(select) = query.body.as_ref() else {
        return None;
    };

    let mut tables = Vec::new();
    for from in &select.from {
        collect_table(&from.relation, dialect, &cte_names, &mut tables);
        for join in &from.joins {
            collect_table(&join.relation, dialect, &cte_names, &mut tables);
        }
    }
    if tables.is_empty() {
        return None;
    }

    let mut projections = Vec::with_capacity(select.projection.len());
    for item in &select.projection {
        match item {
            SelectItem::Wildcard(_) => projections.push(ProjectionSource::Wildcard),
            SelectItem::QualifiedWildcard(kind, _) => match kind {
                SelectItemQualifiedWildcardKind::ObjectName(name) => {
                    let parts = object_name_parts(name, dialect);
                    if parts.is_empty() {
                        projections.push(ProjectionSource::Other);
                    } else {
                        projections.push(ProjectionSource::QualifiedWildcard(parts));
                    }
                }
                SelectItemQualifiedWildcardKind::Expr(_) => {
                    projections.push(ProjectionSource::Other);
                }
            },
            SelectItem::UnnamedExpr(expr) => {
                projections.push(expr_projection(expr, None, dialect));
            }
            SelectItem::ExprWithAlias { expr, alias } => {
                projections.push(expr_projection(
                    expr,
                    Some(normalize_ident(alias, dialect)),
                    dialect,
                ));
            }
            SelectItem::ExprWithAliases { .. } => {
                projections.push(ProjectionSource::Other);
            }
        }
    }

    Some(QueryColumnSources {
        tables,
        projections,
    })
}

fn collect_table(
    factor: &TableFactor,
    dialect: Dialect,
    cte_names: &[String],
    out: &mut Vec<TableSource>,
) {
    if let TableFactor::Table { name, alias, .. } = factor {
        let parts = object_name_parts(name, dialect);
        if parts.is_empty() || parts.len() > 3 {
            return;
        }
        if parts.len() == 1 {
            let single = &parts[0];
            if cte_names.iter().any(|cte| cte.eq_ignore_ascii_case(single)) {
                return;
            }
            if dialect == Dialect::Oracle && single.eq_ignore_ascii_case("DUAL") {
                return;
            }
        }
        out.push(TableSource {
            parts,
            alias: alias.as_ref().map(|a| normalize_ident(&a.name, dialect)),
        });
    }
}

fn expr_projection(expr: &Expr, alias: Option<String>, dialect: Dialect) -> ProjectionSource {
    match expr {
        Expr::Identifier(ident) => {
            let column = normalize_ident(ident, dialect);
            let output_name = alias.unwrap_or_else(|| column.clone());
            ProjectionSource::Column {
                qualifier: None,
                column,
                output_name,
            }
        }
        Expr::CompoundIdentifier(idents) if idents.len() >= 2 => {
            let mut parts: Vec<String> = idents
                .iter()
                .map(|ident| normalize_ident(ident, dialect))
                .collect();
            let column = parts.pop().unwrap_or_default();
            let output_name = alias.unwrap_or_else(|| column.clone());
            ProjectionSource::Column {
                qualifier: Some(parts),
                column,
                output_name,
            }
        }
        _ => ProjectionSource::Other,
    }
}

fn object_name_parts(name: &ObjectName, dialect: Dialect) -> Vec<String> {
    name.0
        .iter()
        .filter_map(|part| part.as_ident().map(|ident| normalize_ident(ident, dialect)))
        .collect()
}

fn normalize_ident(ident: &Ident, dialect: Dialect) -> String {
    if ident.quote_style.is_some() {
        return ident.value.clone();
    }
    match dialect {
        Dialect::Postgres => ident.value.to_ascii_lowercase(),
        Dialect::SqlServer => ident.value.clone(),
        Dialect::Oracle => ident.value.to_ascii_uppercase(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_tables_and_projections_for_joins_and_aliases() {
        let sources = query_column_sources(
            "SELECT e.department_id AS dept, e.job_id, d.location_id FROM hr.employees e JOIN hr.departments d ON d.department_id = e.department_id",
            Dialect::Oracle,
        )
        .expect("oracle join sources");
        assert_eq!(
            sources.tables,
            vec![
                TableSource {
                    parts: vec!["HR".into(), "EMPLOYEES".into()],
                    alias: Some("E".into()),
                },
                TableSource {
                    parts: vec!["HR".into(), "DEPARTMENTS".into()],
                    alias: Some("D".into()),
                },
            ]
        );
        assert_eq!(
            sources.projections,
            vec![
                ProjectionSource::Column {
                    qualifier: Some(vec!["E".into()]),
                    column: "DEPARTMENT_ID".into(),
                    output_name: "DEPT".into(),
                },
                ProjectionSource::Column {
                    qualifier: Some(vec!["E".into()]),
                    column: "JOB_ID".into(),
                    output_name: "JOB_ID".into(),
                },
                ProjectionSource::Column {
                    qualifier: Some(vec!["D".into()]),
                    column: "LOCATION_ID".into(),
                    output_name: "LOCATION_ID".into(),
                },
            ]
        );
    }

    #[test]
    fn extracts_sql_server_bracketed_tables_and_skips_oracle_dual() {
        let mssql = query_column_sources(
            "SELECT TOP (100) * FROM [SalesLT].[SalesOrderHeader]",
            Dialect::SqlServer,
        )
        .expect("mssql sources");
        assert_eq!(
            mssql.tables,
            vec![TableSource {
                parts: vec!["SalesLT".into(), "SalesOrderHeader".into()],
                alias: None,
            }]
        );
        assert_eq!(mssql.projections, vec![ProjectionSource::Wildcard]);

        assert!(query_column_sources("SELECT 1 FROM dual", Dialect::Oracle).is_none());
    }

    #[test]
    fn skips_cte_names_as_physical_tables() {
        let sources = query_column_sources(
            "WITH recent AS (SELECT * FROM rental) SELECT * FROM recent",
            Dialect::Postgres,
        );
        assert!(sources.is_none());
    }
}
