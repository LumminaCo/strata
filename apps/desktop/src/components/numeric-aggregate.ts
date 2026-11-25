import type { GridSelection, Rectangle } from "@glideapps/glide-data-grid";

import type { Cell, ColumnMeta } from "@/ipc/bindings/protocol";

export type AggregateFunction = "sum" | "avg" | "min" | "max";

export interface AggregateValue {
  /** Human-readable formatted value (e.g. "1,234.56"). */
  display: string;
  /** Unformatted numeric string suitable for copying (e.g. "1234.56"). */
  raw: string;
}

export interface NumericAggregateSummary {
  count: number;
  sum: AggregateValue;
  avg: AggregateValue;
  min: AggregateValue;
  max: AggregateValue;
}

export const aggregateFunctions: ReadonlyArray<{
  id: AggregateFunction;
  label: string;
  name: string;
}> = [
  { id: "sum", label: "SUM", name: "Sum" },
  { id: "avg", label: "AVG", name: "Average" },
  { id: "min", label: "MIN", name: "Minimum" },
  { id: "max", label: "MAX", name: "Maximum" },
];

const aggregateStorageKey = "strata.gridAggregate";
const numericStringPattern = /^([+-])?(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/;
const nonNumericColumnKinds = new Set([
  "bool",
  "date",
  "time",
  "timestamp",
  "timestamptz",
  "interval",
  "uuid",
  "xml",
  "binary",
  "array",
]);
const maxExactScale = 30;
const minAvgPrecision = 6;
const extraAvgPrecision = 4;

interface ExactDecimal {
  mantissa: bigint;
  scale: number;
}

interface ParsedNumeric {
  exact: ExactDecimal | null;
  float: number;
}

const numberFormat = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 6,
});

export function readAggregateFunction(): AggregateFunction {
  if (typeof localStorage === "undefined") return "sum";
  const saved = localStorage.getItem(aggregateStorageKey);
  return aggregateFunctions.some((item) => item.id === saved)
    ? (saved as AggregateFunction)
    : "sum";
}

export function saveAggregateFunction(fn: AggregateFunction) {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(aggregateStorageKey, fn);
}

function pow10(exponent: number): bigint {
  return 10n ** BigInt(exponent);
}

function parseExactDecimal(text: string): ExactDecimal | null {
  const match = numericStringPattern.exec(text);
  if (!match) return null;
  const sign = match[1] === "-" ? -1n : 1n;
  const intDigits = match[2] ?? "";
  const fracDigits = match[3] ?? match[4] ?? "";
  const exponent = match[5] ? Number.parseInt(match[5], 10) : 0;
  if (!Number.isSafeInteger(exponent)) return null;

  const digits = (intDigits + fracDigits).replace(/^0+(?=\d)/, "");
  if (digits === "0" || digits === "") {
    return { mantissa: 0n, scale: 0 };
  }

  let scale = fracDigits.length - exponent;
  if (Math.abs(scale) > maxExactScale) return null;

  let mantissa = BigInt(digits) * sign;
  if (scale < 0) {
    mantissa *= pow10(-scale);
    scale = 0;
  }

  return normalizeExact(mantissa, scale);
}

function normalizeExact(mantissa: bigint, scale: number): ExactDecimal {
  if (mantissa === 0n) return { mantissa: 0n, scale: 0 };
  let value = mantissa;
  let nextScale = scale;
  while (nextScale > 0 && value % 10n === 0n) {
    value /= 10n;
    nextScale--;
  }
  return { mantissa: value, scale: nextScale };
}

function addGroupingCommas(digits: string): string {
  if (digits.length <= 3) return digits;
  let result = "";
  const firstGroup = digits.length % 3 || 3;
  result = digits.slice(0, firstGroup);
  for (let index = firstGroup; index < digits.length; index += 3) {
    result += `,${digits.slice(index, index + 3)}`;
  }
  return result;
}

