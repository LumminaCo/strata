import { describe, expect, test } from "vite-plus/test";

import type { ColumnMeta } from "@/ipc/bindings/protocol";

import { buildTableDataQuery } from "./table-data";

const customerColumns: ColumnMeta[] = [
  {
    name: "CustomerId",
    db_type: "int4",
    kind: "int",
    nullable: false,
    table_oid: null,
    column_id: null,
  },
  {
    name: "FirstName",
    db_type: "varchar",
    kind: "text",
    nullable: false,
    table_oid: null,
    column_id: null,
  },
  {
    name: "Email",
    db_type: "varchar",
    kind: "text",
    nullable: true,
    table_oid: null,
    column_id: null,
  },
  {
    name: "DocumentCode",
    db_type: "varchar",
    kind: "text",
    nullable: true,
    table_oid: null,
    column_id: null,
  },
  {
    name: "ExternalUuid",
    db_type: "uuid",
    kind: "uuid",
    nullable: true,
    table_oid: null,
    column_id: null,
  },
  {
    name: "IsActive",
    db_type: "bool",
    kind: "bool",
    nullable: false,
    table_oid: null,
    column_id: null,
  },
  {
    name: "CreatedAt",
    db_type: "timestamptz",
    kind: "timestamptz",
    nullable: false,
    table_oid: null,
    column_id: null,
  },
  {
    name: "user",
    db_type: "varchar",
    kind: "text",
    nullable: true,
    table_oid: null,
    column_id: null,
  },
];

describe("buildTableDataQuery", () => {
  test("quotes mixed-case columns and string values for PostgreSQL SELECT and COUNT queries", () => {
    expect(
      buildTableDataQuery({
        table: '"public"."Customers"',
        kind: "postgres",
        columns: customerColumns,
        filter: "FirstName = Alice AND DocumentCode = 00123",
        order: "CustomerId",
      }),
    ).toBe(
      'SELECT * FROM "public"."Customers" WHERE ("FirstName" = \'Alice\' AND "DocumentCode" = \'00123\') ORDER BY "CustomerId"',
    );

    expect(
      buildTableDataQuery({
        table: '"public"."Customers"',
        kind: "postgres",
        columns: customerColumns,
        filter: "email = alice@example.com AND externaluuid = 550e8400-e29b-41d4-a716-446655440000",
        countOnly: true,
      }),
    ).toBe(
      'SELECT COUNT(*) FROM "public"."Customers" WHERE ("Email" = \'alice@example.com\' AND "ExternalUuid" = \'550e8400-e29b-41d4-a716-446655440000\')',
    );
  });

  test("quotes columns and values using SQL Server and Oracle dialect conventions", () => {
    expect(
      buildTableDataQuery({
        table: "[dbo].[Customers]",
        kind: "sqlserver",
        columns: customerColumns,
        filter: "FirstName CONTAINS ali AND IsActive = true",
        order: "FirstName",
      }),
    ).toBe(
      "SELECT * FROM [dbo].[Customers] WHERE (LOWER([FirstName]) LIKE '%ali%' AND [IsActive] = 1) ORDER BY [FirstName]",
    );

    expect(
      buildTableDataQuery({
        table: '"HR"."Customers"',
        kind: "oracle",
        columns: customerColumns,
        filter: "user = admin AND CreatedAt >= 2026-01-15",
      }),
    ).toBe(
      'SELECT * FROM "HR"."Customers" WHERE ("user" = \'admin\' AND "CreatedAt" >= \'2026-01-15\')',
    );
  });

  test("passes through native SQL expressions that use functions or custom operators", () => {
    expect(
      buildTableDataQuery({
        table: '"public"."Customers"',
        kind: "postgres",
        columns: customerColumns,
        filter: "LOWER(\"FirstName\") = 'alice'",
      }),
    ).toBe('SELECT * FROM "public"."Customers" WHERE (LOWER("FirstName") = \'alice\')');
  });
});
