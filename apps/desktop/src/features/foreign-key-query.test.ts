import { describe, expect, it } from "vite-plus/test";

import type { ColumnMeta } from "@/ipc/bindings/protocol";

import { buildForeignKeyFilter, formatSqlLiteral, needsFullCellRead } from "./foreign-key-query";
import { buildTableDataQuery } from "./table-data";

describe("foreign key filter builder", () => {
  it("builds PostgreSQL filters for Pagila foreign keys", () => {
    expect(
      buildForeignKeyFilter(
        { schema: "public", table: "customer", column: "customer_id" },
        130,
        "int",
        "postgres",
      ),
    ).toBe('"customer_id" = 130');

    expect(
      buildForeignKeyFilter(
        { schema: "public", table: "language", column: "name" },
        "O'Brien",
        "text",
        "postgres",
      ),
    ).toBe("\"name\" = 'O''Brien'");
  });

  it("builds SQL Server filters with bracket quoting and dialect literals", () => {
    expect(
      buildForeignKeyFilter(
        { schema: "SalesLT", table: "Customer", column: "CustomerID" },
        29485,
        "int",
        "sqlserver",
      ),
    ).toBe("[CustomerID] = 29485");

    expect(formatSqlLiteral(true, "bool", "sqlserver")).toBe("1");
    expect(formatSqlLiteral(false, "bool", "sqlserver")).toBe("0");
    expect(formatSqlLiteral("0x00ff", "binary", "sqlserver")).toBe("0x00ff");
  });

  it("builds Oracle filters with Oracle date, timestamp, and raw literals", () => {
    expect(
      buildForeignKeyFilter(
        { schema: "HR", table: "DEPARTMENTS", column: "DEPARTMENT_ID" },
        "90",
        "decimal",
        "oracle",
      ),
    ).toBe('"DEPARTMENT_ID" = 90');

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

  it("keeps the filter when the Table Tab loads and when the user re-applies it", () => {
    const filter = buildForeignKeyFilter(
      { schema: "public", table: "customer", column: "customer_id" },
      130,
      "int",
      "postgres",
    );
    const columns: ColumnMeta[] = [
      {
        name: "customer_id",
        db_type: "int4",
        kind: "int",
        nullable: false,
        table_oid: null,
        column_id: null,
      },
      {
        name: "first_name",
        db_type: "text",
        kind: "text",
        nullable: false,
        table_oid: null,
        column_id: null,
      },
    ];
    const table = '"public"."customer"';
    const expected = 'SELECT * FROM "public"."customer" WHERE ("customer_id" = 130)';
    expect(buildTableDataQuery({ table, kind: "postgres", columns: [], filter })).toBe(expected);
    expect(buildTableDataQuery({ table, kind: "postgres", columns, filter })).toBe(expected);
  });

  it("detects truncated cells", () => {
    expect(needsFullCellRead(130, "int")).toBe(false);
    expect(needsFullCellRead("0x00ff", "binary")).toBe(true);
    expect(needsFullCellRead(`${"x".repeat(2000)}…`, "text")).toBe(true);
  });
});
