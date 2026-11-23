import type { Rectangle } from "@glideapps/glide-data-grid";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, test, vi } from "vite-plus/test";

import { ResultGrid, type ResultSet } from "./result-grid";

let onVisibleRegionChanged: ((region: Rectangle) => void) | undefined;

vi.mock("@glideapps/glide-data-grid", () => ({
  GridCellKind: { Text: "text" },
  DataEditor: (props: { onVisibleRegionChanged?: (region: Rectangle) => void }) => {
    onVisibleRegionChanged = props.onVisibleRegionChanged;
    return <div data-testid="data-editor" />;
  },
}));

vi.mock("@glideapps/glide-data-grid/dist/index.css", () => ({}));
vi.mock("@/theme/glide", () => ({ gridTheme: () => ({}) }));

beforeEach(() => {
  onVisibleRegionChanged = undefined;
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
    ],
    rows: Array.from({ length: rowCount }, (_, index) => [index + 1]),
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

  onVisibleRegionChanged?.({ x: 0, y: 100, width: 1, height: 20 });
  expect(onMore).not.toHaveBeenCalled();

  onVisibleRegionChanged?.({ x: 0, y: 440, width: 1, height: 20 });
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
  onVisibleRegionChanged?.({ x: 0, y: 480, width: 1, height: 20 });
  expect(onMore).not.toHaveBeenCalled();
});
