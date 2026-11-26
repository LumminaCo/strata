import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  CatalogExplorer,
  OBJECT_PAGE_SIZE,
  buildExplorerRows,
  buildSchemaGroupsFromCounts,
  isNodeVisibleAndExpanded,
  makeObjectNode,
  mergeObjects,
  nodeKey,
  type FilteredGroupState,
  type GroupPaginationState,
} from "@/features/catalog-explorer";
import type { CatalogNode } from "@/features/catalog-context-menu";
import type {
  Connection,
  Object as CatalogObject,
  ObjectKind,
  ObjectKindCount,
} from "@/ipc/bindings/protocol";

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

function makeFixtureTree(
  counts: ObjectKindCount[],
  loadedByKind: Partial<Record<ObjectKind, CatalogObject[]>> = {},
  expandedKinds: ObjectKind[] = [],
) {
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
  const groupNodes = buildSchemaGroupsFromCounts(schemaNode, counts);
  const children: Record<string, CatalogNode[]> = {
    [connNode.key]: [dbNode],
    [dbNode.key]: [schemaNode],
    [schemaNode.key]: groupNodes,
  };
  for (const group of groupNodes) {
    const items = group.objectKind ? loadedByKind[group.objectKind] : undefined;
    if (items) {
      children[group.key] = items.map((item) => makeObjectNode(group, item));
    }
  }
  const expanded = new Set<string>([
    connNode.key,
    dbNode.key,
    schemaNode.key,
    ...groupNodes
      .filter((group) => group.objectKind && expandedKinds.includes(group.objectKind))
      .map((group) => group.key),
  ]);
  const groupFor = (kind: ObjectKind) => groupNodes.find((group) => group.objectKind === kind);
  return { connNode, dbNode, schemaNode, groupNodes, groupFor, children, expanded };
}

