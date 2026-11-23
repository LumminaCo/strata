import {
  ChevronDown,
  ChevronRight,
  Database,
  Folder,
  Table2,
  FileCode2,
  RefreshCw,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { DatabaseIcon } from "@/components/database-icon";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type {
  CatalogScope,
  CatalogSnapshot,
  Connection,
  Object as CatalogObject,
} from "@/ipc/bindings/protocol";
import { dispatch, errorMessage } from "@/ipc/client";

export interface CatalogEntry {
  connection: Connection;
  database: string;
  object: CatalogObject;
}

type Kind = "connection" | "database" | "schema" | "group" | "object";
interface Node {
  key: string;
  kind: Kind;
  label: string;
  connection: Connection;
  database: string;
  schema?: string;
  children?: Node[];
  object?: CatalogObject;
}

const groups: Record<CatalogObject["kind"], string> = {
  table: "Tables",
  view: "Views",
  materialized_view: "Materialized views",
  foreign_table: "Foreign tables",
  function: "Functions",
  procedure: "Procedures",
  sequence: "Sequences",
  synonym: "Synonyms",
};
const rowHeight = 29;

interface Props {
  profiles: Connection[];
  active?: string | null;
  revision: number;
  scope: (connection: Connection, database?: string, prompt?: boolean) => Promise<CatalogScope>;
  onSnapshot: (
    connectionId: string,
    database: string,
    schema: string,
    snapshot: CatalogSnapshot,
  ) => void;
  onEntries: (entries: CatalogEntry[]) => void;
  openSql: (connectionId: string, database?: string, text?: string) => void;
  onRefresh: () => void;
  onObject?: (entry: CatalogEntry) => void;
}

export function CatalogExplorer({
  profiles,
  active,
  revision,
  scope,
  onSnapshot,
  onEntries,
  openSql,
  onRefresh,
  onObject,
}: Props) {
  const [filter, setFilter] = useState("");
  const [expanded, setExpanded] = useState(new Set<string>());
  const [children, setChildren] = useState<Record<string, Node[]>>({});
  const [loading, setLoading] = useState(new Set<string>());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [area, setArea] = useState({ y: 0, height: 300 });
  const scroller = useRef<HTMLDivElement>(null);
  const requests = useRef(new Map<string, object>());
  const loads = useRef(new Map<string, Node>());
  const roots = useMemo(() => {
    const nodes: Node[] = [];
    const folders = new Map<string, Node>();
    for (const connection of profiles) {
      if (!connection.id) continue;
      const node: Node = {
        connection,
        database: connection.database,
        key: nodeKey(connection.id),
        label: connection.name,
        kind: "connection",
      };
      if (!connection.folder) {
        nodes.push(node);
        continue;
      }
      let folder = folders.get(connection.folder);
      if (!folder) {
        folder = {
          ...node,
          key: nodeKey("folder", connection.folder),
          label: connection.folder,
          kind: "group",
          children: [],
        };
        folders.set(connection.folder, folder);
        nodes.push(folder);
      }
      folder.children?.push(node);
    }
    return nodes;
  }, [profiles]);

  useEffect(() => {
    const area = scroller.current;
    if (!area) return;
    const observer = new ResizeObserver(() =>
      setArea({ y: area.scrollTop, height: area.clientHeight }),
    );
    observer.observe(area);
    return () => observer.disconnect();
  }, []);

  async function load(node: Node, prompt: boolean) {
    if (node.kind === "group" || node.kind === "object") return;
    const request = {};
    loads.current.set(node.key, node);
    requests.current.set(node.key, request);
    setLoading((current) => new Set(current).add(node.key));
    setErrors((current) => ({ ...current, [node.key]: "" }));
    try {
      const args = await scope(node.connection, node.database, prompt);
      let nodes: Node[];
      switch (node.kind) {
        case "connection": {
          const databases = await dispatch("list_databases", { scope: args });
          nodes = [...new Set([node.database, ...databases])].map((database) => ({
            ...node,
            database,
            key: nodeKey(node.key, database),
            label: database,
            kind: "database",
          }));
          break;
        }
        case "database": {
          const schemas = await dispatch("list_schemas", { scope: args });
          nodes = schemas.map((schema) => ({
            ...node,
            schema,
            key: nodeKey(node.key, schema),
            label: schema,
            kind: "schema",
          }));
          break;
        }
        case "schema": {
          const schema = node.schema ?? node.label;
          const snapshot = await dispatch("catalog_snapshot", { scope: args, schema });
          if (requests.current.get(node.key) !== request) return;
          if (node.connection.id) onSnapshot(node.connection.id, node.database, schema, snapshot);
          const categories = new Map<string, Node[]>();
          for (const object of snapshot.objects) {
            const category = groups[object.kind];
            const objects = categories.get(category) ?? [];
            objects.push({
              ...node,
              object,
              key: nodeKey(node.key, String(object.oid), object.name),
              label: object.name,
              kind: "object",
            });
            categories.set(category, objects);
          }
          nodes = [...categories].map(([label, objects]) => ({
            ...node,
            kind: "group",
            label,
            key: nodeKey(node.key, label),
            children: objects,
          }));
          break;
        }
      }
      if (requests.current.get(node.key) === request)
        setChildren((current) => ({ ...current, [node.key]: nodes }));
    } catch (error) {
      if (requests.current.get(node.key) === request)
        setErrors((current) => ({ ...current, [node.key]: errorMessage(error) }));
    } finally {
      if (requests.current.get(node.key) === request) {
        requests.current.delete(node.key);
        setLoading((current) => {
          const next = new Set(current);
          next.delete(node.key);
          return next;
        });
      }
    }
  }

  const latest = useRef(load);
  latest.current = load;
  useEffect(() => {
    for (const node of loads.current.values()) {
      const current = profiles.find((connection) => connection.id === node.connection.id);
      if (current) void latest.current({ ...node, connection: current }, false);
    }
  }, [revision, profiles]);

  useEffect(() => {
    const entries: CatalogEntry[] = [];
    for (const loaded of Object.values(children)) {
      for (const group of loaded) {
        if (!profiles.some((connection) => connection.id === group.connection.id)) continue;
        for (const item of group.children ?? []) {
          if (item.object)
            entries.push({
              connection: item.connection,
              database: item.database,
              object: item.object,
            });
        }
      }
    }
    onEntries(entries);
  }, [children, profiles, onEntries]);

  function toggle(node: Node) {
    if (
      !expanded.has(node.key) &&
      !node.children &&
      !children[node.key] &&
      !requests.current.has(node.key)
    ) {
      void load(node, true);
    }
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(node.key)) next.delete(node.key);
      else next.add(node.key);
      return next;
    });
  }

  const needle = filter.trim().toLowerCase();
  const rows: { node: Node; depth: number }[] = [];
  function append(node: Node, depth: number): boolean {
    const index = rows.length;
    rows.push({ node, depth });
    let childMatches = false;
    if (expanded.has(node.key) || needle) {
      for (const child of node.children ?? children[node.key] ?? [])
        childMatches = append(child, depth + 1) || childMatches;
    }
    if (!needle || childMatches || node.label.toLowerCase().includes(needle)) return true;
    rows.splice(index);
    return false;
  }
  for (const node of roots) append(node, 0);
  const first = Math.max(0, Math.floor(area.y / rowHeight) - 5);
  const end = Math.min(rows.length, Math.ceil((area.y + area.height) / rowHeight) + 5);
  const currentProfile = profiles.find((connection) => connection.id === active);

  async function refresh() {
    if (!currentProfile?.id) return;
    try {
      await dispatch("refresh_metadata", { connectionId: currentProfile.id });
      onRefresh();
    } catch (error) {
      const root = nodeKey(currentProfile.id);
      setErrors((current) => ({ ...current, [root]: errorMessage(error) }));
    }
  }

  return (
    <div
      className="catalog-explorer"
      onKeyDown={(event) => {
        if (event.key === "F5" && currentProfile) {
          event.preventDefault();
          void refresh();
        }
      }}
    >
      <div className="catalog-filter">
        <Input
          aria-label="Filter loaded objects"
          placeholder="Filter objects"
          value={filter}
          onChange={(event) => {
            setFilter(event.target.value);
            if (scroller.current) scroller.current.scrollTop = 0;
          }}
        />
        <Button
          variant="ghost"
          size="icon-xs"
          disabled={!currentProfile}
          aria-label="Refresh metadata"
          title="Refresh metadata (F5)"
          onClick={() => void refresh()}
        >
          <RefreshCw />
        </Button>
      </div>
      <div
        className="catalog-scroll"
        ref={scroller}
        role="tree"
        aria-label="Database explorer"
        onScroll={(event) =>
          setArea({ y: event.currentTarget.scrollTop, height: event.currentTarget.clientHeight })
        }
      >
        {rows.length === 0 && (
          <p>{profiles.length ? "No matching objects" : "No saved connections"}</p>
        )}
        <div className="catalog-extent" style={{ height: rows.length * rowHeight }}>
          {rows.slice(first, end).map(({ node, depth }, index) => {
            const branch = node.kind !== "object";
            const opened = expanded.has(node.key) || !!needle;
            const count = (node.children ?? children[node.key])?.length;
            const error = errors[node.key];
            return (
              <div
                className="catalog-row"
                key={node.key}
                role="treeitem"
                aria-level={depth + 1}
                aria-expanded={branch ? opened : undefined}
                aria-selected={
                  node.kind === "connection" ? node.connection.id === active : undefined
                }
                data-active={node.kind === "connection" && node.connection.id === active}
                style={{
                  top: (first + index) * rowHeight,
                  height: rowHeight,
                  paddingInlineStart: 4 + depth * 11,
                }}
              >
                {branch && (
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label={`${opened ? "Collapse" : "Expand"} ${node.label}`}
                    onClick={() => toggle(node)}
                  >
                    {opened ? <ChevronDown /> : <ChevronRight />}
                  </Button>
                )}
                <Button
                  variant="ghost"
                  className="catalog-name"
                  title={error || node.object?.comment || node.label}
                  onClick={() => {
                    if (node.kind === "connection" || node.kind === "database")
                      openSql(node.connection.id!, node.database);
                    else if (node.object)
                      onObject?.({
                        connection: node.connection,
                        database: node.database,
                        object: node.object,
                      });
                    else toggle(node);
                  }}
                >
                  {node.kind === "connection" ? (
                    <DatabaseIcon kind={node.connection.kind} />
                  ) : node.kind === "database" ? (
                    <Database />
                  ) : branch ? (
                    <Folder />
                  ) : (
                    <Table2 />
                  )}
                  <span>{node.label}</span>
                  {loading.has(node.key) ? (
                    <small>Loading…</small>
                  ) : error ? (
                    <small className="catalog-error">Retry</small>
                  ) : (
                    count !== undefined && <small>{count}</small>
                  )}
                </Button>
                {error && (
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    title={error}
                    aria-label={`Retry ${node.label}`}
                    onClick={() => void load(node, true)}
                  >
                    <RefreshCw />
                  </Button>
                )}
                {node.kind === "database" && (
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label={`New SQL tab for ${node.label}`}
                    title="New SQL tab"
                    onClick={() => openSql(node.connection.id!, node.database, "")}
                  >
                    <FileCode2 />
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function nodeKey(...parts: string[]) {
  return JSON.stringify(parts);
}
