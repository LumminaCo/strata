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
  Connection,
  Object as CatalogObject,
  ObjectKind,
  ObjectKindCount,
} from "@/ipc/bindings/protocol";
import { dispatch, errorMessage } from "@/ipc/client";

export interface CatalogEntry {
  connection: Connection;
  database: string;
  object: CatalogObject;
}

export const OBJECT_PAGE_SIZE = 100;
export const TABLE_PAGE_SIZE = OBJECT_PAGE_SIZE;
export const FILTERABLE_KINDS: ReadonlySet<ObjectKind> = new Set(["table", "procedure"]);
const FILTER_DEBOUNCE_MS = 250;

export interface GroupPaginationState {
  hasMore: boolean;
  nextOffset: number;
  loading: boolean;
  error: string;
}

export type TablePaginationState = GroupPaginationState;

export interface FilteredGroupState {
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

export function mergeObjects(
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

export const mergeTables = mergeObjects;

export function makeObjectNode(
  parentNode: CatalogNode,
  object: CatalogObject,
  columns?: string[],
): CatalogNode {
  const schema = parentNode.schema ?? parentNode.label;
  const schemaKey = parentNode.schemaKey ?? parentNode.key;
  return {
    columns,
    connection: parentNode.connection,
    database: parentNode.database,
    schema,
    schemaKey,
    object,
    key: nodeKey(schemaKey, String(object.oid), object.name),
    label: object.name,
    kind: "object",
  };
}

export function buildSchemaGroupsFromCounts(
  schemaNode: CatalogNode,
  counts: ObjectKindCount[],
): CatalogNode[] {
  const schema = schemaNode.schema ?? schemaNode.label;
  return counts
    .filter((entry) => entry.count > 0)
    .map((entry) => {
      const label = groups[entry.kind];
      return {
        connection: schemaNode.connection,
        database: schemaNode.database,
        schema,
        schemaKey: schemaNode.key,
        objectKind: entry.kind,
        totalCount: entry.count,
        countLabel: String(entry.count),
        kind: "group",
        label,
        key: nodeKey(schemaNode.key, label),
      };
    });
}

function loadMoreNode(
  groupNode: CatalogNode,
  position: "top" | "bottom",
  state: { loading: boolean; error: string },
): CatalogNode {
  const groupLabel = groupNode.label.toLowerCase();
  return {
    connection: groupNode.connection,
    database: groupNode.database,
    schema: groupNode.schema,
    schemaKey: groupNode.schemaKey,
    groupKey: groupNode.key,
    objectKind: groupNode.objectKind,
    position,
    kind: "load_more",
    label: state.loading
      ? `Fetching more ${groupLabel}…`
      : state.error
        ? `Retry fetching more ${groupLabel}`
        : `Fetch more ${groupLabel}`,
    loading: state.loading,
    error: state.error,
    key: nodeKey(groupNode.key, "load-more", position),
  };
}

function formatGroupCount(
  groupNode: CatalogNode,
  loadedItems: CatalogNode[] | undefined,
  pagination: { hasMore: boolean } | undefined,
): string | undefined {
  if (loadedItems === undefined) {
    return groupNode.totalCount !== undefined ? String(groupNode.totalCount) : groupNode.countLabel;
  }
  if (!pagination?.hasMore) {
    return String(loadedItems.length);
  }
  if (groupNode.totalCount !== undefined && groupNode.totalCount > loadedItems.length) {
    return String(groupNode.totalCount);
  }
  return `${loadedItems.length}+`;
}

export function isNodeVisibleAndExpanded(
  node: CatalogNode,
  expanded: ReadonlySet<string>,
): boolean {
  if (!expanded.has(node.key)) return false;
  const connectionId = node.connection.id;
  if (!connectionId) return false;
  if (node.connection.folder && !expanded.has(nodeKey("folder", node.connection.folder))) {
    return false;
  }
  const connectionKey = nodeKey(connectionId);
  if (node.kind === "connection") return true;
  if (!expanded.has(connectionKey)) return false;
  const databaseKey = nodeKey(connectionKey, node.database);
  if (node.kind === "database") return true;
  if (!expanded.has(databaseKey)) return false;
  if (node.kind === "schema") return true;
  const schemaKey = node.schemaKey ?? nodeKey(databaseKey, node.schema ?? "");
  return expanded.has(schemaKey);
}

export function buildExplorerRows(params: {
  roots: CatalogNode[];
  expanded: ReadonlySet<string>;
  children: Record<string, CatalogNode[]>;
  filter: string;
  groupPages: Record<string, GroupPaginationState>;
  filteredGroups: Record<string, FilteredGroupState>;
}): ExplorerRow[] {
  const { roots, expanded, children, filter, groupPages, filteredGroups } = params;
  const needle = filter.trim().toLowerCase();
  const rows: ExplorerRow[] = [];

  function appendGroupRows(
    groupNode: CatalogNode,
    items: CatalogNode[] | undefined,
    depth: number,
    pagination: { hasMore: boolean; loading: boolean; error: string } | undefined,
    forceExpanded: boolean,
  ) {
    const countLabel = formatGroupCount(groupNode, items, pagination);
    rows.push({
      node: {
        ...groupNode,
        countLabel,
      },
      depth,
    });
    if (!forceExpanded && !expanded.has(groupNode.key)) return;
    if (items === undefined) return;
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

    for (const group of schemaGroups) {
      if (!group.objectKind || !FILTERABLE_KINDS.has(group.objectKind)) continue;
      const loadedItems = children[group.key] ?? group.children;
      const pageState = groupPages[group.key];
      const isCompleteLocally = loadedItems !== undefined && !pageState?.hasMore;
      const needsRemote = !isCompleteLocally;
      const remote = filteredGroups[group.key];
      const remoteReady = !!remote && remote.query === needle;
      const remoteHasObjects = remoteReady && remote.objects.length > 0;
      const remoteInitialLoading =
        needsRemote && (!remoteReady || (remote.loading && !remoteHasObjects));
      const remoteInitialError =
        needsRemote && remoteReady && !remoteHasObjects ? remote.error : "";

      let items: CatalogNode[];
      let pagination: { hasMore: boolean; loading: boolean; error: string } | undefined;
      if (needsRemote && remoteReady && (remoteHasObjects || (!remote.loading && !remote.error))) {
        items = remote.objects.map((object) => makeObjectNode(group, object));
        pagination = {
          hasMore: remote.hasMore,
          loading: remote.loading,
          error: remote.error,
        };
      } else {
        items = (loadedItems ?? []).filter(
          (item) =>
            item.object &&
            item.object.kind === group.objectKind &&
            item.label.toLowerCase().includes(needle),
        );
      }

      if (items.length > 0 || remoteInitialLoading || remoteInitialError) {
        appendGroupRows(
          {
            ...group,
            totalCount: undefined,
            countLabel: undefined,
            loading: remoteInitialLoading,
            error: remoteInitialError || undefined,
          },
          items,
          depth + 1,
          pagination,
          true,
        );
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

    if (node.kind === "group") {
      const items = children[node.key] ?? node.children;
      const pagination = groupPages[node.key];
      appendGroupRows(node, items, depth, pagination, false);
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
  onObjects?: (
    connectionId: string,
    database: string,
    schema: string,
    objects: CatalogObject[],
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
  onObjects,
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
  const [groupPages, setGroupPages] = useState<Record<string, GroupPaginationState>>({});
  const [filteredGroups, setFilteredGroups] = useState<Record<string, FilteredGroupState>>({});
  const [area, setArea] = useState({ y: 0, height: 300 });
  const scroller = useRef<HTMLDivElement>(null);
  const requests = useRef(new Map<string, object>());
  const loads = useRef(new Map<string, CatalogNode>());
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const groupPagesRef = useRef(groupPages);
  groupPagesRef.current = groupPages;
  const childrenRef = useRef(children);
  childrenRef.current = children;
  const filteredGroupsRef = useRef(filteredGroups);
  filteredGroupsRef.current = filteredGroups;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const onObjectsRef = useRef(onObjects);
  onObjectsRef.current = onObjects;
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

  function findGroupNode(groupKey: string): CatalogNode | undefined {
    const loaded = loads.current.get(groupKey);
    if (loaded && loaded.kind === "group") return loaded;
    for (const list of Object.values(childrenRef.current)) {
      for (const node of list) {
        if (node.kind === "group" && node.key === groupKey) return node;
      }
    }
    return undefined;
  }

  function excludedMvNames(schemaKey: string | undefined, objectKind: ObjectKind): Set<string> {
    if (!schemaKey || objectKind !== "table") return new Set();
    const mvGroupKey = nodeKey(schemaKey, groups.materialized_view);
    const mvItems = childrenRef.current[mvGroupKey] ?? [];
    return new Set(mvItems.map((item) => item.label));
  }

  async function load(node: CatalogNode, prompt: boolean) {
    if (node.kind === "folder" || node.kind === "object" || node.kind === "load_more") return;
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
          const counts = await dispatch("catalog_counts", { scope: args, schema });
          if (requests.current.get(node.key) !== request) return;
          nodes = buildSchemaGroupsFromCounts(node, counts);
          break;
        }
        case "group": {
          const schema = node.schema ?? "";
          const objectKind = node.objectKind;
          if (!schema || !objectKind) return;
          const page = await dispatch("catalog_objects", {
            scope: args,
            schema,
            kinds: [objectKind],
            offset: 0,
            limit: OBJECT_PAGE_SIZE,
          });
          if (requests.current.get(node.key) !== request) return;
          const excluded = excludedMvNames(node.schemaKey, objectKind);
          const objects = mergeObjects([], page.objects, excluded);
          if (node.connection.id) {
            onObjectsRef.current?.(node.connection.id, node.database, schema, objects);
          }
          nodes = objects.map((object) => makeObjectNode(node, object));
          setGroupPages((current) => ({
            ...current,
            [node.key]: {
              hasMore: page.hasMore,
              nextOffset: page.objects.length,
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

  async function fetchMoreObjects(groupKey: string) {
    const groupNode = findGroupNode(groupKey);
    if (!groupNode || groupNode.kind !== "group" || !groupNode.objectKind || !groupNode.schema) {
      return;
    }
    const schema = groupNode.schema;
    const objectKind = groupNode.objectKind;
    const trimmed = filter.trim();
    const needle = trimmed.toLowerCase();

    if (needle) {
      const current = filteredGroupsRef.current[groupKey];
      if (!current || current.query !== needle || current.loading || !current.hasMore) return;
      const gen = filterGeneration.current;
      setFilteredGroups((state) => ({
        ...state,
        [groupKey]: { ...current, loading: true, error: "" },
      }));
      try {
        const args = await scopeRef.current(groupNode.connection, groupNode.database, true);
        const page = await dispatch("catalog_objects", {
          scope: args,
          schema,
          kinds: [objectKind],
          search: trimmed,
          offset: current.nextOffset,
          limit: OBJECT_PAGE_SIZE,
        });
        if (filterGeneration.current !== gen) return;
        const excluded = excludedMvNames(groupNode.schemaKey, objectKind);
        setFilteredGroups((state) => {
          const latest = state[groupKey];
          if (!latest || latest.query !== needle) return state;
          return {
            ...state,
            [groupKey]: {
              query: needle,
              objects: mergeObjects(latest.objects, page.objects, excluded),
              hasMore: page.hasMore,
              nextOffset: current.nextOffset + page.objects.length,
              loading: false,
              error: "",
            },
          };
        });
      } catch (error) {
        if (filterGeneration.current !== gen) return;
        setFilteredGroups((state) => {
          const latest = state[groupKey];
          if (!latest || latest.query !== needle) return state;
          return {
            ...state,
            [groupKey]: { ...latest, loading: false, error: errorMessage(error) },
          };
        });
      }
      return;
    }

    const current = groupPagesRef.current[groupKey];
    if (!current || current.loading || !current.hasMore) return;
    const gen = paginationGeneration.current;
    setGroupPages((state) => ({
      ...state,
      [groupKey]: { ...current, loading: true, error: "" },
    }));
    try {
      const args = await scopeRef.current(groupNode.connection, groupNode.database, true);
      const page = await dispatch("catalog_objects", {
        scope: args,
        schema,
        kinds: [objectKind],
        offset: current.nextOffset,
        limit: OBJECT_PAGE_SIZE,
      });
      if (paginationGeneration.current !== gen) return;
      const excluded = excludedMvNames(groupNode.schemaKey, objectKind);
      const incoming = mergeObjects([], page.objects, excluded);
      if (groupNode.connection.id && incoming.length > 0) {
        onObjectsRef.current?.(groupNode.connection.id, groupNode.database, schema, incoming);
      }
      setChildren((state) => {
        const existingNodes = state[groupKey] ?? [];
        const existingObjects = existingNodes
          .map((item) => item.object)
          .filter((item): item is CatalogObject => Boolean(item));
        const merged = mergeObjects(existingObjects, incoming);
        return {
          ...state,
          [groupKey]: merged.map((object) => makeObjectNode(groupNode, object)),
        };
      });
      setGroupPages((state) => ({
        ...state,
        [groupKey]: {
          hasMore: page.hasMore,
          nextOffset: current.nextOffset + page.objects.length,
          loading: false,
          error: "",
        },
      }));
    } catch (error) {
      if (paginationGeneration.current !== gen) return;
      setGroupPages((state) => ({
        ...state,
        [groupKey]: { ...current, loading: false, error: errorMessage(error) },
      }));
    }
  }

  async function searchGroupObjects(groupNode: CatalogNode, trimmed: string, gen: number) {
    if (!groupNode.schema || !groupNode.objectKind) return;
    const schema = groupNode.schema;
    const objectKind = groupNode.objectKind;
    const needle = trimmed.toLowerCase();
    setFilteredGroups((state) => ({
      ...state,
      [groupNode.key]: {
        query: needle,
        objects: [],
        hasMore: false,
        nextOffset: 0,
        loading: true,
        error: "",
      },
    }));
    try {
      const args = await scopeRef.current(groupNode.connection, groupNode.database, false);
      const page = await dispatch("catalog_objects", {
        scope: args,
        schema,
        kinds: [objectKind],
        search: trimmed,
        offset: 0,
        limit: OBJECT_PAGE_SIZE,
      });
      if (filterGeneration.current !== gen) return;
      const excluded = excludedMvNames(groupNode.schemaKey, objectKind);
      const objects = mergeObjects([], page.objects, excluded);
      setFilteredGroups((state) => ({
        ...state,
        [groupNode.key]: {
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
      setFilteredGroups((state) => ({
        ...state,
        [groupNode.key]: {
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
    setFilteredGroups({});

    const currentExpanded = expandedRef.current;
    const keysToEvict = new Set<string>();
    const nodesToReload: CatalogNode[] = [];

    for (const [key, node] of loads.current.entries()) {
      const current = profiles.find((connection) => connection.id === node.connection.id);
      if (!current || !isNodeVisibleAndExpanded(node, currentExpanded)) {
        keysToEvict.add(key);
      } else {
        nodesToReload.push({ ...node, connection: current });
      }
    }

    if (keysToEvict.size > 0) {
      for (const key of keysToEvict) {
        loads.current.delete(key);
        requests.current.delete(key);
      }
      setChildren((state) => {
        const next = { ...state };
        for (const key of keysToEvict) delete next[key];
        return next;
      });
      setGroupPages((state) => {
        const next = { ...state };
        for (const key of keysToEvict) delete next[key];
        return next;
      });
      setErrors((state) => {
        const next = { ...state };
        for (const key of keysToEvict) delete next[key];
        return next;
      });
      setLoading((state) => {
        const next = new Set(state);
        for (const key of keysToEvict) next.delete(key);
        return next;
      });
    }

    for (const node of nodesToReload) {
      void latest.current(node, false);
    }
  }, [revision, profiles]);

  const remoteFilterGroupKeys = useMemo(() => {
    const keys: string[] = [];
    for (const list of Object.values(children)) {
      for (const node of list) {
        if (node.kind !== "group" || !node.objectKind || !FILTERABLE_KINDS.has(node.objectKind)) {
          continue;
        }
        const loadedItems = children[node.key] ?? node.children;
        const isCompleteLocally = loadedItems !== undefined && !groupPages[node.key]?.hasMore;
        if (!isCompleteLocally) {
          keys.push(node.key);
        }
      }
    }
    return keys.sort().join("\0");
  }, [children, groupPages]);

  useEffect(() => {
    const trimmed = filter.trim();
    const gen = ++filterGeneration.current;
    if (!trimmed) {
      setFilteredGroups({});
      return;
    }
    const targets = remoteFilterGroupKeys
      ? remoteFilterGroupKeys
          .split("\0")
          .map((key) => findGroupNode(key))
          .filter((node): node is CatalogNode => Boolean(node && node.kind === "group"))
      : [];
    if (targets.length === 0) return;

    const timer = setTimeout(() => {
      for (const groupNode of targets) {
        void searchGroupObjects(groupNode, trimmed, gen);
      }
    }, FILTER_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [filter, remoteFilterGroupKeys, revision]);

  useEffect(() => {
    const entries: CatalogEntry[] = [];
    for (const loaded of Object.values(children)) {
      for (const item of loaded) {
        if (item.kind !== "object" || !item.object) continue;
        if (!profiles.some((connection) => connection.id === item.connection.id)) continue;
        entries.push({
          connection: item.connection,
          database: item.database,
          object: item.object,
        });
      }
    }
    onEntries(entries);
  }, [children, profiles, onEntries]);

  function toggle(node: CatalogNode) {
    if (filter.trim()) return;
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
    groupPages,
    filteredGroups,
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
              const groupLabel = node.objectKind
                ? groups[node.objectKind].toLowerCase()
                : "objects";
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
                    title={node.error || `Fetch next ${OBJECT_PAGE_SIZE} ${groupLabel}`}
                    onClick={() => {
                      if (node.groupKey) void fetchMoreObjects(node.groupKey);
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
                      if (node.kind === "group" && needle) {
                        void searchGroupObjects(node, filter.trim(), filterGeneration.current);
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
