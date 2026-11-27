//! Headless database engine, catalog cache, and wire cell encoding shared by the desktop app and MCP server.

mod engine;
mod metadata;

use serde::Serialize;
use strata_core::Cell;

pub use engine::Engine;
pub use metadata::{CatalogScope, CatalogSnapshot, Metadata, TABLE_PAGE_SIZE, database, now_ms};

#[derive(Serialize)]
#[serde(untagged)]
pub enum WireCell {
    Value(Cell),
    Exact(String),
}

impl From<Cell> for WireCell {
    fn from(cell: Cell) -> Self {
        // JavaScript cannot round-trip bigint values outside its safe integer range.
        match cell {
            Cell::Int(value) if value.unsigned_abs() > (1_u64 << 53) - 1 => {
                Self::Exact(value.to_string())
            }
            other => Self::Value(other),
        }
    }
}

pub fn wire_rows(rows: Vec<Vec<Cell>>) -> Vec<Vec<WireCell>> {
    rows.into_iter()
        .map(|row| row.into_iter().map(Into::into).collect())
        .collect()
}