function formatExactDecimal(value: ExactDecimal): AggregateValue {
  const normalized = normalizeExact(value.mantissa, value.scale);
  if (normalized.mantissa === 0n) {
    return { display: "0", raw: "0" };
  }
  const negative = normalized.mantissa < 0n;
  const absDigits = (negative ? -normalized.mantissa : normalized.mantissa).toString();
  const sign = negative ? "-" : "";

  if (normalized.scale === 0) {
    return {
      display: `${sign}${addGroupingCommas(absDigits)}`,
      raw: `${sign}${absDigits}`,
    };
  }

  const padded = absDigits.padStart(normalized.scale + 1, "0");
  const splitIndex = padded.length - normalized.scale;
  const intPart = padded.slice(0, splitIndex);
  const fracPart = padded.slice(splitIndex);

  return {
    display: `${sign}${addGroupingCommas(intPart)}.${fracPart}`,
    raw: `${sign}${intPart}.${fracPart}`,
  };
}

function divideExactDecimal(
  numerator: bigint,
  scale: number,
  divisor: number,
  targetScale: number,
): ExactDecimal {
  const extraScale = Math.max(0, targetScale - scale);
  const scaled = numerator * pow10(extraScale);
  const negative = scaled < 0n;
  const absScaled = negative ? -scaled : scaled;
  const bigDivisor = BigInt(divisor);
  let quotient = absScaled / bigDivisor;
  const remainder = absScaled % bigDivisor;
  if (remainder * 2n >= bigDivisor) {
    quotient += 1n;
  }
  return normalizeExact(negative ? -quotient : quotient, scale + extraScale);
}