describe("CatalogExplorer lazy group loading, pagination, and filtering", () => {
  it("shows only group rows with item counts before clicking into any group", () => {
    const { connNode, groupNodes, children, expanded } = makeFixtureTree([
      { kind: "table", count: 1423 },
      { kind: "view", count: 12 },
      { kind: "procedure", count: 45 },
      { kind: "function", count: 0 },
    ]);

    expect(groupNodes.every((group) => group.children === undefined)).toBe(true);
    expect(groupNodes.map((group) => `${group.label}:${group.countLabel}`)).toEqual([
      "Tables:1423",
      "Views:12",
      "Procedures:45",
    ]);

    const rows = buildExplorerRows({
      roots: [connNode],
      expanded,
      children,
      filter: "",
      groupPages: {},
      filteredGroups: {},
    });

    expect(rows.some((row) => row.node.kind === "object")).toBe(false);
    expect(rows.some((row) => row.node.kind === "load_more")).toBe(false);
    const renderedGroups = rows.filter((row) => row.node.kind === "group");
    expect(renderedGroups.map((row) => `${row.node.label}:${row.node.countLabel}`)).toEqual([
      "Tables:1423",
      "Views:12",
      "Procedures:45",
    ]);
  });

  it("places top and bottom fetch-more controls for any paginated object group while preserving total count", () => {
    const { connNode, groupFor, children, expanded } = makeFixtureTree(
      [
        { kind: "table", count: 250 },
        { kind: "view", count: 150 },
        { kind: "procedure", count: 2 },
      ],
      {
        table: [makeObject(1, "ACCOUNTS", "table"), makeObject(2, "ORDERS", "table")],
        view: [makeObject(10, "V_ACCOUNTS", "view"), makeObject(11, "V_ORDERS", "view")],
        procedure: [
          makeObject(20, "SP_CLOSE", "procedure"),
          makeObject(21, "SP_OPEN", "procedure"),
        ],
      },
      ["table", "view", "procedure"],
    );
    const tablesGroup = groupFor("table")!;
    const viewsGroup = groupFor("view")!;
    const procsGroup = groupFor("procedure")!;

    const groupPages: Record<string, GroupPaginationState> = {
      [tablesGroup.key]: { hasMore: true, nextOffset: OBJECT_PAGE_SIZE, loading: false, error: "" },
      [viewsGroup.key]: { hasMore: true, nextOffset: OBJECT_PAGE_SIZE, loading: false, error: "" },
      [procsGroup.key]: { hasMore: false, nextOffset: 2, loading: false, error: "" },
    };

    const rows = buildExplorerRows({
      roots: [connNode],
      expanded,
      children,
      filter: "",
      groupPages,
      filteredGroups: {},
    });

    const tablesIndex = rows.findIndex((row) => row.node.key === tablesGroup.key);
    expect(rows[tablesIndex]?.node.countLabel).toBe("250");
    expect(rows[tablesIndex + 1]?.node).toMatchObject({
      kind: "load_more",
      position: "top",
      groupKey: tablesGroup.key,
      label: "Fetch more tables",
    });
    expect(rows[tablesIndex + 2]?.node.label).toBe("ACCOUNTS");
    expect(rows[tablesIndex + 3]?.node.label).toBe("ORDERS");
    expect(rows[tablesIndex + 4]?.node).toMatchObject({
      kind: "load_more",
      position: "bottom",
      groupKey: tablesGroup.key,
      label: "Fetch more tables",
    });

    const viewsIndex = rows.findIndex((row) => row.node.key === viewsGroup.key);
    expect(rows[viewsIndex]?.node.countLabel).toBe("150");
    expect(rows[viewsIndex + 1]?.node).toMatchObject({
      kind: "load_more",
      position: "top",
      groupKey: viewsGroup.key,
      label: "Fetch more views",
    });
    expect(rows[viewsIndex + 4]?.node).toMatchObject({
      kind: "load_more",
      position: "bottom",
      groupKey: viewsGroup.key,
      label: "Fetch more views",
    });

    const procsIndex = rows.findIndex((row) => row.node.key === procsGroup.key);
    expect(rows[procsIndex]?.node.countLabel).toBe("2");
    expect(rows[procsIndex + 1]?.node.label).toBe("SP_CLOSE");
    expect(rows[procsIndex + 2]?.node.label).toBe("SP_OPEN");
  });

  it("filters only tables and procedures locally when loaded completely and excludes other kinds", () => {
    const { connNode, groupFor, children, expanded } = makeFixtureTree(
      [
        { kind: "table", count: 1 },
        { kind: "procedure", count: 1 },
        { kind: "view", count: 1 },
        { kind: "materialized_view", count: 1 },
        { kind: "function", count: 1 },
        { kind: "sequence", count: 1 },
        { kind: "synonym", count: 1 },
      ],
      {
        table: [makeObject(1, "PAY_LEDGER", "table")],
        procedure: [makeObject(2, "SP_PAY_RUN", "procedure")],
        view: [makeObject(3, "V_PAY_SUMMARY", "view")],
        materialized_view: [makeObject(4, "MV_PAY_CACHE", "materialized_view")],
        function: [makeObject(5, "FN_PAY_TAX", "function")],
        sequence: [makeObject(6, "SEQ_PAY_ID", "sequence")],
        synonym: [makeObject(7, "SYN_PAY", "synonym")],
      },
      ["table", "procedure"],
    );
    const groupPages: Record<string, GroupPaginationState> = {
      [groupFor("table")!.key]: { hasMore: false, nextOffset: 1, loading: false, error: "" },
      [groupFor("procedure")!.key]: { hasMore: false, nextOffset: 1, loading: false, error: "" },
    };

    const rows = buildExplorerRows({
      roots: [connNode],
      expanded,
      children,
      filter: "pay",
      groupPages,
      filteredGroups: {},
    });

    const objectRows = rows.filter((row) => row.node.kind === "object");
    expect(objectRows.map((row) => `${row.node.object?.kind}:${row.node.label}`)).toEqual([
      "table:PAY_LEDGER",
      "procedure:SP_PAY_RUN",
    ]);

    const schemaNameOnly = buildExplorerRows({
      roots: [connNode],
      expanded,
      children,
      filter: "SFBZ0800",
      groupPages,
      filteredGroups: {},
    });
    expect(schemaNameOnly).toHaveLength(0);
  });

  it("uses remote search for unloaded or paginated tables and procedures and keeps results while loading next page", () => {
    const { connNode, groupFor, children, expanded } = makeFixtureTree([
      { kind: "table", count: 500 },
      { kind: "procedure", count: 30 },
      { kind: "view", count: 12 },
    ]);
    const tablesGroup = groupFor("table")!;
    const procsGroup = groupFor("procedure")!;

    // Neither Tables nor Procedures was clicked yet, so both enter remote search loading while Views is excluded.
    const searchingRows = buildExplorerRows({
      roots: [connNode],
      expanded,
      children,
      filter: "ventas",
      groupPages: {},
      filteredGroups: {},
    });
    const searchingGroups = searchingRows.filter((row) => row.node.kind === "group");
    expect(searchingGroups.map((row) => `${row.node.objectKind}:${row.node.loading}`)).toEqual([
      "table:true",
      "procedure:true",
    ]);

    const remoteState: Record<string, FilteredGroupState> = {
      [tablesGroup.key]: {
        query: "ventas",
        objects: [makeObject(901, "VENTAS_2026", "table")],
        hasMore: true,
        nextOffset: 100,
        loading: true,
        error: "",
      },
      [procsGroup.key]: {
        query: "ventas",
        objects: [makeObject(902, "SP_VENTAS", "procedure")],
        hasMore: false,
        nextOffset: 1,
        loading: false,
        error: "",
      },
    };
    const loadingNextPageRows = buildExplorerRows({
      roots: [connNode],
      expanded,
      children,
      filter: "ventas",
      groupPages: {},
      filteredGroups: remoteState,
    });
    const loadMoreRows = loadingNextPageRows.filter((row) => row.node.kind === "load_more");
    expect(loadMoreRows.map((row) => row.node.position)).toEqual(["top", "bottom"]);
    expect(loadMoreRows.every((row) => row.node.label === "Fetching more tables…")).toBe(true);
    expect(
      loadingNextPageRows.filter((row) => row.node.kind === "object").map((row) => row.node.label),
    ).toEqual(["VENTAS_2026", "SP_VENTAS"]);
  });

  it("checks visibility and expansion before reloading nodes on refresh", () => {
    const { connNode, dbNode, schemaNode, groupFor } = makeFixtureTree([
      { kind: "table", count: 50 },
      { kind: "view", count: 5 },
    ]);
    const tablesGroup = groupFor("table")!;
    const viewsGroup = groupFor("view")!;

    const expanded = new Set([connNode.key, dbNode.key, schemaNode.key, tablesGroup.key]);
    expect(isNodeVisibleAndExpanded(schemaNode, expanded)).toBe(true);
    expect(isNodeVisibleAndExpanded(tablesGroup, expanded)).toBe(true);
    expect(isNodeVisibleAndExpanded(viewsGroup, expanded)).toBe(false);

    // Collapsing the schema makes its expanded group no longer visible.
    expanded.delete(schemaNode.key);
    expect(isNodeVisibleAndExpanded(tablesGroup, expanded)).toBe(false);
  });

  it("deduplicates appended object pages and skips materialized-view container names", () => {
    const existing = [makeObject(1, "T1", "table"), makeObject(2, "T2", "table")];
    const incoming = [
      makeObject(2, "T2", "table"),
      makeObject(3, "MV_SALES", "table"),
      makeObject(4, "T3", "table"),
    ];
    const merged = mergeObjects(existing, incoming, new Set(["MV_SALES"]));
    expect(merged.map((item) => item.name)).toEqual(["T1", "T2", "T3"]);
  });

  it("renders the scoped filter input placeholder and label", () => {
    const markup = renderToStaticMarkup(
      <CatalogExplorer
        profiles={[oracleProfile]}
        active={oracleProfile.id}
        revision={0}
        scope={async () => ({ connectionId: "conn-oracle", database: "ORCL", password: null })}
        onObjects={() => {}}
        onEntries={() => {}}
        openSql={() => {}}
        onRefresh={() => {}}
      />,
    );
    expect(markup).toContain('aria-label="Filter tables and procedures"');
    expect(markup).toContain('placeholder="Filter tables &amp; procedures"');
  });
});
