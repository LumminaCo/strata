import { CompletionContext, type CompletionSource } from "@codemirror/autocomplete";
import { PostgreSQL, sql } from "@codemirror/lang-sql";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vite-plus/test";

import type { Object as CatalogObject, ObjectKind } from "@/ipc/bindings/protocol";

import { buildCompletionNamespace, type CachedSchemaEntry } from "./use-catalog-schema";

function object(
  oid: number,
  schema: string,
  name: string,
  kind: ObjectKind = "table",
): CatalogObject {
  return { oid, schema, name, kind, rows: null, comment: null };
}

function schemaOptions(
  doc: string,
  schema: ReturnType<typeof buildCompletionNamespace>,
  defaultSchema: string,
) {
  const state = EditorState.create({
    doc,
    extensions: [sql({ dialect: PostgreSQL, schema, defaultSchema })],
  });
  const [schemaSource] = state.languageDataAt<CompletionSource>("autocomplete", doc.length);
  const result = schemaSource?.(new CompletionContext(state, doc.length, true));
  if (!result || "then" in result) return [];
  return result.options.map((option) => option.label);
}

describe("buildCompletionNamespace", () => {
  it("includes all relation objects across schemas, including columnless tables and synonyms", () => {
    const entries: CachedSchemaEntry[] = [
      {
        connectionId: "conn-1",
        database: "app",
        name: "public",
        snapshot: {
          objects: [
            object(1, "public", "accounts", "table"),
            object(2, "public", "orders", "table"),
            object(3, "public", "empty_table", "table"),
            object(4, "public", "active_users", "view"),
            object(5, "public", "user_alias", "synonym"),
            object(6, "public", "order_id_seq", "sequence"),
            object(7, "public", "calc_total", "function"),
          ],
          hasMoreTables: false,
          columns: {
            "1": ["id", "name"],
            "2": ["id", "account_id"],
            "4": ["id", "email"],
          },
        },
      },
      {
        connectionId: "conn-1",
        database: "app",
        name: "sales",
        snapshot: {
          objects: [
            object(10, "sales", "invoices", "table"),
            object(11, "sales", "line_items", "table"),
          ],
          hasMoreTables: false,
          columns: {
            "10": ["id", "total"],
            "11": ["id", "invoice_id"],
          },
        },
      },
      {
        connectionId: "conn-2",
        database: "app",
        name: "public",
        snapshot: {
          objects: [object(99, "public", "other_connection_table", "table")],
          hasMoreTables: false,
          columns: { "99": ["id"] },
        },
      },
    ];

    const namespace = buildCompletionNamespace(entries, "conn-1", "app");

    const topLevel = schemaOptions("SELECT * FROM ", namespace, "public");
    expect(topLevel).toEqual(
      expect.arrayContaining([
        "public",
        "sales",
        "accounts",
        "orders",
        "empty_table",
        "active_users",
        "user_alias",
      ]),
    );
    expect(topLevel).not.toContain("order_id_seq");
    expect(topLevel).not.toContain("calc_total");
    expect(topLevel).not.toContain("other_connection_table");

    const salesTables = schemaOptions("SELECT * FROM sales.", namespace, "public");
    expect(salesTables).toEqual(["invoices", "line_items"]);

    const aliasColumns = schemaOptions(
      "SELECT * FROM sales.invoices inv WHERE inv.",
      namespace,
      "public",
    );
    expect(aliasColumns).toEqual(["id", "total"]);
  });

  it("escapes dotted object names so CodeMirror keeps them as a single table", () => {
    const entries: CachedSchemaEntry[] = [
      {
        connectionId: "conn-1",
        database: "app",
        name: "public",
        snapshot: {
          objects: [object(1, "public", "archive.events", "table")],
          hasMoreTables: false,
          columns: { "1": ["id", "payload"] },
        },
      },
    ];

    const namespace = buildCompletionNamespace(entries, "conn-1", "app");
    const tables = schemaOptions("SELECT * FROM public.", namespace, "public");
    expect(tables).toEqual(["archive.events"]);
  });
});
