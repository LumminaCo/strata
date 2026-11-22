import {
  DataEditor,
  GridCellKind,
  type DataEditorRef,
  type GridCell,
  type Item,
  type Rectangle,
} from "@glideapps/glide-data-grid";
import "@glideapps/glide-data-grid/dist/index.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { Cell, ColumnMeta } from "@/ipc/bindings/protocol";
import { gridTheme } from "@/theme/glide";

export interface ResultSet {
  id: string;
  index: number;
  columns: ColumnMeta[];
  rows: Cell[][];
  more: boolean;
  capped: boolean;
}

const numeric = new Set(["int", "float", "decimal"]);

export function ResultGrid({
  result,
  themeVersion,
  canFetch,
  onMore,
  onCell,
  filter,
}: {
  result: ResultSet;
  themeVersion: string;
  canFetch: boolean;
  onMore: () => void;
  onCell: (row: number, column: number) => void;
  filter: string;
}) {
  const [widths, setWidths] = useState<Record<number, number>>({});
  const [sort, setSort] = useState<{ column: number; descending: boolean }>();
  const [nativeType, setNativeType] = useState("");
  const editor = useRef<DataEditorRef>(null);
  const visible = useRef<Rectangle | null>(null);
  const [theme, setTheme] = useState(gridTheme);
  useEffect(() => setTheme(gridTheme()), [themeVersion]);
  const columns = useMemo(
    () =>
      result.columns.map((column, index) => ({
        id: String(index),
        title:
          sort?.column === index ? `${column.name} ${sort.descending ? "↓" : "↑"}` : column.name,
        width: widths[index] ?? Math.min(360, Math.max(115, column.name.length * 9 + 30)),
      })),
    [result.columns, sort, widths],
  );

  const rowIndices = useMemo(() => {
    if (!filter && !sort) return undefined;
    const needle = filter.toLocaleLowerCase();
    const indices = result.rows.flatMap((row, index) =>
      !needle ||
      row.some((cell) =>
        (cell === null ? "null" : String(cell).toLocaleLowerCase()).includes(needle),
      )
        ? [index]
        : [],
    );
    if (sort) {
      const compare = new Intl.Collator(undefined, { numeric: true });
      const { column, descending } = sort;
      indices.sort((a, b) => {
        const left = result.rows[a]?.[column];
        const right = result.rows[b]?.[column];
        const order =
          typeof left === "number" && typeof right === "number"
            ? left - right
            : compare.compare(String(left ?? ""), String(right ?? ""));
        return descending ? -order : order;
      });
    }
    return indices;
  }, [filter, result.rows, sort]);

  const getCell = useCallback(
    ([column, row]: Item): GridCell => {
      const value = result.rows[rowIndices?.[row] ?? row]?.[column] ?? null;
      const displayData = value === null ? "NULL" : String(value);
      return {
        kind: GridCellKind.Text,
        data: value === null ? "" : displayData,
        displayData,
        readonly: true,
        allowOverlay: false,
        contentAlign: numeric.has(result.columns[column]?.kind ?? "") ? "right" : "left",
        ...(value === null
          ? { themeOverride: { textDark: theme.textLight, baseFontStyle: "italic 12px" } }
          : {}),
      };
    },
    [result.rows, result.columns, rowIndices, theme.textLight],
  );

  const rows = rowIndices?.length ?? result.rows.length;
  const nearBottom = useCallback(
    (region: Rectangle) => {
      if (canFetch && !filter && region.y + region.height >= rows - 48) onMore();
    },
    [canFetch, filter, onMore, rows],
  );
  useEffect(() => {
    if (visible.current) nearBottom(visible.current);
  }, [nearBottom]);

  return (
    <div
      className="grid-container"
      title={nativeType}
      aria-label="Query results"
      data-row-count={rows}
    >
      <DataEditor
        ref={editor}
        width="100%"
        height="100%"
        columns={columns}
        rows={rows}
        rowHeight={25}
        headerHeight={29}
        rowMarkers={{ kind: "both", width: 58 }}
        getCellContent={getCell}
        getCellsForSelection={true}
        theme={theme}
        onVisibleRegionChanged={(region) => {
          visible.current = region;
          nearBottom(region);
        }}
        onColumnResize={(_, width, index) =>
          setWidths((current) => ({ ...current, [index]: width }))
        }
        onCellActivated={([column, row]) => onCell(rowIndices?.[row] ?? row, column)}
        onItemHovered={(item) =>
          setNativeType(
            item.kind === "header" ? (result.columns[item.location[0]]?.db_type ?? "") : "",
          )
        }
        onHeaderClicked={(column) =>
          setSort((current) =>
            current?.column === column
              ? { column, descending: !current.descending }
              : { column, descending: false },
          )
        }
        getRowThemeOverride={(row) => (row % 2 ? { bgCell: theme.bgCellMedium } : undefined)}
      />
      {sort && <span className="grid-note">Fetched rows sorted locally</span>}
    </div>
  );
}
