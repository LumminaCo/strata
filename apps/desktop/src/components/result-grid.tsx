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
import { ArrowDown, ArrowUp, Filter, LoaderCircle, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import {
  computeRowIndices,
  formatSortHeader,
  removeColumnSort,
  setColumnSort,
  toggleColumnSort,
  type ResultFilter,
  type SortRule,
} from "@/features/result-query";
import { errorMessage } from "@/ipc/client";
import type { Cell, ColumnMeta } from "@/ipc/bindings/protocol";
import { gridTheme } from "@/theme/glide";

import { fkCellRenderer, isPointInFkButton } from "./fk-cell-renderer";
import { summarizeSelection, type NumericAggregateSummary } from "./numeric-aggregate";

export interface ResultSet {
  id: string;
  index: number;
  title?: string;
  columns: ColumnMeta[];
  rows: Cell[][];
  more: boolean;
  capped: boolean;
}

const numeric = new Set(["int", "float", "decimal"]);
const customRenderers = [fkCellRenderer];

interface HeaderMenuState {
  column: number;
  x: number;
  y: number;
}

export function ResultGrid({
  result,
  themeVersion,
  canFetch,
  fetching = false,
  onMore,
  onCell,
  onFollowForeignKey,
  readCell,
  onAggregateChange,
  filter,
  filters,
  sorts: controlledSorts,
  onSortsChange,
  onFilterByColumn,
  onRowCountChange,
}: {
  result: ResultSet;
  themeVersion: string;
  canFetch: boolean;
  fetching?: boolean;
  onMore: () => void;
  onCell: (row: number, column: number) => void;
  onFollowForeignKey?: (row: number, column: number) => void;
  readCell?: (row: number, column: number) => Promise<Cell>;
  onAggregateChange?: (summary: NumericAggregateSummary | null) => void;
  filter: string;
  filters?: readonly ResultFilter[];
  sorts?: readonly SortRule[];
  onSortsChange?: (sorts: SortRule[]) => void;
  onFilterByColumn?: (columnName: string) => void;
  onRowCountChange?: (count: number) => void;
}) {
  const [widths, setWidths] = useState<Record<number, number>>({});
  const [internalSorts, setInternalSorts] = useState<SortRule[]>([]);
  const [selection, setSelection] = useState<GridSelection>();
  const [copyError, setCopyError] = useState("");
  const [nativeType, setNativeType] = useState("");
  const [headerMenu, setHeaderMenu] = useState<HeaderMenuState | null>(null);
  const editor = useRef<DataEditorRef>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const visible = useRef<Rectangle | null>(null);
  const [theme, setTheme] = useState(gridTheme);
  useEffect(() => setTheme(gridTheme()), [themeVersion]);

  const sorts = controlledSorts ?? internalSorts;
  const updateSorts = useCallback(
    (next: SortRule[] | ((current: readonly SortRule[]) => SortRule[])) => {
      if (onSortsChange) {
        const resolved = typeof next === "function" ? next(sorts) : next;
        onSortsChange(resolved);
      } else {
        setInternalSorts((current) => (typeof next === "function" ? next(current) : next));
      }
    },
    [onSortsChange, sorts],
  );

  useEffect(() => {
    if (!headerMenu) return;
    const onPointerDown = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setHeaderMenu(null);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setHeaderMenu(null);
    };
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [headerMenu]);

  const columns = useMemo(
    () =>
      result.columns.map((column, index) => {
        const fkExtra = onFollowForeignKey && column.foreign_key ? 24 : 0;
        return {
          id: String(index),
          title: formatSortHeader(column.name, sorts, index),
          width:
            widths[index] ?? Math.min(360, Math.max(115, column.name.length * 9 + 34 + fkExtra)),
        };
      }),
    [onFollowForeignKey, result.columns, sorts, widths],
  );

  const { indices: rowIndices, activeFilterCount } = useMemo(
    () =>
      computeRowIndices(result.rows, result.columns, {
        filters,
        draftFilter: filter,
        sorts,
      }),
    [filter, filters, result.columns, result.rows, sorts],
  );

  const getCell = useCallback(
    ([column, row]: Item): GridCell => {
      const columnMeta = result.columns[column];
      const value = result.rows[rowIndices?.[row] ?? row]?.[column] ?? null;
      const displayData = value === null ? "NULL" : String(value);
      const align = numeric.has(columnMeta?.kind ?? "") ? "right" : "left";
      if (onFollowForeignKey && columnMeta?.foreign_key && value !== null) {
        return {
          kind: GridCellKind.Custom,
          allowOverlay: false,
          readonly: true,
          copyData: displayData,
          contentAlign: align,
          data: {
            kind: "foreign-key" as const,
            displayData,
            target: columnMeta.foreign_key,
            align,
          },
        };
      }
      return {
        kind: GridCellKind.Text,
        data: value === null ? "" : displayData,
        displayData,
        readonly: true,
        allowOverlay: false,
        contentAlign: align,
        ...(value === null
          ? { themeOverride: { textDark: theme.textLight, baseFontStyle: "italic 12px" } }
          : {}),
      };
    },
    [onFollowForeignKey, result.rows, result.columns, rowIndices, theme.textLight],
  );

  const rows = rowIndices?.length ?? result.rows.length;
  useEffect(() => {
    onRowCountChange?.(rows);
  }, [onRowCountChange, rows]);
  const aggregateSummary = useMemo(
    () =>
      summarizeSelection({
        selection,
        rows: result.rows,
        columns: result.columns,
        rowIndices,
      }),
    [result.columns, result.rows, rowIndices, selection],
  );
  const onAggregateChangeRef = useRef(onAggregateChange);
  onAggregateChangeRef.current = onAggregateChange;
  useEffect(() => {
    onAggregateChangeRef.current?.(aggregateSummary);
  }, [aggregateSummary]);
  useEffect(() => () => onAggregateChangeRef.current?.(null), []);
  const nearBottom = useCallback(
    (region: Rectangle) => {
      if (canFetch && activeFilterCount === 0 && region.y + region.height >= rows - 48) onMore();
    },
    [activeFilterCount, canFetch, onMore, rows],
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

  const menuColumn = headerMenu ? result.columns[headerMenu.column] : undefined;
  const menuColumnSort = headerMenu
    ? sorts.find((rule) => rule.column === headerMenu.column)
    : undefined;
  const hasOtherSorts = headerMenu
    ? sorts.some((rule) => rule.column !== headerMenu.column)
    : false;

  return (
    <div
      ref={containerRef}
      className="grid-container"
      title={nativeType}
      aria-label="Query results"
      aria-busy={fetching || undefined}
      data-row-count={rows}
      data-fetching={fetching}
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
        customRenderers={customRenderers}
        getCellsForSelection={true}
        rangeSelect="multi-rect"
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
        onCellClicked={([column, row], event) => {
          if (!onFollowForeignKey || event.button !== 0) return;
          const columnMeta = result.columns[column];
          if (!columnMeta?.foreign_key) return;
          const sourceRow = rowIndices?.[row] ?? row;
          const value = result.rows[sourceRow]?.[column] ?? null;
          if (value === null) return;
          if (
            isPointInFkButton(
              event.localEventX,
              event.localEventY,
              event.bounds.width,
              event.bounds.height,
            )
          ) {
            event.preventDefault();
            onFollowForeignKey(sourceRow, column);
          }
        }}
        onCellActivated={([column, row]) => onCell(rowIndices?.[row] ?? row, column)}
        onItemHovered={(item) => {
          if (item.kind === "header") {
            const col = result.columns[item.location[0]];
            if (!col) {
              setNativeType("");
              return;
            }
            setNativeType(
              col.foreign_key
                ? `${col.db_type} · FK -> ${col.foreign_key.schema}.${col.foreign_key.table}.${col.foreign_key.column}`
                : col.db_type,
            );
            return;
          }
          if (item.kind === "cell" && onFollowForeignKey) {
            const [colIndex, rowIndex] = item.location;
            const col = result.columns[colIndex];
            const fk = col?.foreign_key;
            if (fk) {
              const sourceRow = rowIndices?.[rowIndex] ?? rowIndex;
              const value = result.rows[sourceRow]?.[colIndex] ?? null;
              if (value !== null) {
                setNativeType(
                  `Open ${fk.schema}.${fk.table} where ${fk.column} = ${String(value)}`,
                );
                return;
              }
            }
          }
          setNativeType("");
        }}
        onHeaderClicked={(column) => {
          setHeaderMenu(null);
          updateSorts((current) => toggleColumnSort(current, column));
        }}
        onHeaderContextMenu={(column, event) => {
          event.preventDefault();
          const rect = containerRef.current?.getBoundingClientRect();
          const rawX = event.bounds.x + event.localEventX - (rect?.left ?? 0);
          const rawY = event.bounds.y + event.localEventY - (rect?.top ?? 0);
          const maxX = Math.max(8, (rect?.width ?? 300) - 210);
          const maxY = Math.max(8, (rect?.height ?? 200) - 180);
          setHeaderMenu({
            column,
            x: Math.max(4, Math.min(rawX, maxX)),
            y: Math.max(4, Math.min(rawY, maxY)),
          });
        }}
        getRowThemeOverride={(row) => (row % 2 ? { bgCell: theme.bgCellMedium } : undefined)}
      />
      {headerMenu && menuColumn && (
        <div
          ref={menuRef}
          role="menu"
          aria-label={`Column ${menuColumn.name} actions`}
          className="grid-header-menu"
          style={{ left: `${headerMenu.x}px`, top: `${headerMenu.y}px` }}
        >
          <div className="grid-header-menu-title">{menuColumn.name}</div>
          <button
            type="button"
            role="menuitem"
            className="grid-header-menu-item"
            onClick={() => {
              updateSorts((current) => setColumnSort(current, headerMenu.column, false));
              setHeaderMenu(null);
            }}
          >
            <ArrowUp />
            <span>{hasOtherSorts && !menuColumnSort ? "Add to sort (ASC)" : "Sort ascending"}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="grid-header-menu-item"
            onClick={() => {
              updateSorts((current) => setColumnSort(current, headerMenu.column, true));
              setHeaderMenu(null);
            }}
          >
            <ArrowDown />
            <span>
              {hasOtherSorts && !menuColumnSort ? "Add to sort (DESC)" : "Sort descending"}
            </span>
          </button>
          {hasOtherSorts && (
            <>
              <div className="grid-header-menu-sep" role="separator" />
              <button
                type="button"
                role="menuitem"
                className="grid-header-menu-item"
                onClick={() => {
                  updateSorts((current) =>
                    setColumnSort(current, headerMenu.column, false, { replace: true }),
                  );
                  setHeaderMenu(null);
                }}
              >
                <ArrowUp />
                <span>Sort only by this (ASC)</span>
              </button>
              <button
                type="button"
                role="menuitem"
                className="grid-header-menu-item"
                onClick={() => {
                  updateSorts((current) =>
                    setColumnSort(current, headerMenu.column, true, { replace: true }),
                  );
                  setHeaderMenu(null);
                }}
              >
                <ArrowDown />
                <span>Sort only by this (DESC)</span>
              </button>
            </>
          )}
          {(menuColumnSort || sorts.length > 0) && (
            <>
              <div className="grid-header-menu-sep" role="separator" />
              {menuColumnSort && (
                <button
                  type="button"
                  role="menuitem"
                  className="grid-header-menu-item"
                  onClick={() => {
                    updateSorts((current) => removeColumnSort(current, headerMenu.column));
                    setHeaderMenu(null);
                  }}
                >
                  <X />
                  <span>Remove sort</span>
                </button>
              )}
              {sorts.length > 0 && (
                <button
                  type="button"
                  role="menuitem"
                  className="grid-header-menu-item"
                  onClick={() => {
                    updateSorts([]);
                    setHeaderMenu(null);
                  }}
                >
                  <X />
                  <span>Clear all sorting</span>
                </button>
              )}
            </>
          )}
          {onFilterByColumn && (
            <>
              <div className="grid-header-menu-sep" role="separator" />
              <button
                type="button"
                role="menuitem"
                className="grid-header-menu-item"
                onClick={() => {
                  onFilterByColumn(menuColumn.name);
                  setHeaderMenu(null);
                }}
              >
                <Filter />
                <span>Filter by column…</span>
              </button>
            </>
          )}
        </div>
      )}
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
      {fetching && (
        <div className="grid-fetching" role="status" aria-live="polite">
          <LoaderCircle className="grid-fetching-icon" aria-hidden="true" />
          <span>Fetching rows…</span>
        </div>
      )}
      {sorts.length > 0 && (
        <div className="grid-note">
          <span>
            Fetched rows sorted locally ({sorts.length} {sorts.length === 1 ? "column" : "columns"})
          </span>
          <button
            type="button"
            className="grid-note-clear"
            aria-label="Clear local sort"
            onClick={() => updateSorts([])}
          >
            Clear
          </button>
        </div>
      )}
    </div>
  );
}
