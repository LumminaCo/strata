import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vite-plus/test";

import type { Cell, ColumnMeta } from "@/ipc/bindings/protocol";

import { ResultToolbar } from "./result-toolbar";

// The real popup only mounts in a DOM; print the offered items instead.
vi.mock("@/components/ui/select", () => ({
  Select: ({ items, placeholder }: { items: { label: string }[]; placeholder?: string }) =>
    `${placeholder}: ${items.map((item) => item.label).join(", ")}`,
}));

const columns: ColumnMeta[] = [
  { name: "id", db_type: "int4", kind: "int", nullable: false, table_oid: null, column_id: null },
  {
    name: "status",
    db_type: "varchar",
    kind: "text",
    nullable: true,
    table_oid: null,
    column_id: null,
  },
  {
    name: "total",
    db_type: "numeric",
    kind: "decimal",
    nullable: true,
    table_oid: null,
    column_id: null,
  },
];

const rows: Cell[][] = [
  [1, "paid", "120"],
  [2, "pending", "50"],
];

test("renders filter chips, nested sort chips with priority controls, and clear actions", () => {
  const html = renderToStaticMarkup(
    <ResultToolbar
      columns={columns}
      rows={rows}
      visibleRows={1}
      draftFilter=""
      filters={[
        { id: "f1", expression: "status = 'paid'" },
        { id: "f2", expression: "total > 100" },
      ]}
      sorts={[
        { column: 1, descending: false },
        { column: 2, descending: true },
      ]}
      onDraftFilterChange={vi.fn()}
      onAddFilter={vi.fn()}
      onRemoveFilter={vi.fn()}
      onEditFilter={vi.fn()}
      onClearFilters={vi.fn()}
      onSortsChange={vi.fn()}
    />,
  );

  expect(html).toContain("status = &#x27;paid&#x27;");
  expect(html).toContain("total &gt; 100");
  expect(html).toContain("Clear filters");
  expect(html).toContain("1 / 2");
  expect(html).toContain('aria-label="Remove sort on status"');
  expect(html).toContain('aria-label="Remove sort on total"');
  expect(html).toContain('aria-label="Move sort status later"');
  expect(html).toContain('aria-label="Move sort total earlier"');
  expect(html).toContain("Clear sort");
  // Already sorted columns (status, total) are excluded from "+ Then by", leaving only id
  expect(html).toContain("+ Then by: id<");
});

test("omits chips bar when no filters or sorts are active", () => {
  const html = renderToStaticMarkup(
    <ResultToolbar
      columns={columns}
      rows={rows}
      visibleRows={2}
      draftFilter=""
      filters={[]}
      sorts={[]}
      onDraftFilterChange={vi.fn()}
      onAddFilter={vi.fn()}
      onRemoveFilter={vi.fn()}
      onEditFilter={vi.fn()}
      onClearFilters={vi.fn()}
      onSortsChange={vi.fn()}
    />,
  );

  expect(html).not.toContain("result-chips-bar");
  expect(html).not.toContain("Clear sort");
  expect(html).toContain("+ Sort by: id, status, total<");
});
