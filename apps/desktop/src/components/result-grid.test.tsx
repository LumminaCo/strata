import type { CellClickedEventArgs, GridCell, Item, Rectangle } from "@glideapps/glide-data-grid";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, test, vi } from "vite-plus/test";

import type { SortRule } from "@/features/result-query";

import { ResultGrid, type ResultSet } from "./result-grid";

interface MockEditorProps {
  columns: { id: string; title: string; width: number }[];
  rows: number;
  getCellContent: (cell: Item) => GridCell;
  customRenderers?: readonly unknown[];
  onVisibleRegionChanged?: (region: Rectangle) => void;
  onHeaderClicked?: (col: number) => void;
  onCellClicked?: (cell: Item, event: CellClickedEventArgs) => void;
  rangeSelect?: string;
}

let capturedProps: MockEditorProps | undefined;

vi.mock("@glideapps/glide-data-grid", () => ({
  GridCellKind: { Text: "text", Custom: "custom" },
  DataEditor: (props: MockEditorProps) => {
    capturedProps = props;
    return <div data-testid="data-editor" />;
  },
}));

vi.mock("@glideapps/glide-data-grid/dist/index.css", () => ({}));
vi.mock("@/theme/glide", () => ({ gridTheme: () => ({}) }));

beforeEach(() => {
  capturedProps = undefined;
});

function sampleResult(rowCount = 500): ResultSet {
  return {
    id: "cursor-1",
    index: 0,
    columns: [
      {
        name: "id",
        db_type: "int4",
        kind: "int",
        nullable: false,
        table_oid: null,
        column_id: null,
      },
      {
        name: "group_name",
        db_type: "varchar",
        kind: "text",
        nullable: false,
        table_oid: null,
        column_id: null,
      },
    ],
    rows: Array.from({ length: rowCount }, (_, index) => [
      index + 1,
      index % 2 === 0 ? "beta" : "alpha",
    ]),
    more: true,
    capped: false,
  };
}

test("hides the fetching indicator when idle and renders it while fetching rows", () => {
  const idle = renderToStaticMarkup(
    <ResultGrid
      result={sampleResult()}
      themeVersion="false"
      canFetch={true}
      fetching={false}
      filter=""
      onMore={vi.fn()}
      onCell={vi.fn()}
    />,
  );
  expect(idle).toContain('data-fetching="false"');
  expect(idle).not.toContain('aria-busy="true"');
  expect(idle).not.toContain("Fetching rows…");

  const fetching = renderToStaticMarkup(
    <ResultGrid
      result={sampleResult()}
      themeVersion="false"
      canFetch={false}
      fetching={true}
      filter=""
      onMore={vi.fn()}
      onCell={vi.fn()}
    />,
  );
  expect(fetching).toContain('data-fetching="true"');
  expect(fetching).toContain('aria-busy="true"');
  expect(fetching).toContain('role="status"');
  expect(fetching).toContain("Fetching rows…");
});

test("triggers onMore only when scrolling near the bottom while eligible to fetch", () => {
  const onMore = vi.fn();
  renderToStaticMarkup(
    <ResultGrid
      result={sampleResult(500)}
      themeVersion="false"
      canFetch={true}
      fetching={false}
      filter=""
      onMore={onMore}
      onCell={vi.fn()}
    />,
  );

  capturedProps?.onVisibleRegionChanged?.({ x: 0, y: 100, width: 1, height: 20 });
  expect(onMore).not.toHaveBeenCalled();

  capturedProps?.onVisibleRegionChanged?.({ x: 0, y: 440, width: 1, height: 20 });
  expect(onMore).toHaveBeenCalledOnce();

  onMore.mockClear();
  renderToStaticMarkup(
    <ResultGrid
      result={sampleResult(500)}
      themeVersion="false"
      canFetch={false}
      fetching={true}
      filter=""
      onMore={onMore}
      onCell={vi.fn()}
    />,
  );
  capturedProps?.onVisibleRegionChanged?.({ x: 0, y: 480, width: 1, height: 20 });
  expect(onMore).not.toHaveBeenCalled();
});

test("applies filter expressions and nested multi-column sorting with clearable header cycling", () => {
  const onSortsChange = vi.fn();
  const sorts: SortRule[] = [
    { column: 1, descending: false },
    { column: 0, descending: true },
  ];
  const markup = renderToStaticMarkup(
    <ResultGrid
      result={sampleResult(6)}
      themeVersion="false"
      canFetch={false}
      fetching={false}
      filter=""
      filters={[{ id: "f1", expression: "id >= 2" }]}
      sorts={sorts}
      onSortsChange={onSortsChange}
      onMore={vi.fn()}
      onCell={vi.fn()}
    />,
  );

  expect(markup).toContain("Fetched rows sorted locally (2 columns)");
  expect(markup).toContain('aria-label="Clear local sort"');
  expect(capturedProps?.columns.map((c) => c.title)).toEqual(["id ↓2", "group_name ↑1"]);
  // Rows with id >= 2: 2(alpha), 3(beta), 4(alpha), 5(beta), 6(alpha)
  // Sorted by group_name ASC, then id DESC: 6(alpha), 4(alpha), 2(alpha), 5(beta), 3(beta)
  expect(capturedProps?.rows).toBe(5);
  const firstId = capturedProps?.getCellContent([0, 0]);
  const lastId = capturedProps?.getCellContent([0, 4]);
  expect(firstId && "displayData" in firstId ? firstId.displayData : null).toBe("6");
  expect(lastId && "displayData" in lastId ? lastId.displayData : null).toBe("3");

  // Clicking column 0 (currently DESC) removes it from sorts instead of cycling forever!
  capturedProps?.onHeaderClicked?.(0);
  expect(onSortsChange).toHaveBeenCalledWith([{ column: 1, descending: false }]);
});

