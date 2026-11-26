use std::fmt::Write;

use chrono::{DateTime, FixedOffset, NaiveDate, NaiveDateTime, NaiveTime};
use strata_core::{Cell, CellKind, ColumnMeta, Result};
use tiberius::{Column, ColumnData, ColumnType, Row};

use crate::query_error;

pub fn column(column: &Column) -> ColumnMeta {
    use CellKind as K;
    use ColumnType as T;
    let (db_type, kind) = match column.column_type() {
        T::Null => ("null", K::Other),
        T::Bit | T::Bitn => ("bit", K::Bool),
        T::Int1 => ("tinyint", K::Int),
        T::Int2 => ("smallint", K::Int),
        T::Int4 => ("int", K::Int),
        T::Int8 => ("bigint", K::Int),
        T::Intn => ("int", K::Int),
        T::Datetime4 => ("smalldatetime", K::Timestamp),
        T::Datetime | T::Datetimen => ("datetime", K::Timestamp),
        T::Float4 => ("real", K::Float),
        T::Float8 | T::Floatn => ("float", K::Float),
        T::Money => ("money", K::Decimal),
        T::Money4 => ("smallmoney", K::Decimal),
        T::Guid => ("uniqueidentifier", K::Uuid),
        T::Decimaln | T::Numericn => ("numeric", K::Decimal),
        T::Daten => ("date", K::Date),
        T::Timen => ("time", K::Time),
        T::Datetime2 => ("datetime2", K::Timestamp),
        T::DatetimeOffsetn => ("datetimeoffset", K::Timestamptz),
        T::BigVarBin => ("varbinary", K::Binary),
        T::BigBinary => ("binary", K::Binary),
        T::Image => ("image", K::Binary),
        T::BigVarChar => ("varchar", K::Text),
        T::BigChar => ("char", K::Text),
        T::NVarchar => ("nvarchar", K::Text),
        T::NChar => ("nchar", K::Text),
        T::Text => ("text", K::Text),
        T::NText => ("ntext", K::Text),
        T::Xml => ("xml", K::Xml),
        _ => ("sql_variant", K::Other),
    };
    ColumnMeta {
        name: column.name().into(),
        db_type: db_type.into(),
        kind,
        nullable: None,
        table_oid: None,
        column_id: None,
        foreign_key: None,
    }
}

pub fn text(row: &Row, index: usize) -> Result<String> {
    Ok(row
        .try_get::<&str, _>(index)
        .map_err(query_error)?
        .unwrap_or_default()
        .to_owned())
}

pub fn row(row: &Row) -> Result<Vec<Cell>> {
    (0..row.len())
        .map(|index| {
            let value = row.get_column_data(index).map_err(query_error)?;
            let cell = match value {
                ColumnData::U8(value) => value.map(|v| Cell::Int(v.into())),
                ColumnData::I16(value) => value.map(|v| Cell::Int(v.into())),
                ColumnData::I32(value) => value.map(|v| Cell::Int(v.into())),
                ColumnData::I64(value) => value.map(Cell::Int),
                ColumnData::F32(value) => value.map(|v| Cell::Float(v.into())),
                ColumnData::F64(value) => value.map(|v| {
                    if matches!(
                        row.columns()[index].column_type(),
                        ColumnType::Money | ColumnType::Money4
                    ) {
                        Cell::Text(format!("{v:.4}"))
                    } else {
                        Cell::Float(v)
                    }
                }),
                ColumnData::Bit(value) => value.map(Cell::Bool),
                ColumnData::String(value) => value.as_deref().map(|v| Cell::Text(v.into())),
                ColumnData::Guid(value) => value.map(|v| Cell::Text(v.to_string())),
                ColumnData::Binary(value) => value.as_deref().map(|bytes| {
                    let mut value = String::with_capacity(2 + bytes.len() * 2);
                    value.push_str("0x");
                    for byte in bytes {
                        let _ = write!(value, "{byte:02x}");
                    }
                    Cell::Text(value)
                }),
                ColumnData::Numeric(value) => value.map(|v| Cell::Text(v.to_string())),
                ColumnData::Xml(value) => value.as_ref().map(|v| Cell::Text(v.to_string())),
                ColumnData::DateTime(_)
                | ColumnData::SmallDateTime(_)
                | ColumnData::DateTime2(_) => row
                    .try_get::<NaiveDateTime, _>(index)
                    .map_err(query_error)?
                    .map(|v| Cell::Text(v.to_string())),
                ColumnData::Time(_) => row
                    .try_get::<NaiveTime, _>(index)
                    .map_err(query_error)?
                    .map(|v| Cell::Text(v.to_string())),
                ColumnData::Date(_) => row
                    .try_get::<NaiveDate, _>(index)
                    .map_err(query_error)?
                    .map(|v| Cell::Text(v.to_string())),
                ColumnData::DateTimeOffset(_) => row
                    .try_get::<DateTime<FixedOffset>, _>(index)
                    .map_err(query_error)?
                    .map(|v| Cell::Text(v.format("%Y-%m-%d %H:%M:%S%.f%:z").to_string())),
            };
            Ok(cell.unwrap_or(Cell::Null))
        })
        .collect()
}
