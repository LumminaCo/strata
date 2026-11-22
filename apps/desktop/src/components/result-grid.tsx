import {
  DataEditor,
  GridCellKind,
  type DataEditorRef,
  type GridCell,
  type GridSelection,
  type Item,
  type Rectangle,
} from "@glideapps/glide-data-grid";
import "@glideapps/glide-data-grid/dist/index.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { errorMessage } from "@/ipc/client";
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
  readCell,
  filter,
}: {
  result: ResultSet;
  themeVersion: string;
  canFetch: boolean;
  onMore: () => void;
  onCell: (row: number, column: number) => void;
  readCell?: (row: number, column: number) => Promise<Cell>;
  filter: string;
}) {
  const [widths, setWidths] = useState<Record<number, number>>({});
  const [sort, setSort] = useState<{ column: number; descending: boolean }>();
  const [selection, setSelection] = useState<GridSelection>();
  const [copyError, setCopyError] = useState("");
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

  async function copy(format: string) {
    const range = selection?.current?.range;
    const positions = range
      ? Array.from({ length: range.height }, (_, index) => range.y + index)
      : selection?.rows.length
        ? selection.rows.toArray()
        : Array.from({ length: rows }, (_, index) => index);
    const fields = range
      ? Array.from({ length: range.width }, (_, index) => range.x + index)
      : selection?.columns.length
        ? selection.columns.toArray()
        : columns.map((_, index) => index);
    const names = fields.map((column) => result.columns[column]?.name ?? "");
    try {
      setCopyError("");
      const values = positions.map((row) =>
        fields.map((column) => result.rows[rowIndices?.[row] ?? row]?.[column] ?? null),
      );
      if (readCell) {
        for (let y = 0; y < values.length; y++) {
          const row = values[y];
          if (!row) continue;
          for (let x = 0; x < row.length; x++) {
            const cell = row[x];
            const position = positions[y];
            const field = fields[x];
            if (
              typeof cell === "string" &&
              position !== undefined &&
              field !== undefined &&
              ((cell.length >= 2_000 && cell.endsWith("…")) ||
                result.columns[field]?.kind === "binary")
            ) {
              row[x] = await readCell(rowIndices?.[position] ?? position, field);
            }
          }
        }
      }
      const csv = (cell: Cell) => `"${String(cell ?? "").replaceAll('"', '""')}"`;
      const markdown = (cell: Cell) =>
        String(cell ?? "NULL")
          .replaceAll("|", "\\|")
          .replace(/\r?\n/g, "<br>");
      const line = (items: Cell[]) => `| ${items.map(markdown).join(" | ")} |`;
      const body =
        format === "json"
          ? JSON.stringify({ columns: names, rows: values }, null, 2)
          : format === "markdown"
            ? [line(names), line(names.map(() => "---")), ...values.map(line)].join("\n")
            : [names, ...values].map((row) => row.map(csv).join(",")).join("\n");
      await navigator.clipboard.writeText(body);
    } catch (error) {
      setCopyError(errorMessage(error));
    }
  }

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
        gridSelection={selection}
        onGridSelectionChange={setSelection}
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
      {readCell && rows > 0 && (
        <div className="grid-copy">
          <NativeSelect
            aria-label="Copy as"
            size="sm"
            value=""
            onChange={(event) => void copy(event.target.value)}
          >
            <NativeSelectOption value="" disabled>
              Copy as
            </NativeSelectOption>
            <NativeSelectOption value="csv">CSV</NativeSelectOption>
            <NativeSelectOption value="json">JSON</NativeSelectOption>
            <NativeSelectOption value="markdown">Markdown</NativeSelectOption>
          </NativeSelect>
          {copyError && <span role="alert">{copyError}</span>}
        </div>
      )}
      {sort && <span className="grid-note">Fetched rows sorted locally</span>}
    </div>
  );
}
