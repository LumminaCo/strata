import { CompactSelection, type GridSelection } from "@glideapps/glide-data-grid";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vite-plus/test";

import type { Cell, ColumnMeta } from "@/ipc/bindings/protocol";

import {
  aggregateFunctions,
  parseNumericCell,
  summarizeSelection,
  type NumericAggregateSummary,
} from "./numeric-aggregate";
import { NumericAggregateBar } from "./numeric-aggregate-bar";

function column(name: string, kind: string): ColumnMeta {
  return {
    name,
    db_type: kind,
    kind,
    nullable: true,
    table_oid: null,
    column_id: null,
  };
}

function rangeSelection(
  x: number,
  y: number,
  width: number,
  height: number,
  rangeStack: Array<{ x: number; y: number; width: number; height: number }> = [],
): GridSelection {
  return {
    current: {
      cell: [x, y],
      range: { x, y, width, height },
      rangeStack,
    },
    rows: CompactSelection.empty(),
    columns: CompactSelection.empty(),
  };
}

describe("parseNumericCell", () => {
  test("parses integers, floats, decimal strings, and rejects non-numeric values", () => {
    expect(parseNumericCell(42, "int")?.float).toBe(42);
    expect(parseNumericCell(-12.5, "float")?.float).toBe(-12.5);
    expect(parseNumericCell(" 1234.56 ", "decimal")?.exact).toEqual({
      mantissa: 123456n,
      scale: 2,
    });
    expect(parseNumericCell("9007199254740993", "int")?.exact).toEqual({
      mantissa: 9007199254740993n,
      scale: 0,
    });

    expect(parseNumericCell(null, "int")).toBeNull();
    expect(parseNumericCell(true, "bool")).toBeNull();
    expect(parseNumericCell("", "text")).toBeNull();
    expect(parseNumericCell("   ", "text")).toBeNull();
    expect(parseNumericCell("0x10", "text")).toBeNull();
    expect(parseNumericCell("NaN", "float")).toBeNull();
    expect(parseNumericCell("Infinity", "float")).toBeNull();
    expect(parseNumericCell("2024-01-19", "date")).toBeNull();
    expect(parseNumericCell("42", "binary")).toBeNull();
    expect(parseNumericCell("42", "uuid")).toBeNull();
  });
});

