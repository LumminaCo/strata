import type { SQLNamespace } from "@codemirror/lang-sql";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { CatalogScope, CatalogSnapshot, Connection, SavedTab } from "@/ipc/bindings/protocol";
import { dispatch } from "@/ipc/client";

type Scope = (connection: Connection, database?: string) => Promise<CatalogScope>;

export function useCatalogSchema(
  connection: Connection | undefined,
  tab: SavedTab | undefined,
  revision: number,
  schema: string,
  scope: Scope,
) {
  const [cache, setCache] = useState<{
    revision: number;
    entries: Record<
      string,
      { connectionId: string; database: string; name: string; snapshot: CatalogSnapshot }
    >;
  }>({ revision, entries: {} });
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
    void latest
      .current(connection, database)
      .then((scope) => dispatch("catalog_snapshot", { scope, schema }))
      .then((snapshot) => {
        if (current) capture(id, database, schema, snapshot);
      })
      .catch(() => {
        /* The explorer can prompt for the connection password. */
      });
    return () => {
      current = false;
    };
  }, [connection, database, schema, capture]);

  const completion = useMemo<SQLNamespace>(() => {
    const namespace: Record<string, Record<string, string[]>> = Object.create(null);
    if (cache.revision === revision) {
      for (const entry of Object.values(cache.entries)) {
        if (entry.connectionId !== connection?.id || entry.database !== database) continue;
        const relations: Record<string, string[]> = Object.create(null);
        for (const object of entry.snapshot.objects) {
          const columns = entry.snapshot.columns[object.oid];
          if (columns) relations[object.name] = columns;
        }
        namespace[entry.name] = relations;
      }
    }
    return namespace;
  }, [cache, revision, connection?.id, database]);

  return { capture, completion };
}
