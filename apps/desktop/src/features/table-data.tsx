import { useEffect, useRef, useState } from "react";

import { ResultGrid, loadResultGrid } from "@/components/load-result-grid";
import {
  readAggregateFunction,
  saveAggregateFunction,
  type AggregateFunction,
  type NumericAggregateSummary,
} from "@/components/numeric-aggregate";
import { NumericAggregateBar } from "@/components/numeric-aggregate-bar";
import type { ResultSet } from "@/components/result-grid";
import { Button } from "@/components/ui/button";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import type { CatalogScope, Cell, ColumnMeta, ForeignKeyRef } from "@/ipc/bindings/protocol";
import { dispatch, errorMessage, runQuery } from "@/ipc/client";

import type { CatalogEntry } from "./catalog-explorer";
import { needsFullCellRead } from "./foreign-key-query";
import { ResultFilterInput } from "./result-filter-input";
import { compileSqlWhereExpression } from "./result-query";

export function quoteName(name: string, kind: CatalogEntry["connection"]["kind"]) {
  return kind === "sqlserver"
    ? `[${name.replaceAll("]", "]]")}]`
    : `"${name.replaceAll('"', '""')}"`;
}

export function buildTableDataQuery(options: {
  table: string;
  kind: CatalogEntry["connection"]["kind"];
  columns: readonly ColumnMeta[];
  filter?: string;
  order?: string;
  countOnly?: boolean;
}): string {
  const compiledFilter = options.filter
    ? compileSqlWhereExpression(options.filter, options.columns, options.kind)
    : "";
  const predicate = compiledFilter ? ` WHERE (${compiledFilter})` : "";
  if (options.countOnly) {
    return `SELECT COUNT(*) FROM ${options.table}${predicate}`;
  }
  const ordering = options.order ? ` ORDER BY ${quoteName(options.order, options.kind)}` : "";
  return `SELECT * FROM ${options.table}${predicate}${ordering}`;
}

function tableName(entry: CatalogEntry) {
  return [entry.object.schema, entry.object.name]
    .map((name) => quoteName(name, entry.connection.kind))
    .join(".");
}

interface Props {
  entry: CatalogEntry;
  theme: string;
  credentials: () => Promise<CatalogScope>;
  onValue: (name: string, value: Cell, kind?: string) => void;
  onFollowForeignKey?: (options: {
    entry: CatalogEntry;
    target: ForeignKeyRef;
    value: Cell;
    columnKind?: string;
  }) => void;
}

