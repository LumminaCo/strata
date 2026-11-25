import type { SQLNamespace } from "@codemirror/lang-sql";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  CatalogScope,
  CatalogSnapshot,
  Connection,
  ObjectKind,
  SavedTab,
} from "@/ipc/bindings/protocol";
import { dispatch } from "@/ipc/client";

type Scope = (connection: Connection, database?: string) => Promise<CatalogScope>;

export interface CachedSchemaEntry {
  connectionId: string;
  database: string;
  name: string;
  snapshot: CatalogSnapshot;
}

const RELATION_KINDS = new Set<ObjectKind>([
  "table",
  "view",
  "materialized_view",
  "foreign_table",
  "synonym",
]);

const SYSTEM_SCHEMAS = new Set([
  "pg_catalog",
  "information_schema",
  "sys",
  "guest",
  "SYS",
  "SYSTEM",
  "XDB",
  "MDSYS",
  "CTXSYS",
  "ORDSYS",
  "OUTLN",
  "DBSNMP",
  "WMSYS",
  "ORDDATA",
]);

const PRELOAD_SCHEMA_LIMIT = 25;
const PRELOAD_CONCURRENCY = 4;

function escapeNamespaceKey(name: string) {
  return name.replaceAll(".", "\\.");
}

export function buildCompletionNamespace(
  entries: Iterable<CachedSchemaEntry>,
  connectionId: string | null | undefined,
  database: string | undefined,
): SQLNamespace {
  const namespace: Record<string, Record<string, string[]>> = Object.create(null);
  if (!connectionId || !database) return namespace;
  for (const entry of entries) {
    if (entry.connectionId !== connectionId || entry.database !== database) continue;
    const relations: Record<string, string[]> = Object.create(null);
    for (const object of entry.snapshot.objects) {
      const columns = entry.snapshot.columns[object.oid];
      if (columns || RELATION_KINDS.has(object.kind)) {
        relations[escapeNamespaceKey(object.name)] = columns ?? [];
      }
    }
    namespace[escapeNamespaceKey(entry.name)] = relations;
  }
  return namespace;
}

export function useCatalogSchema(
  connection: Connection | undefined,
  tab: SavedTab | undefined,
  revision: number,
  schema: string,
  scope: Scope,
  sessionId?: string,
) {
  const [cache, setCache] = useState<{
    revision: number;
    entries: Record<string, CachedSchemaEntry>;
  }>({ revision, entries: {} });
  const cacheRef = useRef(cache);
  cacheRef.current = cache;

  const capture = useCallback(
    (connectionId: string, database: string, name: string, snapshot: CatalogSnapshot) => {
      const key = JSON.stringify([connectionId, database, name]);
      setCache((current) => ({
        revision,
        entries: {
          ...(current.revision === revision ? current.entries : {}),
          [key]: { connectionId, database, name, snapshot },
        },
      }));
    },
    [revision],
  );
  const latest = useRef(scope);
  latest.current = scope;
  const database = tab?.database ?? connection?.database;

  useEffect(() => {
    if (!connection?.id || !database) return;
    const id = connection.id;
    let current = true;
    const hasCached = (name: string) => {
      const key = JSON.stringify([id, database, name]);
      return cacheRef.current.revision === revision && key in cacheRef.current.entries;
    };

    void latest
      .current(connection, database)
      .then(async (catalogScope) => {
        if (!current) return;
        const loadSchema = async (name: string) => {
          if (!name || hasCached(name)) return;
          const snapshot = await dispatch("catalog_snapshot", {
            scope: catalogScope,
            schema: name,
          });
          if (current) capture(id, database, name, snapshot);
        };

        await loadSchema(schema).catch(() => {});
        if (!current) return;

        const schemas = await dispatch("list_schemas", { scope: catalogScope }).catch(() => []);
        if (!current) return;

        const queue = schemas
          .filter((name) => name !== schema && !SYSTEM_SCHEMAS.has(name) && !hasCached(name))
          .slice(0, PRELOAD_SCHEMA_LIMIT);
        let cursor = 0;
        const worker = async () => {
          while (current && cursor < queue.length) {
            const next = queue[cursor++];
            if (!next) continue;
            await loadSchema(next).catch(() => {});
          }
        };
        await Promise.all(
          Array.from({ length: Math.min(PRELOAD_CONCURRENCY, queue.length) }, () => worker()),
        );
      })
      .catch(() => {
        /* The explorer can prompt for the connection password. */
      });
    return () => {
      current = false;
    };
  }, [connection, database, schema, revision, sessionId, capture]);

  const completion = useMemo<SQLNamespace>(() => {
    if (cache.revision !== revision) return Object.create(null);
    return buildCompletionNamespace(Object.values(cache.entries), connection?.id, database);
  }, [cache, revision, connection?.id, database]);

  return { capture, completion };
}