describe("summarizeSelection", () => {
  const columns = [
    column("id", "int"),
    column("name", "text"),
    column("amount", "decimal"),
    column("rate", "float"),
  ];
  const rows: Cell[][] = [
    [1, "alpha", "0.10", 1.5],
    [2, "beta", "0.20", -0.5],
    [3, "gamma", null, 2],
    [4, "delta", "1000.50", 3],
  ];

  test("computes exact SUM, AVG, MIN, MAX without floating-point drift", () => {
    const summary = summarizeSelection({
      selection: rangeSelection(2, 0, 1, 2),
      rows,
      columns,
    });

    expect(summary).toEqual({
      count: 2,
      sum: { display: "0.3", raw: "0.3" },
      avg: { display: "0.15", raw: "0.15" },
      min: { display: "0.1", raw: "0.1" },
      max: { display: "0.2", raw: "0.2" },
    });
  });

  test("skips NULL and non-numeric cells across multi-column selections", () => {
    const summary = summarizeSelection({
      selection: rangeSelection(1, 0, 2, 4),
      rows,
      columns,
    });

    expect(summary).toEqual({
      count: 3,
      sum: { display: "1,000.8", raw: "1000.8" },
      avg: { display: "333.6", raw: "333.6" },
      min: { display: "0.1", raw: "0.1" },
      max: { display: "1,000.5", raw: "1000.5" },
    });
  });

  test("returns null when selection contains only non-numeric or NULL cells", () => {
    expect(
      summarizeSelection({
        selection: rangeSelection(1, 0, 1, 4),
        rows,
        columns,
      }),
    ).toBeNull();
    expect(
      summarizeSelection({
        selection: rangeSelection(2, 2, 1, 1),
        rows,
        columns,
      }),
    ).toBeNull();
    expect(
      summarizeSelection({
        selection: undefined,
        rows,
        columns,
      }),
    ).toBeNull();
  });

  test("supports multi-rect selections and deduplicates overlapping cells", () => {
    const summary = summarizeSelection({
      selection: rangeSelection(0, 2, 1, 2, [
        { x: 0, y: 0, width: 1, height: 2 },
        { x: 0, y: 1, width: 1, height: 2 }, // overlaps row 1 and row 2
      ]),
      rows,
      columns,
    });

    expect(summary).toEqual({
      count: 4,
      sum: { display: "10", raw: "10" },
      avg: { display: "2.5", raw: "2.5" },
      min: { display: "1", raw: "1" },
      max: { display: "4", raw: "4" },
    });
  });

  test("supports whole row and whole column selections", () => {
    const rowSel: GridSelection = {
      rows: CompactSelection.fromSingleSelection([0, 2]),
      columns: CompactSelection.empty(),
    };
    const rowSummary = summarizeSelection({ selection: rowSel, rows, columns });
    // Row 0: 1, 0.10, 1.5 -> sum 2.6; Row 1: 2, 0.20, -0.5 -> sum 1.7; total = 4.3 across 6 numbers
    expect(rowSummary?.count).toBe(6);
    expect(rowSummary?.sum).toEqual({ display: "4.3", raw: "4.3" });
    expect(rowSummary?.min).toEqual({ display: "-0.5", raw: "-0.5" });
    expect(rowSummary?.max).toEqual({ display: "2", raw: "2" });

    const colSel: GridSelection = {
      rows: CompactSelection.empty(),
      columns: CompactSelection.fromSingleSelection(0),
    };
    const colSummary = summarizeSelection({ selection: colSel, rows, columns });
    expect(colSummary).toEqual({
      count: 4,
      sum: { display: "10", raw: "10" },
      avg: { display: "2.5", raw: "2.5" },
      min: { display: "1", raw: "1" },
      max: { display: "4", raw: "4" },
    });
  });

  test("preserves precision for 64-bit integers beyond Number.MAX_SAFE_INTEGER", () => {
    const bigColumns = [column("big_id", "int")];
    const bigRows: Cell[][] = [["9007199254740993"], ["1"]];
    const summary = summarizeSelection({
      selection: rangeSelection(0, 0, 1, 2),
      rows: bigRows,
      columns: bigColumns,
    });

    expect(summary).toEqual({
      count: 2,
      sum: { display: "9,007,199,254,740,994", raw: "9007199254740994" },
      avg: { display: "4,503,599,627,370,497", raw: "4503599627370497" },
      min: { display: "1", raw: "1" },
      max: { display: "9,007,199,254,740,993", raw: "9007199254740993" },
    });
  });

  test("respects filtered/sorted rowIndices and clamps stale out-of-bounds selections", () => {
    const summary = summarizeSelection({
      selection: rangeSelection(0, 0, 1, 10),
      rows,
      columns,
      rowIndices: [3, 1], // rows with ids 4 and 2
    });

    expect(summary).toEqual({
      count: 2,
      sum: { display: "6", raw: "6" },
      avg: { display: "3", raw: "3" },
      min: { display: "2", raw: "2" },
      max: { display: "4", raw: "4" },
    });
  });

  test("handles repeating averages and scientific float fallback", () => {
    const repeating = summarizeSelection({
      selection: rangeSelection(0, 0, 1, 3),
      rows: [[1], [1], [2]],
      columns: [column("n", "int")],
    });
    expect(repeating?.avg).toEqual({ display: "1.333333", raw: "1.333333" });

    const sci = summarizeSelection({
      selection: rangeSelection(0, 0, 1, 2),
      rows: [[1e40], [3e40]],
      columns: [column("x", "float")],
    });
    expect(sci?.count).toBe(2);
    expect(sci?.sum.raw).toBe("4e+40");
    expect(sci?.avg.raw).toBe("2e+40");
  });
});

describe("NumericAggregateBar", () => {
  const sampleSummary: NumericAggregateSummary = {
    count: 3,
    sum: { display: "60", raw: "60" },
    avg: { display: "20", raw: "20" },
    min: { display: "10", raw: "10" },
    max: { display: "30", raw: "30" },
  };

  test("renders English function options (SUM, AVG, MIN, MAX) and active value", () => {
    expect(aggregateFunctions.map((item) => item.label)).toEqual(["SUM", "AVG", "MIN", "MAX"]);

    const sumMarkup = renderToStaticMarkup(
      <NumericAggregateBar summary={sampleSummary} fn="sum" onChangeFn={vi.fn()} />,
    );
    expect(sumMarkup).toContain('aria-label="Aggregate function"');
    expect(sumMarkup).toContain(">SUM</span>");
    expect(sumMarkup).toContain('data-testid="numeric-aggregation-value">60</span>');
    expect(sumMarkup).toContain("(3)");

    const avgMarkup = renderToStaticMarkup(
      <NumericAggregateBar summary={sampleSummary} fn="avg" onChangeFn={vi.fn()} />,
    );
    expect(avgMarkup).toContain(">AVG</span>");
    expect(avgMarkup).toContain('data-testid="numeric-aggregation-value">20</span>');

    const minMarkup = renderToStaticMarkup(
      <NumericAggregateBar summary={sampleSummary} fn="min" onChangeFn={vi.fn()} />,
    );
    expect(minMarkup).toContain('data-testid="numeric-aggregation-value">10</span>');

    const maxMarkup = renderToStaticMarkup(
      <NumericAggregateBar summary={sampleSummary} fn="max" onChangeFn={vi.fn()} />,
    );
    expect(maxMarkup).toContain('data-testid="numeric-aggregation-value">30</span>');
  });
});
