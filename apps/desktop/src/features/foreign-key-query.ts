import { formatQualifiedObjectName } from "@/features/catalog-context-menu";
import { normalizeTabTitle } from "@/features/tab-order";
import { quoteName } from "@/features/table-data";
import type { Cell, Connection, ForeignKeyRef } from "@/ipc/bindings/protocol";

const NUMERIC_KINDS = new Set(["int", "float", "decimal"]);
const NUMBER_PATTERN = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const HEX_PATTERN = /^0x([0-9a-fA-F]+)$/;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/;

export function needsFullCellRead(value: Cell, columnKind?: string): boolean {
  return (
    typeof value === "string" &&
    ((value.length >= 2_000 && value.endsWith("…")) || columnKind === "binary")
  );
}

export function formatSqlLiteral(
  value: Exclude<Cell, null>,
  columnKind: string | undefined,
  dbKind: Connection["kind"],
): string {
  if (typeof value === "boolean") {
    if (dbKind === "sqlserver") return value ? "1" : "0";
    return value ? "TRUE" : "FALSE";
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  const text = String(value);
  const trimmed = text.trim();
  if (columnKind && NUMERIC_KINDS.has(columnKind) && NUMBER_PATTERN.test(trimmed)) {
    return trimmed;
  }
  if (columnKind === "binary") {
    const hexMatch = HEX_PATTERN.exec(trimmed);
    if (hexMatch?.[1]) {
      const hex = hexMatch[1];
      if (dbKind === "postgres") return `decode('${hex}', 'hex')`;
      if (dbKind === "oracle") return `HEXTORAW('${hex}')`;
      return `0x${hex}`;
    }
  }
  if (dbKind === "oracle") {
    if (columnKind === "date" && ISO_DATE_PATTERN.test(trimmed)) {
      return `DATE '${trimmed}'`;
    }
    if (columnKind === "timestamp" && ISO_TIMESTAMP_PATTERN.test(trimmed)) {
      return `TIMESTAMP '${trimmed.replace("T", " ")}'`;
    }
  }
  return `'${text.replaceAll("'", "''")}'`;
}

export function buildForeignKeyQuery(
  target: ForeignKeyRef,
  value: Exclude<Cell, null>,
  columnKind: string | undefined,
  dbKind: Connection["kind"],
): string {
  const relation = formatQualifiedObjectName(target.schema, target.table, dbKind);
  const column = quoteName(target.column, dbKind);
  const literal = formatSqlLiteral(value, columnKind, dbKind);
  return `SELECT *\nFROM ${relation}\nWHERE ${column} = ${literal};`;
}

export function foreignKeyTabTitle(
  target: ForeignKeyRef,
  value: Exclude<Cell, null>,
): string | undefined {
  const raw = String(value).replace(/\s+/g, " ").trim();
  const shortValue = raw.length > 18 ? `${raw.slice(0, 17)}…` : raw;
  return normalizeTabTitle(`${target.table} (${shortValue})`);
}
