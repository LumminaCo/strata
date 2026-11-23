import { useEffect, useRef, useState } from "react";

import { ResultGrid, loadResultGrid } from "@/components/load-result-grid";
import type { ResultSet } from "@/components/result-grid";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import type { CatalogScope, Cell, ColumnMeta } from "@/ipc/bindings/protocol";
import { dispatch, errorMessage, runQuery } from "@/ipc/client";

import type { CatalogEntry } from "./catalog-explorer";

export function quoteName(name: string, kind: CatalogEntry["connection"]["kind"]) {
  return kind === "sqlserver"
    ? `[${name.replaceAll("]", "]]")}]`
    : `"${name.replaceAll('"', '""')}"`;
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
}

export function TableData({ entry, theme, credentials, onValue }: Props) {
  const [filter, setFilter] = useState("");
  const [order, setOrder] = useState("");
  const [applied, setApplied] = useState({ filter: "", order: "", version: 0 });
  const [result, setResult] = useState<ResultSet>();
  const [busy, setBusy] = useState(true);
  const [fetching, setFetching] = useState(false);
  const [error, setError] = useState("");
  const [count, setCount] = useState<Cell>();
  const session = useRef<string | undefined>(undefined);
  const running = useRef(false);
  const lifetime = useRef<AbortController | null>(null);
  const latest = useRef(credentials);
  latest.current = credentials;
  const name = tableName(entry);
  const kind = entry.connection.kind;

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
        const predicate = applied.filter ? ` WHERE (${applied.filter})` : "";
        const ordering = applied.order ? ` ORDER BY ${quoteName(applied.order, kind)}` : "";
        const text = `SELECT * FROM ${name}${predicate}${ordering}`;
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
      const predicate = applied.filter ? ` WHERE (${applied.filter})` : "";
      const text = `SELECT COUNT(*) FROM ${name}${predicate}`;
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
        <Input
          aria-label="WHERE expression"
          placeholder="WHERE expression"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
        <NativeSelect
          aria-label="Order by column"
          value={order}
          onChange={(event) => setOrder(event.target.value)}
        >
          <NativeSelectOption value="">Order by</NativeSelectOption>
          {result?.columns.map((column) => (
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
      </div>
    </div>
  );
}