function compareExact(left: ExactDecimal, right: ExactDecimal): number {
  const scale = Math.max(left.scale, right.scale);
  const a = left.mantissa * pow10(scale - left.scale);
  const b = right.mantissa * pow10(scale - right.scale);
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function formatFloat(value: number): AggregateValue {
  if (!Number.isFinite(value)) {
    const text = String(value);
    return { display: text, raw: text };
  }
  const normalized = Object.is(value, -0) ? 0 : value;
  const abs = Math.abs(normalized);
  if (abs !== 0 && (abs >= 1e15 || abs < 1e-6)) {
    const raw = normalized.toString();
    return { display: normalized.toExponential(6).replace(/\.?0+e/, "e"), raw };
  }
  return {
    display: numberFormat.format(normalized),
    raw: normalized.toString(),
  };
}

export function parseNumericCell(cell: Cell, columnKind?: string): ParsedNumeric | null {
  if (cell === null || typeof cell === "boolean") return null;
  if (columnKind && nonNumericColumnKinds.has(columnKind)) return null;

  if (typeof cell === "number") {
    if (!Number.isFinite(cell)) return null;
    const normalized = Object.is(cell, -0) ? 0 : cell;
    return {
      exact: parseExactDecimal(normalized.toString()),
      float: normalized,
    };
  }

  const trimmed = cell.trim();
  if (!trimmed || !numericStringPattern.test(trimmed)) return null;
  const exact = parseExactDecimal(trimmed);
  const float = Number(trimmed);
  if (!exact && !Number.isFinite(float)) return null;

  return {
    exact,
    float: Object.is(float, -0) ? 0 : float,
  };
}

function collectSelectedValues(
  selection: GridSelection | undefined,
  rows: Cell[][],
  columns: ColumnMeta[],
  rowIndices: number[] | undefined,
): ParsedNumeric[] {
  if (!selection) return [];
  const visibleRows = rowIndices?.length ?? rows.length;
  const columnCount = columns.length;
  if (visibleRows === 0 || columnCount === 0) return [];

  const ranges: Readonly<Rectangle>[] = [];
  if (selection.current) {
    ranges.push(...selection.current.rangeStack, selection.current.range);
  }
  const selectedRows = selection.rows.length > 0 ? selection.rows.toArray() : [];
  const selectedCols = selection.columns.length > 0 ? selection.columns.toArray() : [];

  if (ranges.length === 0 && selectedRows.length === 0 && selectedCols.length === 0) {
    return [];
  }

  const values: ParsedNumeric[] = [];
  const pushCell = (visibleRow: number, column: number) => {
    if (visibleRow < 0 || visibleRow >= visibleRows || column < 0 || column >= columnCount) return;
    const cell = rows[rowIndices?.[visibleRow] ?? visibleRow]?.[column] ?? null;
    const parsed = parseNumericCell(cell, columns[column]?.kind);
    if (parsed) values.push(parsed);
  };

  // Fast path: a single contiguous rectangular range with no row/column blending.
  if (ranges.length === 1 && selectedRows.length === 0 && selectedCols.length === 0) {
    const rect = ranges[0];
    if (!rect) return values;
    const startRow = Math.max(0, rect.y);
    const endRow = Math.min(visibleRows, rect.y + rect.height);
    const startCol = Math.max(0, rect.x);
    const endCol = Math.min(columnCount, rect.x + rect.width);
    for (let row = startRow; row < endRow; row++) {
      for (let col = startCol; col < endCol; col++) {
        pushCell(row, col);
      }
    }
    return values;
  }

  // Fast path: only whole rows selected.
  if (ranges.length === 0 && selectedRows.length > 0 && selectedCols.length === 0) {
    for (const row of selectedRows) {
      if (row < 0 || row >= visibleRows) continue;
      for (let col = 0; col < columnCount; col++) {
        pushCell(row, col);
      }
    }
    return values;
  }

  // Fast path: only whole columns selected.
  if (ranges.length === 0 && selectedRows.length === 0 && selectedCols.length > 0) {
    for (const col of selectedCols) {
      if (col < 0 || col >= columnCount) continue;
      for (let row = 0; row < visibleRows; row++) {
        pushCell(row, col);
      }
    }
    return values;
  }

  // General path: multiple ranges or mixed selections; deduplicate cell coordinates.
  const seen = new Set<number>();
  const visit = (row: number, col: number) => {
    if (row < 0 || row >= visibleRows || col < 0 || col >= columnCount) return;
    const key = row * columnCount + col;
    if (seen.has(key)) return;
    seen.add(key);
    pushCell(row, col);
  };

  for (const rect of ranges) {
    const startRow = Math.max(0, rect.y);
    const endRow = Math.min(visibleRows, rect.y + rect.height);
    const startCol = Math.max(0, rect.x);
    const endCol = Math.min(columnCount, rect.x + rect.width);
    for (let row = startRow; row < endRow; row++) {
      for (let col = startCol; col < endCol; col++) {
        visit(row, col);
      }
    }
  }

  for (const row of selectedRows) {
    if (row < 0 || row >= visibleRows) continue;
    for (let col = 0; col < columnCount; col++) {
      visit(row, col);
    }
  }

  for (const col of selectedCols) {
    if (col < 0 || col >= columnCount) continue;
    for (let row = 0; row < visibleRows; row++) {
      visit(row, col);
    }
  }

  return values;
}

export function summarizeSelection({
  selection,
  rows,
  columns,
  rowIndices,
}: {
  selection: GridSelection | undefined;
  rows: Cell[][];
  columns: ColumnMeta[];
  rowIndices?: number[];
}): NumericAggregateSummary | null {
  const values = collectSelectedValues(selection, rows, columns, rowIndices);
  if (values.length === 0) return null;

  const allExact = values.every((item) => item.exact !== null);
  if (allExact) {
    let maxScale = 0;
    for (const item of values) {
      if (item.exact && item.exact.scale > maxScale) {
        maxScale = item.exact.scale;
      }
    }
    let sumMantissa = 0n;
    let min = values[0]!.exact!;
    let max = values[0]!.exact!;
    for (const item of values) {
      const exact = item.exact!;
      sumMantissa += exact.mantissa * pow10(maxScale - exact.scale);
      if (compareExact(exact, min) < 0) min = exact;
      if (compareExact(exact, max) > 0) max = exact;
    }

    const sumExact = normalizeExact(sumMantissa, maxScale);
    const avgScale = Math.min(
      maxExactScale,
      Math.max(minAvgPrecision, maxScale + extraAvgPrecision),
    );
    const avgExact = divideExactDecimal(sumMantissa, maxScale, values.length, avgScale);

    return {
      count: values.length,
      sum: formatExactDecimal(sumExact),
      avg: formatExactDecimal(avgExact),
      min: formatExactDecimal(min),
      max: formatExactDecimal(max),
    };
  }

  let sum = 0;
  let min = values[0]!.float;
  let max = values[0]!.float;
  for (const item of values) {
    sum += item.float;
    if (item.float < min) min = item.float;
    if (item.float > max) max = item.float;
  }

  return {
    count: values.length,
    sum: formatFloat(sum),
    avg: formatFloat(sum / values.length),
    min: formatFloat(min),
    max: formatFloat(max),
  };
}
