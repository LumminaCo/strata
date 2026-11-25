import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  CatalogExplorer,
  TABLE_PAGE_SIZE,
  buildExplorerRows,
  buildSchemaGroups,
  mergeTables,
  nodeKey,
  type FilteredTablesState,
  type TablePaginationState,
} from "@/features/catalog-explorer";
import type { CatalogNode } from "@/features/catalog-context-menu";
import type { Connection, Object as CatalogObject, ObjectKind } from "@/ipc/bindings/protocol";

const oracleProfile: Connection = {
  id: "conn-oracle",
  name: "Oracle Prod",
  kind: "oracle",
  env: "prod",
  color: null,
  folder: null,
  host: "oracle.internal",
  port: 1521,
  database: "ORCL",
  user: "APP",
  secret: "prompt",
  readOnly: true,
  agentAccess: "none",
  allowAgentDdl: false,
  options: null,
  tls: "prefer",
};

function makeObject(oid: number, name: string, kind: ObjectKind): CatalogObject {
  return {
    oid,
    schema: "SFBZ0800",
    name,
    kind,
    rows: null,
    comment: null,
  };
}

function makeFixtureTree(objects: CatalogObject[]) {
  const connNode: CatalogNode = {
    key: nodeKey("conn-oracle"),
    kind: "connection",
    label: oracleProfile.name,
    connection: oracleProfile,
    database: oracleProfile.database,
  };
  const dbNode: CatalogNode = {
    key: nodeKey(connNode.key, oracleProfile.database),
    kind: "database",
    label: oracleProfile.database,
    connection: oracleProfile,
    database: oracleProfile.database,
  };
  const schemaNode: CatalogNode = {
    key: nodeKey(dbNode.key, "SFBZ0800"),
    kind: "schema",
    label: "SFBZ0800",
    connection: oracleProfile,
    database: oracleProfile.database,
    schema: "SFBZ0800",
  };
  const groups = buildSchemaGroups(schemaNode, objects);
  const tablesGroup = groups.find((group) => group.objectKind === "table");
  const children: Record<string, CatalogNode[]> = {
    [connNode.key]: [dbNode],
    [dbNode.key]: [schemaNode],
    [schemaNode.key]: groups,
  };
  const expanded = new Set<string>([
    connNode.key,
    dbNode.key,
    schemaNode.key,
    ...(tablesGroup ? [tablesGroup.key] : []),
  ]);
  return { connNode, dbNode, schemaNode, tablesGroup, children, expanded };
}

