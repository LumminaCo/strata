import {
  ChevronDown,
  ChevronRight,
  ChevronsDown,
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
import { CatalogRowMenu, type CatalogNode } from "@/features/catalog-context-menu";
import type { Inspection } from "@/features/table-inspector";
import type {
  CatalogScope,
  CatalogSnapshot,
  Connection,
  Object as CatalogObject,
  ObjectKind,
} from "@/ipc/bindings/protocol";
import { dispatch, errorMessage } from "@/ipc/client";

export interface CatalogEntry {
  connection: Connection;
  database: string;
  object: CatalogObject;
}

export const TABLE_PAGE_SIZE = 100;
export const FILTERABLE_KINDS: ReadonlySet<ObjectKind> = new Set(["table", "procedure"]);
const FILTER_DEBOUNCE_MS = 250;

export interface TablePaginationState {
  hasMore: boolean;
  nextOffset: number;
  loading: boolean;
  error: string;
}

export interface FilteredTablesState {
  query: string;
  objects: CatalogObject[];
  hasMore: boolean;
  nextOffset: number;
  loading: boolean;
  error: string;
}

export interface ExplorerRow {
  node: CatalogNode;
  depth: number;
}

const groups: Record<ObjectKind, string> = {
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

export function nodeKey(...parts: string[]) {
  return JSON.stringify(parts);
}

export function mergeTables(
  existing: CatalogObject[],
  incoming: CatalogObject[],
  excludedNames: ReadonlySet<string> = new Set(),
): CatalogObject[] {
  const seen = new Set(existing.map((item) => `${item.oid}:${item.name}`));
  const merged = [...existing];
  for (const item of incoming) {
    if (excludedNames.has(item.name)) continue;
    const id = `${item.oid}:${item.name}`;
    if (seen.has(id)) continue;
    seen.add(id);
    merged.push(item);
  }
  return merged;
}

function makeObjectNode(
  schemaNode: CatalogNode,
  object: CatalogObject,
  columns?: string[],
): CatalogNode {
  return {
    columns,
    connection: schemaNode.connection,
    database: schemaNode.database,
    schema: schemaNode.schema ?? schemaNode.label,
    schemaKey: schemaNode.key,
    object,
    key: nodeKey(schemaNode.key, String(object.oid), object.name),
    label: object.name,
    kind: "object",
  };
}

export function buildSchemaGroups(
  schemaNode: CatalogNode,
  objects: CatalogObject[],
  columns: Record<string, string[]> = {},
): CatalogNode[] {
  const categories = new Map<ObjectKind, CatalogNode[]>();
  for (const object of objects) {
    const items = categories.get(object.kind) ?? [];
    items.push(makeObjectNode(schemaNode, object, columns[object.oid]));
    categories.set(object.kind, items);
  }
  return [...categories].map(([objectKind, items]) => {
    const label = groups[objectKind];
    return {
      connection: schemaNode.connection,
      database: schemaNode.database,
      schema: schemaNode.schema ?? schemaNode.label,
      schemaKey: schemaNode.key,
      objectKind,
      kind: "group",
      label,
      key: nodeKey(schemaNode.key, label),
      children: items,
    };
  });
}

function loadMoreNode(
  groupNode: CatalogNode,
  position: "top" | "bottom",
  state: { loading: boolean; error: string },
): CatalogNode {
  return {
    connection: groupNode.connection,
    database: groupNode.database,
    schema: groupNode.schema,
    schemaKey: groupNode.schemaKey,
    objectKind: "table",
    position,
    kind: "load_more",
    label: state.loading
      ? "Fetching more tables…"
      : state.error
        ? "Retry fetching more tables"
        : "Fetch more tables",
    loading: state.loading,
    error: state.error,
    key: nodeKey(groupNode.key, "load-more", position),
  };
}

export function buildExplorerRows(params: {
  roots: CatalogNode[];
  expanded: ReadonlySet<string>;
  children: Record<string, CatalogNode[]>;
  filter: string;
  tablePages: Record<string, TablePaginationState>;
  filteredTables: Record<string, FilteredTablesState>;
}): ExplorerRow[] {
  const { roots, expanded, children, filter, tablePages, filteredTables } = params;
  const needle = filter.trim().toLowerCase();
  const rows: ExplorerRow[] = [];

  function appendTableGroup(
    groupNode: CatalogNode,
    items: CatalogNode[],
    depth: number,
    pagination: { hasMore: boolean; loading: boolean; error: string } | undefined,
    forceExpanded: boolean,
  ) {
    const countLabel = pagination?.hasMore ? `${items.length}+` : String(items.length);
    rows.push({
      node: {
        ...groupNode,
        countLabel,
        children: items,
      },
      depth,
    });
    if (!forceExpanded && !expanded.has(groupNode.key)) return;
    if (pagination?.hasMore) {
      rows.push({
        node: loadMoreNode(groupNode, "top", pagination),
        depth: depth + 1,
      });
    }
    for (const item of items) {
      rows.push({ node: item, depth: depth + 1 });
    }
    if (pagination?.hasMore) {
      rows.push({
        node: loadMoreNode(groupNode, "bottom", pagination),
        depth: depth + 1,
      });
    }
  }

  function appendFilteredSchema(schemaNode: CatalogNode, depth: number): boolean {
    const schemaGroups = children[schemaNode.key] ?? [];
    if (schemaGroups.length === 0) return false;

    const index = rows.length;
    rows.push({ node: schemaNode, depth });
    let matched = false;

    const tablePage = tablePages[schemaNode.key];
    const existingTableGroup = schemaGroups.find((group) => group.objectKind === "table");
    const remote = filteredTables[schemaNode.key];
    const remoteReady = !!remote && remote.query === needle;
    const remoteHasObjects = remoteReady && remote.objects.length > 0;
    const remoteInitialLoading =
      !!tablePage?.hasMore && (!remoteReady || (remote.loading && !remoteHasObjects));
    const remoteInitialError = remoteReady && !remoteHasObjects ? remote.error : "";

    let tableItems: CatalogNode[];
    let tablePagination: { hasMore: boolean; loading: boolean; error: string } | undefined;
    if (
      tablePage?.hasMore &&
      remoteReady &&
      (remoteHasObjects || (!remote.loading && !remote.error))
    ) {
      tableItems = remote.objects.map((object) => makeObjectNode(schemaNode, object));
      tablePagination = {
        hasMore: remote.hasMore,
        loading: remote.loading,
        error: remote.error,
      };
    } else {
      tableItems = (existingTableGroup?.children ?? []).filter(
        (item) =>
          item.object &&
          FILTERABLE_KINDS.has(item.object.kind) &&
          item.object.kind === "table" &&
          item.label.toLowerCase().includes(needle),
      );
    }

    if (tableItems.length > 0 || remoteInitialLoading || remoteInitialError) {
      const tableGroup: CatalogNode = existingTableGroup ?? {
        connection: schemaNode.connection,
        database: schemaNode.database,
        schema: schemaNode.schema ?? schemaNode.label,
        schemaKey: schemaNode.key,
        objectKind: "table",
        kind: "group",
        label: groups.table,
        key: nodeKey(schemaNode.key, groups.table),
      };
      appendTableGroup(
        {
          ...tableGroup,
          loading: remoteInitialLoading,
          error: remoteInitialError || undefined,
        },
        tableItems,
        depth + 1,
        tablePagination,
        true,
      );
      matched = true;
    }

    const procedureGroup = schemaGroups.find((group) => group.objectKind === "procedure");
    if (procedureGroup) {
      const procItems = (procedureGroup.children ?? []).filter(
        (item) =>
          item.object &&
          FILTERABLE_KINDS.has(item.object.kind) &&
          item.object.kind === "procedure" &&
          item.label.toLowerCase().includes(needle),
      );
      if (procItems.length > 0) {
        rows.push({
          node: {
            ...procedureGroup,
            countLabel: String(procItems.length),
            children: procItems,
          },
          depth: depth + 1,
        });
        for (const item of procItems) {
          rows.push({ node: item, depth: depth + 2 });
        }
        matched = true;
      }
    }

    if (matched) return true;
    rows.splice(index);
    return false;
  }

  function append(node: CatalogNode, depth: number): boolean {
    if (needle) {
      if (node.kind === "schema") {
        return appendFilteredSchema(node, depth);
      }
      if (node.kind === "object" || node.kind === "load_more") {
        return false;
      }
      const index = rows.length;
      rows.push({ node, depth });
      let childMatches = false;
      for (const child of node.children ?? children[node.key] ?? []) {
        childMatches = append(child, depth + 1) || childMatches;
      }
      if (childMatches) return true;
      rows.splice(index);
      return false;
    }

    if (node.kind === "group" && node.objectKind === "table") {
      const items = node.children ?? [];
      const pagination = node.schemaKey ? tablePages[node.schemaKey] : undefined;
      appendTableGroup(node, items, depth, pagination, false);
      return true;
    }

    rows.push({ node, depth });
    if (expanded.has(node.key)) {
      for (const child of node.children ?? children[node.key] ?? []) {
        append(child, depth + 1);
      }
    }
    return true;
  }

  for (const node of roots) append(node, 0);
  return rows;
}

interface Props {
  profiles: Connection[];
  active?: string | null;
  revision: number;
  canPin?: boolean;
  canInsertInEditor?: boolean;
  scope: (connection: Connection, database?: string, prompt?: boolean) => Promise<CatalogScope>;
  onSnapshot: (
    connectionId: string,
    database: string,
    schema: string,
    snapshot: CatalogSnapshot,
  ) => void;
  onEntries: (entries: CatalogEntry[]) => void;
  openSql: (connectionId: string, database?: string, text?: string, schema?: string) => void;
  onRefresh: () => void;
  onObject?: (entry: Inspection) => void;
  onPinObject?: (entry: Inspection) => void;
  onInsertText?: (text: string) => void;
  onCopyText?: (text: string, label: string) => void;
  onCopyDdl?: (entry: CatalogEntry) => void;
  onEditConnection?: (connection: Connection) => void;
  onDuplicateConnection?: (connection: Connection) => void;
  onDeleteConnection?: (connection: Connection) => void;
}

export function CatalogExplorer({
  profiles,
  active,
  revision,
  canPin = false,
  canInsertInEditor = false,
  scope,
  onSnapshot,
  onEntries,
  openSql,
  onRefresh,
  onObject,
  onPinObject,
  onInsertText,
  onCopyText,
  onCopyDdl,
  onEditConnection,
  onDuplicateConnection,
  onDeleteConnection,
}: Props) {
  const [filter, setFilter] = useState("");
  const [expanded, setExpanded] = useState(new Set<string>());
  const [children, setChildren] = useState<Record<string, CatalogNode[]>>({});
  const [loading, setLoading] = useState(new Set<string>());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [tablePages, setTablePages] = useState<Record<string, TablePaginationState>>({});
  const [filteredTables, setFilteredTables] = useState<Record<string, FilteredTablesState>>({});
  const [area, setArea] = useState({ y: 0, height: 300 });
  const scroller = useRef<HTMLDivElement>(null);
  const requests = useRef(new Map<string, object>());
  const loads = useRef(new Map<string, CatalogNode>());
  const tablePagesRef = useRef(tablePages);
  tablePagesRef.current = tablePages;
  const childrenRef = useRef(children);
  childrenRef.current = children;
  const filteredTablesRef = useRef(filteredTables);
  filteredTablesRef.current = filteredTables;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const filterGeneration = useRef(0);
  const paginationGeneration = useRef(0);
  const roots = useMemo(() => {
    const nodes: CatalogNode[] = [];
    const folders = new Map<string, CatalogNode>();
    for (const connection of profiles) {
      if (!connection.id) continue;
      const node: CatalogNode = {
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
          kind: "folder",
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

  function excludedMvNames(schemaKey: string): Set<string> {
    const schemaGroups = childrenRef.current[schemaKey] ?? [];
    const mvGroup = schemaGroups.find((group) => group.objectKind === "materialized_view");
    return new Set((mvGroup?.children ?? []).map((item) => item.label));
  }

  async function load(node: CatalogNode, prompt: boolean) {
    if (
      node.kind === "folder" ||
      node.kind === "group" ||
      node.kind === "object" ||
      node.kind === "load_more"
    )
      return;
    const request = {};
    loads.current.set(node.key, node);
    requests.current.set(node.key, request);
    setLoading((current) => new Set(current).add(node.key));
    setErrors((current) => ({ ...current, [node.key]: "" }));
    try {
      const args = await scope(node.connection, node.database, prompt);
      let nodes: CatalogNode[];
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
          nodes = buildSchemaGroups(node, snapshot.objects, snapshot.columns);
          const loadedTables = snapshot.objects.filter((item) => item.kind === "table").length;
          setTablePages((current) => ({
            ...current,
            [node.key]: {
              hasMore: snapshot.hasMoreTables,
              nextOffset: snapshot.hasMoreTables ? TABLE_PAGE_SIZE : loadedTables,
              loading: false,
              error: "",
            },
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

  async function fetchMoreTables(schemaKey: string) {
    const schemaNode = loads.current.get(schemaKey);
    if (!schemaNode || schemaNode.kind !== "schema") return;
    const schema = schemaNode.schema ?? schemaNode.label;
    const trimmed = filter.trim();
    const needle = trimmed.toLowerCase();

    if (needle) {
      const current = filteredTablesRef.current[schemaKey];
      if (!current || current.query !== needle || current.loading || !current.hasMore) return;
      const gen = filterGeneration.current;
      setFilteredTables((state) => ({
        ...state,
        [schemaKey]: { ...current, loading: true, error: "" },
      }));
      try {
        const args = await scopeRef.current(schemaNode.connection, schemaNode.database, true);
        const page = await dispatch("catalog_objects", {
          scope: args,
          schema,
          kinds: ["table"],
          search: trimmed,
          offset: current.nextOffset,
          limit: TABLE_PAGE_SIZE,
        });
        if (filterGeneration.current !== gen) return;
        const excluded = excludedMvNames(schemaKey);
        setFilteredTables((state) => {
          const latest = state[schemaKey];
          if (!latest || latest.query !== needle) return state;
          return {
            ...state,
            [schemaKey]: {
              query: needle,
              objects: mergeTables(latest.objects, page.objects, excluded),
              hasMore: page.hasMore,
              nextOffset: current.nextOffset + page.objects.length,
              loading: false,
              error: "",
            },
          };
        });
      } catch (error) {
        if (filterGeneration.current !== gen) return;
        setFilteredTables((state) => {
          const latest = state[schemaKey];
          if (!latest || latest.query !== needle) return state;
          return {
            ...state,
            [schemaKey]: { ...latest, loading: false, error: errorMessage(error) },
          };
        });
      }
      return;
    }

    const current = tablePagesRef.current[schemaKey];
    if (!current || current.loading || !current.hasMore) return;
    const gen = paginationGeneration.current;
    setTablePages((state) => ({
      ...state,
      [schemaKey]: { ...current, loading: true, error: "" },
    }));
    try {
      const args = await scopeRef.current(schemaNode.connection, schemaNode.database, true);
      const page = await dispatch("catalog_objects", {
        scope: args,
        schema,
        kinds: ["table"],
        offset: current.nextOffset,
        limit: TABLE_PAGE_SIZE,
      });
      if (paginationGeneration.current !== gen) return;
      const excluded = excludedMvNames(schemaKey);
      setChildren((state) => {
        const schemaGroups = state[schemaKey];
        if (!schemaGroups) return state;
        let updated = false;
        const nextGroups = schemaGroups.map((group) => {
          if (group.objectKind !== "table") return group;
          updated = true;
          const existingObjects = (group.children ?? [])
            .map((item) => item.object)
            .filter((item): item is CatalogObject => Boolean(item));
          const merged = mergeTables(existingObjects, page.objects, excluded);
          return {
            ...group,
            children: merged.map((object) => makeObjectNode(schemaNode, object)),
          };
        });
        if (!updated && page.objects.length > 0) {
          const merged = mergeTables([], page.objects, excluded);
          if (merged.length > 0) {
            nextGroups.unshift({
              connection: schemaNode.connection,
              database: schemaNode.database,
              schema,
              schemaKey,
              objectKind: "table",
              kind: "group",
              label: groups.table,
              key: nodeKey(schemaKey, groups.table),
              children: merged.map((object) => makeObjectNode(schemaNode, object)),
            });
          }
        }
        return { ...state, [schemaKey]: nextGroups };
      });
      setTablePages((state) => ({
        ...state,
        [schemaKey]: {
          hasMore: page.hasMore,
          nextOffset: current.nextOffset + page.objects.length,
          loading: false,
          error: "",
        },
      }));
    } catch (error) {
      if (paginationGeneration.current !== gen) return;
      setTablePages((state) => ({
        ...state,
        [schemaKey]: { ...current, loading: false, error: errorMessage(error) },
      }));
    }
  }

  async function searchSchemaTables(schemaNode: CatalogNode, trimmed: string, gen: number) {
    const schema = schemaNode.schema ?? schemaNode.label;
    const needle = trimmed.toLowerCase();
    setFilteredTables((state) => ({
      ...state,
      [schemaNode.key]: {
        query: needle,
        objects: [],
        hasMore: false,
        nextOffset: 0,
        loading: true,
        error: "",
      },
    }));
    try {
      const args = await scopeRef.current(schemaNode.connection, schemaNode.database, false);
      const page = await dispatch("catalog_objects", {
        scope: args,
        schema,
        kinds: ["table"],
        search: trimmed,
        offset: 0,
        limit: TABLE_PAGE_SIZE,
      });
      if (filterGeneration.current !== gen) return;
      const excluded = excludedMvNames(schemaNode.key);
      const objects = mergeTables([], page.objects, excluded);
      setFilteredTables((state) => ({
        ...state,
        [schemaNode.key]: {
          query: needle,
          objects,
          hasMore: page.hasMore,
          nextOffset: page.objects.length,
          loading: false,
          error: "",
        },
      }));
    } catch (error) {
      if (filterGeneration.current !== gen) return;
      setFilteredTables((state) => ({
        ...state,
        [schemaNode.key]: {
          query: needle,
          objects: [],
          hasMore: false,
          nextOffset: 0,
          loading: false,
          error: errorMessage(error),
        },
      }));
    }
  }

  const latest = useRef(load);
  latest.current = load;
  useEffect(() => {
    paginationGeneration.current += 1;
    filterGeneration.current += 1;
    setFilteredTables({});
    for (const node of loads.current.values()) {
      const current = profiles.find((connection) => connection.id === node.connection.id);
      if (current) void latest.current({ ...node, connection: current }, false);
    }
  }, [revision, profiles]);

  const paginatedSchemaKeys = useMemo(
    () =>
      Object.entries(tablePages)
        .filter(([, state]) => state.hasMore)
        .map(([key]) => key)
        .sort()
        .join("\0"),
    [tablePages],
  );

  useEffect(() => {
    const trimmed = filter.trim();
    const gen = ++filterGeneration.current;
    if (!trimmed) {
      setFilteredTables({});
      return;
    }
    const targets = paginatedSchemaKeys
      ? paginatedSchemaKeys
          .split("\0")
          .map((key) => loads.current.get(key))
          .filter((node): node is CatalogNode => Boolean(node && node.kind === "schema"))
      : [];
    if (targets.length === 0) return;

    const timer = setTimeout(() => {
      for (const schemaNode of targets) {
        void searchSchemaTables(schemaNode, trimmed, gen);
      }
    }, FILTER_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [filter, paginatedSchemaKeys, revision]);

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

  function toggle(node: CatalogNode) {
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
  const rows = buildExplorerRows({
    roots,
    expanded,
    children,
    filter,
    tablePages,
    filteredTables,
  });
  const first = Math.max(0, Math.floor(area.y / rowHeight) - 5);
  const end = Math.min(rows.length, Math.ceil((area.y + area.height) / rowHeight) + 5);
  const currentProfile = profiles.find((connection) => connection.id === active);

  async function refreshConnection(connectionId: string) {
    try {
      await dispatch("refresh_metadata", { connectionId });
      onRefresh();
    } catch (error) {
      const root = nodeKey(connectionId);
      setErrors((current) => ({ ...current, [root]: errorMessage(error) }));
    }
  }

  async function refresh() {
    if (!currentProfile?.id) return;
    await refreshConnection(currentProfile.id);
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
          aria-label="Filter tables and procedures"
          placeholder="Filter tables & procedures"
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
          <p>
            {profiles.length
              ? needle
                ? "No matching tables or procedures"
                : "No matching objects"
              : "No saved connections"}
          </p>
        )}
        <div className="catalog-extent" style={{ height: rows.length * rowHeight }}>
          {rows.slice(first, end).map(({ node, depth }, index) => {
            if (node.kind === "load_more") {
              return (
                <div
                  className="catalog-row"
                  key={node.key}
                  role="treeitem"
                  aria-level={depth + 1}
                  data-load-more-position={node.position}
                  style={{
                    top: (first + index) * rowHeight,
                    height: rowHeight,
                    paddingInlineStart: 4 + depth * 11,
                  }}
                >
                  <Button
                    variant="ghost"
                    className="catalog-load-more"
                    data-error={Boolean(node.error) || undefined}
                    disabled={node.loading}
                    title={node.error || "Fetch next 100 tables"}
                    onClick={() => {
                      if (node.schemaKey) void fetchMoreTables(node.schemaKey);
                    }}
                  >
                    {node.loading ? <RefreshCw className="update-check-spin" /> : <ChevronsDown />}
                    <span>{node.label}</span>
                  </Button>
                </div>
              );
            }
            const branch = node.kind !== "object";
            const opened = expanded.has(node.key) || !!needle;
            const count = node.countLabel ?? (node.children ?? children[node.key])?.length;
            const nodeLoading = loading.has(node.key) || Boolean(node.loading);
            const error = node.error || errors[node.key];
            const isActive = node.kind === "connection" && node.connection.id === active;
            const tabSchema =
              node.connection.kind === "sqlserver"
                ? undefined
                : node.kind === "schema" || node.kind === "group"
                  ? node.schema
                  : undefined;
            return (
              <CatalogRowMenu
                key={node.key}
                node={node}
                depth={depth}
                branch={branch}
                opened={opened}
                filtered={!!needle}
                active={isActive}
                canPin={canPin}
                canInsertInEditor={canInsertInEditor}
                style={{
                  top: (first + index) * rowHeight,
                  height: rowHeight,
                  paddingInlineStart: 4 + depth * 11,
                }}
                onToggle={() => toggle(node)}
                onRefresh={() => {
                  if (node.connection.id) void refreshConnection(node.connection.id);
                }}
                onNewSqlTab={() => {
                  if (node.connection.id) openSql(node.connection.id, node.database, "", tabSchema);
                }}
                onInspectObject={onObject}
                onPinObject={onPinObject}
                onGenerateSelect={(entry, sql) => {
                  if (entry.connection.id) {
                    openSql(
                      entry.connection.id,
                      entry.database,
                      sql,
                      entry.connection.kind === "sqlserver" ? undefined : entry.object.schema,
                    );
                  }
                }}
                onInsertText={onInsertText}
                onCopyText={onCopyText}
                onCopyDdl={onCopyDdl}
                onEditConnection={onEditConnection}
                onDuplicateConnection={onDuplicateConnection}
                onDeleteConnection={onDeleteConnection}
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
                  {nodeLoading ? (
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
                    onClick={() => {
                      if (node.kind === "group" && node.schemaKey && needle) {
                        const schemaNode = loads.current.get(node.schemaKey);
                        if (schemaNode) {
                          void searchSchemaTables(
                            schemaNode,
                            filter.trim(),
                            filterGeneration.current,
                          );
                        }
                      } else {
                        void load(node, true);
                      }
                    }}
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
              </CatalogRowMenu>
            );
          })}
        </div>
      </div>
    </div>
  );
}