export function TableData({ entry, theme, credentials, onValue, onFollowForeignKey }: Props) {
  const [filter, setFilter] = useState("");
  const [order, setOrder] = useState("");
  const [applied, setApplied] = useState({ filter: "", order: "", version: 0 });
  const [result, setResult] = useState<ResultSet>();
  const [knownColumns, setKnownColumns] = useState<ColumnMeta[]>([]);
  const [busy, setBusy] = useState(true);
  const [fetching, setFetching] = useState(false);
  const [error, setError] = useState("");
  const [count, setCount] = useState<Cell>();
  const [gridAggregate, setGridAggregate] = useState<NumericAggregateSummary | null>(null);
  const [aggregateFn, setAggregateFn] = useState<AggregateFunction>(readAggregateFunction);
  const session = useRef<string | undefined>(undefined);
  const running = useRef(false);
  const lifetime = useRef<AbortController | null>(null);
  const columnsRef = useRef<ColumnMeta[]>([]);
  const latest = useRef(credentials);
  latest.current = credentials;
  const name = tableName(entry);
  const kind = entry.connection.kind;

  useEffect(() => {
    columnsRef.current = [];
    setKnownColumns([]);
  }, [name, entry.database, entry.connection.id]);

  useEffect(() => {
    const lifetime = new AbortController();
    session.current = undefined;
    running.current = true;
    setBusy(true);
    setFetching(false);
    setError("");
    setResult(undefined);
    let id: string | undefined;
    async function load() {
      try {
        const scope = await latest.current();
        if (lifetime.signal.aborted) return;
        const connected = await dispatch("open_inspection_session", { scope });
        id = connected.id;
        if (lifetime.signal.aborted) {
          await dispatch("close_session", { sessionId: id });
          return;
        }
        session.current = id;
        const text = buildTableDataQuery({
          table: name,
          kind,
          columns: columnsRef.current,
          filter: applied.filter,
          order: applied.order,
        });
        let cursor: string | undefined;
        await loadResultGrid();
        if (lifetime.signal.aborted) return;
        await runQuery(
          {
            runId: crypto.randomUUID(),
            sessionId: id,
            text,
            target: { selection: [0, text.length] },
            mode: "statement",
            confirmed: false,
          },
          (event) => {
            if (lifetime.signal.aborted) return;
            switch (event.type) {
              case "resultStart":
                cursor = event.cursorId;
                columnsRef.current = event.columns;
                setKnownColumns(event.columns);
                setResult({
                  id: cursor,
                  columns: event.columns,
                  index: 0,
                  rows: event.rows,
                  more: false,
                  capped: false,
                });
                break;
              case "rows":
                if (event.cursorId === cursor)
                  setResult((state) => state && { ...state, rows: [...state.rows, ...event.rows] });
                break;
              case "resultPaused":
              case "resultEnd":
                if (event.cursorId === cursor)
                  setResult(
                    (state) =>
                      state && {
                        ...state,
                        more: event.type === "resultPaused",
                        capped: event.type === "resultEnd" && event.capped,
                      },
                  );
                break;
              case "error":
                setError(event.error.message);
            }
          },
        );
      } catch (error) {
        if (!lifetime.signal.aborted) setError(errorMessage(error));
      } finally {
        if (!lifetime.signal.aborted) {
          running.current = false;
          setBusy(false);
        }
      }
    }
    void load();
    return () => {
      lifetime.abort();
      if (id) void dispatch("close_session", { sessionId: id }).catch(() => {});
    };
  }, [name, kind, applied, entry.database, entry.connection.id]);

  useEffect(() => {
    const handle = new AbortController();
    lifetime.current = handle;
    return () => handle.abort();
  }, []);

  async function fetchRows() {
    const sessionId = session.current;
    if (running.current || !result?.more || !sessionId) return;
    running.current = true;
    setBusy(true);
    setFetching(true);
    try {
      const page = await dispatch("fetch_more", { sessionId, cursorId: result.id, count: 500 });
      if (session.current !== sessionId || lifetime.current?.signal.aborted) return;
      setResult(
        (state) =>
          state && {
            ...state,
            rows: [...state.rows, ...page.rows],
            more: !page.exhausted,
            capped: page.capped,
          },
      );
    } catch (error) {
      if (session.current === sessionId && !lifetime.current?.signal.aborted) {
        setError(errorMessage(error));
      }
    } finally {
      if (session.current === sessionId && !lifetime.current?.signal.aborted) {
        running.current = false;
        setBusy(false);
        setFetching(false);
      }
    }
  }

  async function countRows() {
    let id: string | undefined;
    try {
      const scope = await latest.current();
      id = (await dispatch("open_inspection_session", { scope })).id;
      const text = buildTableDataQuery({
        table: name,
        kind,
        columns: columnsRef.current,
        filter: applied.filter,
        countOnly: true,
      });
      await runQuery(
        {
          runId: crypto.randomUUID(),
          sessionId: id,
          text,
          target: { selection: [0, text.length] },
          mode: "statement",
          confirmed: false,
        },
        (event) => {
          if (lifetime.current?.signal.aborted) return;
          if (event.type === "resultStart") setCount(event.rows[0]?.[0]);
          if (event.type === "error") setError(event.error.message);
        },
      );
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      if (id) await dispatch("close_session", { sessionId: id }).catch(() => {});
    }
  }

  async function value(row: number, column: number) {
    const sessionId = session.current;
    const meta: ColumnMeta | undefined = result?.columns[column];
    if (!result || !sessionId || !meta) return;
    try {
      const cell = await dispatch("get_cell", { sessionId, cursorId: result.id, row, column });
      if (session.current === sessionId && !lifetime.current?.signal.aborted)
        onValue(meta.name, cell, meta.kind);
    } catch (error) {
      setError(errorMessage(error));
    }
  }

  async function followForeignKey(row: number, column: number) {
    if (!onFollowForeignKey || !result) return;
    const meta: ColumnMeta | undefined = result.columns[column];
    const target = meta?.foreign_key;
    if (!meta || !target) return;
    let cell = result.rows[row]?.[column] ?? null;
    if (cell === null) return;
    const sessionId = session.current;
    if (sessionId && needsFullCellRead(cell, meta.kind)) {
      try {
        cell = await dispatch("get_cell", { sessionId, cursorId: result.id, row, column });
      } catch (error) {
        setError(errorMessage(error));
        return;
      }
    }
    if (cell === null) return;
    onFollowForeignKey({ entry, target, value: cell, columnKind: meta.kind });
  }

  const availableColumns = result?.columns ?? knownColumns;

  return (
    <div className="table-data">
      <form
        className="table-filters"
        onSubmit={(event) => {
          event.preventDefault();
          setApplied((state) => ({ filter: filter.trim(), order, version: state.version + 1 }));
          setCount(undefined);
        }}
      >
        <ResultFilterInput
          ariaLabel="WHERE expression"
          placeholder="WHERE expression"
          value={filter}
          columns={availableColumns}
          rows={result?.rows ?? []}
          dialect={kind}
          onChange={setFilter}
          onSubmit={() => {
            setApplied((state) => ({ filter: filter.trim(), order, version: state.version + 1 }));
            setCount(undefined);
          }}
        />
        <NativeSelect
          aria-label="Order by column"
          value={order}
          onChange={(event) => setOrder(event.target.value)}
        >
          <NativeSelectOption value="">Order by</NativeSelectOption>
          {availableColumns.map((column) => (
            <NativeSelectOption value={column.name} key={column.name}>
              {column.name}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <Button type="submit" variant="outline">
          Apply
        </Button>
        <Button type="button" variant="ghost" onClick={() => void countRows()}>
          Count rows
        </Button>
      </form>
      {error && (
        <p className="table-error" role="alert">
          {error}
        </p>
      )}
      {result ? (
        <ResultGrid
          result={result}
          canFetch={result.more && !busy && !error}
          fetching={fetching}
          filter=""
          themeVersion={theme}
          onMore={() => void fetchRows()}
          onCell={(row, column) => void value(row, column)}
          onFollowForeignKey={
            onFollowForeignKey ? (row, column) => void followForeignKey(row, column) : undefined
          }
          onAggregateChange={setGridAggregate}
        />
      ) : (
        <div className="results-empty">{busy ? "Loading table data…" : "No data to display."}</div>
      )}
      <div className="table-data-status" role="status">
        <span>
          {result?.rows.length ?? 0} loaded
          {count !== undefined
            ? ` · ${String(count)} total`
            : entry.object.rows !== null
              ? ` · ${entry.object.rows} estimated`
              : ""}
          {fetching ? " · Fetching rows…" : ""}
        </span>
        {result?.more && (
          <Button variant="ghost" size="xs" disabled={busy} onClick={() => void fetchRows()}>
            Fetch more
          </Button>
        )}
        {result && gridAggregate && (
          <NumericAggregateBar
            summary={gridAggregate}
            fn={aggregateFn}
            onChangeFn={(next) => {
              saveAggregateFunction(next);
              setAggregateFn(next);
            }}
          />
        )}
      </div>
    </div>
  );
}
