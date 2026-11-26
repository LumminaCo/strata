use std::collections::HashSet;

use strata_core::{Cell, CellKind, ColumnMeta, ForeignKeyRef};
use tokio_postgres::{
    Client, Column, SimpleColumn,
    types::{Kind, Type},
};

pub(crate) async fn columns(
    client: &Client,
    columns: &[Column],
) -> Result<Vec<ColumnMeta>, tokio_postgres::Error> {
    let mut metadata = columns
        .iter()
        .map(|column| ColumnMeta {
            name: column.name().into(),
            db_type: column.type_().name().into(),
            kind: kind(column.type_()),
            nullable: None,
            table_oid: column.table_oid(),
            column_id: column.column_id(),
            foreign_key: None,
        })
        .collect::<Vec<_>>();
    let mut tables = Vec::new();
    let mut attributes = Vec::new();
    let mut unique_tables = Vec::new();
    let mut seen_tables = HashSet::new();
    for column in columns {
        if let (Some(table), Some(attribute)) = (column.table_oid(), column.column_id()) {
            tables.push(table);
            attributes.push(attribute);
            if seen_tables.insert(table) {
                unique_tables.push(table);
            }
        }
    }
    if !tables.is_empty() {
        let rows = client
            .query(
                include_str!("queries/column_types.sql"),
                &[&tables, &attributes],
            )
            .await?;
        for row in rows {
            let table = row.try_get(0)?;
            let attribute = row.try_get(1)?;
            for column in &mut metadata {
                if (column.table_oid, column.column_id) == (Some(table), Some(attribute)) {
                    column.db_type = row.try_get(2)?;
                    // A result can make a NOT NULL column nullable (for example an outer join).
                }
            }
        }
        if let Ok(fk_rows) = client
            .query(
                include_str!("queries/column_foreign_keys.sql"),
                &[&unique_tables],
            )
            .await
        {
            for row in fk_rows {
                let Ok(table) = row.try_get::<_, u32>(0) else {
                    continue;
                };
                let Ok(attribute) = row.try_get::<_, i16>(1) else {
                    continue;
                };
                let Ok(target_schema) = row.try_get::<_, String>(2) else {
                    continue;
                };
                let Ok(target_table) = row.try_get::<_, String>(3) else {
                    continue;
                };
                let Ok(target_column) = row.try_get::<_, String>(4) else {
                    continue;
                };
                let target = ForeignKeyRef {
                    schema: target_schema,
                    table: target_table,
                    column: target_column,
                };
                for column in &mut metadata {
                    if column.foreign_key.is_none()
                        && (column.table_oid, column.column_id) == (Some(table), Some(attribute))
                    {
                        column.foreign_key = Some(target.clone());
                    }
                }
            }
        }
    }
    Ok(metadata)
}

pub(crate) fn describe(
    description: &[SimpleColumn],
    prepared: Option<&[ColumnMeta]>,
) -> Vec<ColumnMeta> {
    if let Some(prepared) = prepared
        && prepared.len() == description.len()
        && prepared
            .iter()
            .zip(description)
            .all(|(meta, simple)| meta.name == simple.name())
    {
        return prepared.to_vec();
    }
    description
        .iter()
        .map(|column| ColumnMeta {
            name: column.name().into(),
            db_type: "unknown".into(),
            kind: CellKind::Other,
            nullable: None,
            table_oid: None,
            column_id: None,
            foreign_key: None,
        })
        .collect()
}

fn kind(ty: &Type) -> CellKind {
    use CellKind::*;
    match ty.kind() {
        Kind::Array(_) => return Array,
        Kind::Domain(base) => return kind(base),
        _ => {}
    }
    match *ty {
        Type::BOOL => Bool,
        Type::INT2 | Type::INT4 | Type::INT8 | Type::OID => Int,
        Type::FLOAT4 | Type::FLOAT8 => Float,
        Type::NUMERIC | Type::MONEY => Decimal,
        Type::TEXT | Type::VARCHAR | Type::BPCHAR | Type::NAME | Type::CHAR => Text,
        Type::DATE => Date,
        Type::TIME | Type::TIMETZ => Time,
        Type::TIMESTAMP => Timestamp,
        Type::TIMESTAMPTZ => Timestamptz,
        Type::INTERVAL => Interval,
        Type::UUID => Uuid,
        Type::JSON | Type::JSONB => Json,
        Type::XML => Xml,
        Type::BYTEA => Binary,
        _ => Other,
    }
}

pub(crate) fn decode(value: Option<&str>, kind: CellKind) -> Cell {
    let Some(value) = value else {
        return Cell::Null;
    };
    match kind {
        CellKind::Bool => match value {
            "t" => return Cell::Bool(true),
            "f" => return Cell::Bool(false),
            _ => {}
        },
        CellKind::Int => {
            if let Ok(number) = value.parse::<i64>()
                && number.unsigned_abs() <= (1 << 53)
            {
                return Cell::Int(number);
            }
        }
        CellKind::Float => {
            if let Ok(number) = value.parse::<f64>()
                && number.is_finite()
            {
                return Cell::Float(number);
            }
        }
        CellKind::Binary => {
            if let Some(hex) = value.strip_prefix("\\x")
                && hex.is_ascii()
                && hex.len().is_multiple_of(2)
            {
                if hex.len() > 32 * 1024 * 1024 {
                    return Cell::Text(format!("[Binary: {} bytes]", hex.len() / 2));
                }
                return Cell::Text(format!("0x{hex}"));
            }
        }
        _ => {}
    }
    Cell::Text(value.into())
}
