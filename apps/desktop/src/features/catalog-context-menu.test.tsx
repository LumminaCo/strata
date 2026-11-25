import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  CatalogRowMenu,
  buildSelectQuery,
  formatQualifiedObjectName,
  isRelationObject,
  type CatalogNode,
} from "@/features/catalog-context-menu";
import { CatalogExplorer, type CatalogEntry } from "@/features/catalog-explorer";
import { resolveInspectionSection } from "@/features/table-inspector";
import type { Connection, Object as CatalogObject, ObjectKind } from "@/ipc/bindings/protocol";

function sampleConnection(overrides: Partial<Connection> = {}): Connection {
  return {
    id: "conn-1",
    name: "Analytics",
    kind: "postgres",
    env: "dev",
    color: null,
    folder: null,
    host: "localhost",
    port: 5432,
    database: "pagila",
    user: "strata",
    secret: "prompt",
    readOnly: false,
    agentAccess: "none",
    allowAgentDdl: false,
    options: null,
    tls: "prefer",
    ...overrides,
  };
}

function sampleObject(overrides: Partial<CatalogObject> = {}): CatalogObject {
  return {
    oid: 42,
    schema: "public",
    name: "actor",
    kind: "table",
    rows: 200,
    comment: null,
    ...overrides,
  };
}

describe("catalog object classification and SQL helpers", () => {
  it("classifies tabular relation kinds vs non-relation object kinds", () => {
    const relations: ObjectKind[] = ["table", "view", "materialized_view", "foreign_table"];
    const nonRelations: ObjectKind[] = ["function", "procedure", "sequence", "synonym"];

    for (const kind of relations) {
      expect(isRelationObject(kind)).toBe(true);
    }
    for (const kind of nonRelations) {
      expect(isRelationObject(kind)).toBe(false);
    }
  });

  it("formats qualified object names with dialect-specific quoting and escaping", () => {
    expect(formatQualifiedObjectName("public", "actor", "postgres")).toBe('"public"."actor"');
    expect(formatQualifiedObjectName('my"schema', 'user"events', "postgres")).toBe(
      '"my""schema"."user""events"',
    );
    expect(formatQualifiedObjectName("dbo", "Order]Items", "sqlserver")).toBe(
      "[dbo].[Order]]Items]",
    );
    expect(formatQualifiedObjectName("HR", "EMPLOYEES", "oracle")).toBe('"HR"."EMPLOYEES"');
  });

  it("builds dialect-aware SELECT statements with loaded columns or wildcard fallback", () => {
    const pgEntry: CatalogEntry = {
      connection: sampleConnection({ kind: "postgres" }),
      database: "pagila",
      object: sampleObject({ schema: "public", name: "actor" }),
    };
    expect(buildSelectQuery(pgEntry, ["actor_id", "first_name"])).toBe(
      'SELECT\n  "actor_id",\n  "first_name"\nFROM "public"."actor"\nLIMIT 100;',
    );
    expect(buildSelectQuery(pgEntry)).toBe('SELECT *\nFROM "public"."actor"\nLIMIT 100;');

    const mssqlEntry: CatalogEntry = {
      connection: sampleConnection({ kind: "sqlserver" }),
      database: "strata",
      object: sampleObject({ schema: "dbo", name: "orders" }),
    };
    expect(buildSelectQuery(mssqlEntry, ["id", "total"])).toBe(
      "SELECT TOP (100)\n  [id],\n  [total]\nFROM [dbo].[orders];",
    );
    expect(buildSelectQuery(mssqlEntry, [])).toBe("SELECT TOP (100) *\nFROM [dbo].[orders];");

    const oracleEntry: CatalogEntry = {
      connection: sampleConnection({ kind: "oracle" }),
      database: "FREEPDB1",
      object: sampleObject({ schema: "HR", name: "EMPLOYEES" }),
    };
    expect(buildSelectQuery(oracleEntry, ["EMPLOYEE_ID", "EMAIL"])).toBe(
      'SELECT\n  "EMPLOYEE_ID",\n  "EMAIL"\nFROM "HR"."EMPLOYEES"\nWHERE ROWNUM <= 100;',
    );
    expect(buildSelectQuery(oracleEntry)).toBe(
      'SELECT *\nFROM "HR"."EMPLOYEES"\nWHERE ROWNUM <= 100;',
    );
  });

  it("resolves initial TableInspector section for explicit targets, columns, and object kinds", () => {
    const connection = sampleConnection();
    const table = sampleObject({ kind: "table" });
    const fn = sampleObject({ kind: "function", name: "compute_tax" });

    expect(resolveInspectionSection({ connection, database: "pagila", object: table })).toBe(
      "Data",
    );
    expect(
      resolveInspectionSection({
        connection,
        database: "pagila",
        object: table,
        column: "first_name",
      }),
    ).toBe("Columns");
    expect(
      resolveInspectionSection({
        connection,
        database: "pagila",
        object: table,
        section: "Keys & Indexes",
      }),
    ).toBe("Keys & Indexes");
    expect(
      resolveInspectionSection({
        connection,
        database: "pagila",
        object: table,
        section: "DDL",
      }),
    ).toBe("DDL");

    expect(resolveInspectionSection({ connection, database: "pagila", object: fn })).toBe("DDL");
    expect(
      resolveInspectionSection({ connection, database: "pagila", object: fn, section: "Info" }),
    ).toBe("Info");
    expect(
      resolveInspectionSection({ connection, database: "pagila", object: fn, section: "Data" }),
    ).toBe("DDL");
  });
});