test("enables multi-rect cell range selection for numeric aggregation", () => {
  renderToStaticMarkup(
    <ResultGrid
      result={sampleResult(10)}
      themeVersion="false"
      canFetch={false}
      fetching={false}
      filter=""
      onMore={vi.fn()}
      onCell={vi.fn()}
    />,
  );
  expect(capturedProps?.rangeSelect).toBe("multi-rect");
});

test("renders FK button cells for non-null FK values and follows FK clicks using source row indices", () => {
  const onFollowForeignKey = vi.fn();
  const rentalResult: ResultSet = {
    id: "cursor-fk",
    index: 0,
    columns: [
      {
        name: "rental_id",
        db_type: "int4",
        kind: "int",
        nullable: false,
        table_oid: 16400,
        column_id: 1,
      },
      {
        name: "customer_id",
        db_type: "int4",
        kind: "int",
        nullable: true,
        table_oid: 16400,
        column_id: 4,
        foreign_key: { schema: "public", table: "customer", column: "customer_id" },
      },
    ],
    rows: [
      [1, 130],
      [2, null],
      [3, 459],
    ],
    more: false,
    capped: false,
  };

  renderToStaticMarkup(
    <ResultGrid
      result={rentalResult}
      themeVersion="false"
      canFetch={false}
      fetching={false}
      filter=""
      sorts={[{ column: 0, descending: true }]}
      onMore={vi.fn()}
      onCell={vi.fn()}
      onFollowForeignKey={onFollowForeignKey}
    />,
  );

  expect(capturedProps?.customRenderers).toHaveLength(1);

  // Sorted DESC by rental_id: row 0 -> rental 3 (customer 459), row 1 -> rental 2 (null), row 2 -> rental 1 (customer 130)
  const fkCell = capturedProps?.getCellContent([1, 0]);
  expect(fkCell?.kind).toBe("custom");
  expect(fkCell?.copyData).toBe("459");

  const nullFkCell = capturedProps?.getCellContent([1, 1]);
  expect(nullFkCell?.kind).toBe("text");

  const plainCell = capturedProps?.getCellContent([0, 0]);
  expect(plainCell?.kind).toBe("text");

  // Click inside the FK button rect (width=140, height=25 => button x: 118..136, y: 4..22)
  const preventDefault = vi.fn();
  capturedProps?.onCellClicked?.([1, 0], {
    kind: "cell",
    location: [1, 0],
    bounds: { x: 200, y: 40, width: 140, height: 25 },
    localEventX: 126,
    localEventY: 12,
    button: 0,
    buttons: 1,
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    isTouch: false,
    isEdge: false,
    isFillHandle: false,
    scrollEdge: [0, 0],
    preventDefault,
  });
  expect(preventDefault).toHaveBeenCalledOnce();
  // Display row 0 maps to source row 2 (rental_id = 3, customer_id = 459)
  expect(onFollowForeignKey).toHaveBeenCalledWith(2, 1);

  // Clicking cell text outside the button does not trigger FK navigation
  onFollowForeignKey.mockClear();
  preventDefault.mockClear();
  capturedProps?.onCellClicked?.([1, 0], {
    kind: "cell",
    location: [1, 0],
    bounds: { x: 200, y: 40, width: 140, height: 25 },
    localEventX: 40,
    localEventY: 12,
    button: 0,
    buttons: 1,
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    isTouch: false,
    isEdge: false,
    isFillHandle: false,
    scrollEdge: [0, 0],
    preventDefault,
  });
  expect(preventDefault).not.toHaveBeenCalled();
  expect(onFollowForeignKey).not.toHaveBeenCalled();

  // Clicking a NULL cell in an FK column does not trigger FK navigation
  capturedProps?.onCellClicked?.([1, 1], {
    kind: "cell",
    location: [1, 1],
    bounds: { x: 200, y: 65, width: 140, height: 25 },
    localEventX: 126,
    localEventY: 12,
    button: 0,
    buttons: 1,
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    isTouch: false,
    isEdge: false,
    isFillHandle: false,
    scrollEdge: [0, 0],
    preventDefault,
  });
  expect(onFollowForeignKey).not.toHaveBeenCalled();
});
