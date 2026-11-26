import { describe, expect, it } from "vite-plus/test";

import {
  buildForeignKeyQuery,
  foreignKeyTabTitle,
  formatSqlLiteral,
  needsFullCellRead,
} from "./foreign-key-query";

describe("foreign key query builder", () => {
  it("builds filtered PostgreSQL queries for Pagila foreign keys", () => {
    expect(
      buildForeignKeyQuery(
        { schema: "public", table: "customer", column: "customer_id" },
        130,
        "int",
        "postgres",
      ),
    ).toBe('SELECT *\nFROM "public"."customer"\nWHERE "customer_id" = 130;');

    expect(
      buildForeignKeyQuery(
        { schema: "public", table: "language", column: "name" },
        "O'Brien",
        "text",
        "postgres",
      ),
    ).toBe('SELECT *\nFROM "public"."language"\nWHERE "name" = \'O\'\'Brien\';');
  });

  it("builds filtered SQL Server queries with bracket quoting and dialect literals", () => {
    expect(
      buildForeignKeyQuery(
        { schema: "SalesLT", table: "Customer", column: "CustomerID" },
        29485,
        "int",
        "sqlserver",
      ),
    ).toBe("SELECT *\nFROM [SalesLT].[Customer]\nWHERE [CustomerID] = 29485;");

    expect(formatSqlLiteral(true, "bool", "sqlserver")).toBe("1");
    expect(formatSqlLiteral(false, "bool", "sqlserver")).toBe("0");
    expect(formatSqlLiteral("0x00ff", "binary", "sqlserver")).toBe("0x00ff");
  });

  it("builds filtered Oracle queries with Oracle date, timestamp, and raw literals", () => {
    expect(
      buildForeignKeyQuery(
        { schema: "HR", table: "DEPARTMENTS", column: "DEPARTMENT_ID" },
        "90",
        "decimal",
        "oracle",
      ),
    ).toBe('SELECT *\nFROM "HR"."DEPARTMENTS"\nWHERE "DEPARTMENT_ID" = 90;');

    expect(formatSqlLiteral("IT_PROG", "text", "oracle")).toBe("'IT_PROG'");
    expect(formatSqlLiteral("2026-01-20", "date", "oracle")).toBe("DATE '2026-01-20'");
    expect(formatSqlLiteral("2026-01-20 10:30:00", "timestamp", "oracle")).toBe(
      "TIMESTAMP '2026-01-20 10:30:00'",
    );
    expect(formatSqlLiteral("0x00ff", "binary", "oracle")).toBe("HEXTORAW('00ff')");
    expect(formatSqlLiteral("0x00ff", "binary", "postgres")).toBe("decode('00ff', 'hex')");
    expect(formatSqlLiteral(true, "bool", "postgres")).toBe("TRUE");
    expect(formatSqlLiteral("9223372036854775807", "int", "postgres")).toBe("9223372036854775807");
    expect(formatSqlLiteral("00123", "text", "postgres")).toBe("'00123'");
  });

  it("formats concise tab titles and detects truncated cells", () => {
    expect(
      foreignKeyTabTitle({ schema: "public", table: "customer", column: "customer_id" }, 130),
    ).toBe("customer (130)");
    expect(
      foreignKeyTabTitle(
        { schema: "public", table: "users", column: "id" },
        "a144e09d-e626-40bb-95ad-0560fb123456",
      ),
    ).toBe("users (a144e09d-e626-40b…)");

    expect(needsFullCellRead(130, "int")).toBe(false);
    expect(needsFullCellRead("0x00ff", "binary")).toBe(true);
    expect(needsFullCellRead(`${"x".repeat(2000)}…`, "text")).toBe(true);
  });
});
