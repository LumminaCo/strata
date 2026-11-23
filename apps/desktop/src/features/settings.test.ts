import { describe, expect, it } from "vitest";

import { emptyConnection } from "@/features/connections";
import {
  defaultSettings,
  formatEndpoint,
  groupConnections,
  isDefaultSettings,
  matchesQuery,
  parseSettingNumber,
} from "@/features/settings";

describe("settings helpers", () => {
  it("recognizes default settings and detects changes", () => {
    expect(isDefaultSettings({ ...defaultSettings })).toBe(true);
    expect(isDefaultSettings({ ...defaultSettings, theme: "dark" })).toBe(false);
    expect(isDefaultSettings({ ...defaultSettings, editor_font_size: 16 })).toBe(false);
  });

  it("validates integer ranges for numeric settings", () => {
    expect(parseSettingNumber("500", 1, 200_000)).toEqual({ value: 500 });
    expect(parseSettingNumber("0", 0, 4_294_967_295)).toEqual({ value: 0 });
    expect("error" in parseSettingNumber("", 10, 32)).toBe(true);
    expect("error" in parseSettingNumber("9", 10, 32)).toBe(true);
    expect("error" in parseSettingNumber("33", 10, 32)).toBe(true);
    expect("error" in parseSettingNumber("12.5", 10, 32)).toBe(true);
  });

  it("matches multi-word search queries across fields", () => {
    expect(matchesQuery("", "Theme")).toBe(true);
    expect(matchesQuery("agent rows", "Agent default rows", "MCP query limit")).toBe(true);
    expect(matchesQuery("prod confirm", "Confirm production writes")).toBe(true);
    expect(matchesQuery("oracle", "Local PostgreSQL", "postgres")).toBe(false);
  });

  it("groups connections by folder while keeping ungrouped connections first", () => {
    const groups = groupConnections([
      { ...emptyConnection, id: "1", name: "Analytics", folder: "Reporting" },
      { ...emptyConnection, id: "2", name: "Primary", folder: null },
      { ...emptyConnection, id: "3", name: "Warehouse", folder: "Reporting" },
      { ...emptyConnection, id: "4", name: "Staging", folder: "  " },
    ]);

    expect(groups.map((group) => [group.folder, group.items.map((item) => item.name)])).toEqual([
      [null, ["Primary", "Staging"]],
      ["Reporting", ["Analytics", "Warehouse"]],
    ]);
  });

  it("formats connection endpoints with and without user", () => {
    expect(
      formatEndpoint({
        ...emptyConnection,
        user: "postgres",
        host: "db.internal",
        port: 5432,
        database: "pagila",
      }),
    ).toBe("postgres@db.internal:5432/pagila");

    expect(
      formatEndpoint({
        ...emptyConnection,
        user: "",
        host: "mssql",
        port: 1433,
        database: "master",
      }),
    ).toBe("mssql:1433/master");
  });
});