describe("sidebar context menu rendering", () => {
  it("renders treeitem rows wrapped in a context menu trigger for object and branch nodes", () => {
    const connection = sampleConnection();
    const objectNode: CatalogNode = {
      key: '["conn-1","pagila","public","42","actor"]',
      kind: "object",
      label: "actor",
      connection,
      database: "pagila",
      schema: "public",
      object: sampleObject(),
      columns: ["actor_id", "first_name"],
    };

    const markup = renderToStaticMarkup(
      <CatalogRowMenu
        node={objectNode}
        depth={4}
        branch={false}
        opened={false}
        filtered={false}
        active={false}
        canPin
        canInsertInEditor
        style={{ top: 0, height: 29, paddingInlineStart: 48 }}
        onToggle={() => {}}
        onRefresh={() => {}}
        onNewSqlTab={() => {}}
        onInspectObject={() => {}}
        onPinObject={() => {}}
        onGenerateSelect={() => {}}
        onInsertText={() => {}}
        onCopyText={() => {}}
        onCopyDdl={() => {}}
      >
        <span>actor</span>
      </CatalogRowMenu>,
    );

    expect(markup).toContain('data-slot="context-menu-trigger"');
    expect(markup).toContain('role="treeitem"');
    expect(markup).toContain('aria-level="5"');
    expect(markup).toContain("actor");
  });

  it("renders connections and folders in CatalogExplorer with context menu triggers", () => {
    const profiles = [
      sampleConnection({ id: "conn-1", name: "Analytics", folder: null }),
      sampleConnection({ id: "conn-2", name: "Warehouse", folder: "Production" }),
    ];

    const markup = renderToStaticMarkup(
      <CatalogExplorer
        profiles={profiles}
        active="conn-1"
        revision={0}
        scope={async () => ({ connectionId: "conn-1", database: "pagila", password: null })}
        onSnapshot={() => {}}
        onEntries={() => {}}
        openSql={() => {}}
        onRefresh={() => {}}
      />,
    );

    expect(markup).toContain("Analytics");
    expect(markup).toContain("Production");
    expect(markup).toContain('data-slot="context-menu-trigger"');
    expect(markup).toContain('data-active="true"');
  });
});