describe("CatalogExplorer pagination and filtering", () => {
  it("places a fetch-more button at both the start and end of the tables list when more tables exist", () => {
    const objects = [
      makeObject(1, "ACCOUNTS", "table"),
      makeObject(2, "ORDERS", "table"),
      makeObject(3, "V_ORDERS", "view"),
    ];
    const { connNode, schemaNode, children, expanded } = makeFixtureTree(objects);
    const tablePages: Record<string, TablePaginationState> = {
      [schemaNode.key]: { hasMore: true, nextOffset: TABLE_PAGE_SIZE, loading: false, error: "" },
    };

    const rows = buildExplorerRows({
      roots: [connNode],
      expanded,
      children,
      filter: "",
      tablePages,
      filteredTables: {},
    });

    const tablesIndex = rows.findIndex(
      (row) => row.node.kind === "group" && row.node.objectKind === "table",
    );
    expect(tablesIndex).toBeGreaterThan(-1);
    expect(rows[tablesIndex]?.node.countLabel).toBe("2+");
    expect(rows[tablesIndex + 1]?.node).toMatchObject({
      kind: "load_more",
      position: "top",
      label: "Fetch more tables",
    });
    expect(rows[tablesIndex + 2]?.node.label).toBe("ACCOUNTS");
    expect(rows[tablesIndex + 3]?.node.label).toBe("ORDERS");
    expect(rows[tablesIndex + 4]?.node).toMatchObject({
      kind: "load_more",
      position: "bottom",
      label: "Fetch more tables",
    });

    const completeRows = buildExplorerRows({
      roots: [connNode],
      expanded,
      children,
      filter: "",
      tablePages: {
        [schemaNode.key]: { hasMore: false, nextOffset: 2, loading: false, error: "" },
      },
      filteredTables: {},
    });
    expect(completeRows.some((row) => row.node.kind === "load_more")).toBe(false);
    const completeTables = completeRows.find(
      (row) => row.node.kind === "group" && row.node.objectKind === "table",
    );
    expect(completeTables?.node.countLabel).toBe("2");
  });

  it("filters only tables and procedures and excludes views, functions, sequences, synonyms, and container labels", () => {
    const objects = [
      makeObject(1, "PAY_LEDGER", "table"),
      makeObject(2, "SP_PAY_RUN", "procedure"),
      makeObject(3, "V_PAY_SUMMARY", "view"),
      makeObject(4, "MV_PAY_CACHE", "materialized_view"),
      makeObject(5, "FN_PAY_TAX", "function"),
      makeObject(6, "SEQ_PAY_ID", "sequence"),
      makeObject(7, "SYN_PAY", "synonym"),
    ];
    const { connNode, schemaNode, children, expanded } = makeFixtureTree(objects);
    const tablePages: Record<string, TablePaginationState> = {
      [schemaNode.key]: { hasMore: false, nextOffset: 1, loading: false, error: "" },
    };

    const rows = buildExplorerRows({
      roots: [connNode],
      expanded,
      children,
      filter: "pay",
      tablePages,
      filteredTables: {},
    });

    const objectRows = rows.filter((row) => row.node.kind === "object");
    expect(objectRows.map((row) => `${row.node.object?.kind}:${row.node.label}`)).toEqual([
      "table:PAY_LEDGER",
      "procedure:SP_PAY_RUN",
    ]);

    // Matching the connection or schema name alone must not match when no table or procedure matches.
    const schemaNameOnly = buildExplorerRows({
      roots: [connNode],
      expanded,
      children,
      filter: "SFBZ0800",
      tablePages,
      filteredTables: {},
    });
    expect(schemaNameOnly).toHaveLength(0);
  });

  it("renders remote filtered tables with top and bottom fetch-more controls and keeps items while loading the next page", () => {
    const objects = [
      makeObject(1, "AAA_FIRST", "table"),
      makeObject(2, "SP_VENTAS", "procedure"),
      makeObject(3, "V_VENTAS", "view"),
    ];
    const { connNode, schemaNode, children, expanded } = makeFixtureTree(objects);
    const tablePages: Record<string, TablePaginationState> = {
      [schemaNode.key]: { hasMore: true, nextOffset: TABLE_PAGE_SIZE, loading: false, error: "" },
    };

    // Initial remote search in flight keeps the Tables group visible with loading indicator.
    const searchingRows = buildExplorerRows({
      roots: [connNode],
      expanded,
      children,
      filter: "ventas",
      tablePages,
      filteredTables: {},
    });
    const searchingTables = searchingRows.find(
      (row) => row.node.kind === "group" && row.node.objectKind === "table",
    );
    expect(searchingTables?.node.loading).toBe(true);

    // Remote results returned with more matching tables available.
    const remoteState: Record<string, FilteredTablesState> = {
      [schemaNode.key]: {
        query: "ventas",
        objects: [makeObject(901, "VENTAS_2026", "table")],
        hasMore: true,
        nextOffset: 100,
        loading: true,
        error: "",
      },
    };
    const loadingNextPageRows = buildExplorerRows({
      roots: [connNode],
      expanded,
      children,
      filter: "ventas",
      tablePages,
      filteredTables: remoteState,
    });
    const loadMoreRows = loadingNextPageRows.filter((row) => row.node.kind === "load_more");
    expect(loadMoreRows.map((row) => row.node.position)).toEqual(["top", "bottom"]);
    expect(loadMoreRows.every((row) => row.node.label === "Fetching more tables…")).toBe(true);
    expect(
      loadingNextPageRows.filter((row) => row.node.kind === "object").map((row) => row.node.label),
    ).toEqual(["VENTAS_2026", "SP_VENTAS"]);
  });

  it("deduplicates appended table pages and skips materialized-view container names", () => {
    const existing = [makeObject(1, "T1", "table"), makeObject(2, "T2", "table")];
    const incoming = [
      makeObject(2, "T2", "table"),
      makeObject(3, "MV_SALES", "table"),
      makeObject(4, "T3", "table"),
    ];
    const merged = mergeTables(existing, incoming, new Set(["MV_SALES"]));
    expect(merged.map((item) => item.name)).toEqual(["T1", "T2", "T3"]);
  });

  it("renders the scoped filter input placeholder and label", () => {
    const markup = renderToStaticMarkup(
      <CatalogExplorer
        profiles={[oracleProfile]}
        active={oracleProfile.id}
        revision={0}
        scope={async () => ({ connectionId: "conn-oracle", database: "ORCL", password: null })}
        onSnapshot={() => {}}
        onEntries={() => {}}
        openSql={() => {}}
        onRefresh={() => {}}
      />,
    );
    expect(markup).toContain('aria-label="Filter tables and procedures"');
    expect(markup).toContain('placeholder="Filter tables &amp; procedures"');
  });
});
