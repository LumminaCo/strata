import { describe, expect, test } from "vite-plus/test";

import type { Cell, ColumnMeta } from "@/ipc/bindings/protocol";

import {
  applyFilterSuggestion,
  compileFilterExpression,
  compileSqlWhereExpression,
  computeRowIndices,
  formatColumnIdentifier,
  formatFilterLiteral,
  formatSortHeader,
  getFilterSuggestions,
  moveSortRule,
  removeColumnSort,
  setColumnSort,
  toggleColumnSort,
  type SortRule,
} from "./result-query";

const columns: ColumnMeta[] = [
  { name: "id", db_type: "int4", kind: "int", nullable: false, table_oid: null, column_id: null },
  {
    name: "department",
    db_type: "varchar",
    kind: "text",
    nullable: true,
    table_oid: null,
    column_id: null,
  },
  {
    name: "name",
    db_type: "varchar",
    kind: "text",
    nullable: false,
    table_oid: null,
    column_id: null,
  },
  {
    name: "salary",
    db_type: "numeric",
    kind: "decimal",
    nullable: true,
    table_oid: null,
    column_id: null,
  },
  {
    name: "active",
    db_type: "bool",
    kind: "bool",
    nullable: false,
    table_oid: null,
    column_id: null,
  },
  {
    name: "First Name",
    db_type: "varchar",
    kind: "text",
    nullable: true,
    table_oid: null,
    column_id: null,
  },
];

const rows: Cell[][] = [
  [1, "Engineering", "Alice", "120", true, "Alice"],
  [2, "Engineering", "Bob", "95", true, "Bob"],
  [3, "Sales", "Carla", "110", false, "Carla"],
  [4, "Sales", "David", "95", true, "David"],
  [5, null, "Eve", null, false, null],
  [6, "Engineering", "Frank", "120", false, "Frank"],
];

describe("multi-column sorting", () => {
  test("cycles unsorted -> ASC -> DESC -> removed per column while nesting", () => {
    let sorts: SortRule[] = [];
    sorts = toggleColumnSort(sorts, 1);
    expect(sorts).toEqual([{ column: 1, descending: false }]);

    // Nest second column
    sorts = toggleColumnSort(sorts, 3);
    expect(sorts).toEqual([
      { column: 1, descending: false },
      { column: 3, descending: false },
    ]);

    // Flip second column to DESC
    sorts = toggleColumnSort(sorts, 3);
    expect(sorts).toEqual([
      { column: 1, descending: false },
      { column: 3, descending: true },
    ]);

    // Flip first column to DESC while keeping priority 1
    sorts = toggleColumnSort(sorts, 1);
    expect(sorts).toEqual([
      { column: 1, descending: true },
      { column: 3, descending: true },
    ]);

    // Third click on first column removes it; second column becomes priority 1
    sorts = toggleColumnSort(sorts, 1);
    expect(sorts).toEqual([{ column: 3, descending: true }]);

    // Third click on remaining column clears sorting completely
    sorts = toggleColumnSort(sorts, 3);
    expect(sorts).toEqual([]);
  });

  test("supports set, remove, reorder, and header labels with priority numbers", () => {
    let sorts = setColumnSort([], 1, false);
    sorts = setColumnSort(sorts, 3, true);
    expect(formatSortHeader("department", sorts, 1)).toBe("department ↑1");
    expect(formatSortHeader("salary", sorts, 3)).toBe("salary ↓2");
    expect(formatSortHeader("name", sorts, 2)).toBe("name");

    sorts = moveSortRule(sorts, 3, -1);
    expect(sorts).toEqual([
      { column: 3, descending: true },
      { column: 1, descending: false },
    ]);

    sorts = removeColumnSort(sorts, 3);
    expect(sorts).toEqual([{ column: 1, descending: false }]);
    expect(formatSortHeader("department", sorts, 1)).toBe("department ↑");
  });

  test("sorts rows by nested columns with numeric comparison and NULLS LAST", () => {
    // Sort by department ASC, then salary DESC, then name ASC
    const { indices } = computeRowIndices(rows, columns, {
      sorts: [
        { column: 1, descending: false },
        { column: 3, descending: true },
        { column: 2, descending: false },
      ],
    });
    // Engineering: Alice(120), Frank(120), Bob(95) -> Sales: Carla(110), David(95) -> null: Eve
    expect(indices).toEqual([0, 5, 1, 2, 3, 4]);
  });
});

describe("filter expression parsing and evaluation", () => {
  test("evaluates equality, numeric comparison, AND/OR/NOT, IN, BETWEEN, LIKE/ILIKE, CONTAINS, IS NULL", () => {
    const run = (expr: string) => {
      const compiled = compileFilterExpression(expr, columns);
      expect(compiled.ok).toBe(true);
      if (!compiled.ok || compiled.mode === "empty") return [];
      return rows.filter((row) => compiled.predicate(row)).map((row) => row[0]);
    };

    expect(run("department = 'Engineering'")).toEqual([1, 2, 6]);
    expect(run("department = 'Engineering' AND salary > 100")).toEqual([1, 6]);
    expect(run("department = 'Sales' OR id = 1")).toEqual([1, 3, 4]);
    expect(run("NOT active = true")).toEqual([3, 5, 6]);
    expect(run("department IS NULL")).toEqual([5]);
    expect(run("department IS NOT NULL AND salary <= 95")).toEqual([2, 4]);
    expect(run("id IN (1, 3, 5)")).toEqual([1, 3, 5]);
    expect(run("id NOT IN (1, 2, 3)")).toEqual([4, 5, 6]);
    expect(run("salary BETWEEN 95 AND 110")).toEqual([2, 3, 4]);
    expect(run("name ILIKE 'a%'")).toEqual([1]);
    expect(run("name LIKE 'A%'")).toEqual([1]);
    expect(run("name LIKE 'a%'")).toEqual([]);
    expect(run("name CONTAINS 'ar'")).toEqual([3]);
    expect(run("name STARTS WITH 'fr'")).toEqual([6]);
    expect(run("name ENDS WITH 'ce'")).toEqual([1]);
    expect(run("\"First Name\" = 'Bob'")).toEqual([2]);
    expect(run("(department = 'Engineering' OR department = 'Sales') AND active = false")).toEqual([
      3, 6,
    ]);
  });

  test("falls back to full-row text search for plain terms and reports errors for invalid expressions", () => {
    const plain = compileFilterExpression("carla", columns);
    expect(plain.ok).toBe(true);
    if (plain.ok && plain.mode === "text") {
      expect(rows.filter((row) => plain.predicate(row)).map((row) => row[0])).toEqual([3]);
    }

    const unknown = compileFilterExpression("missing_col = 1", columns);
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error).toContain("Unknown column");

    const incomplete = compileFilterExpression("salary >", columns);
    expect(incomplete.ok).toBe(false);
  });

  test("combines multiple filter chips with AND alongside draft filter and nested sort", () => {
    const { indices, activeFilterCount } = computeRowIndices(rows, columns, {
      filters: [
        { id: "f1", expression: "department = 'Engineering'" },
        { id: "f2", expression: "salary >= 95" },
      ],
      draftFilter: "active = true",
      sorts: [{ column: 3, descending: false }],
    });
    expect(activeFilterCount).toBe(3);
    // Bob (95), Alice (120)
    expect(indices).toEqual([1, 0]);
  });
});

describe("filter autocomplete", () => {
  test("suggests columns, operators, distinct values, and combinators based on cursor context", () => {
    // 1. Empty input -> all columns
    const initial = getFilterSuggestions("", 0, columns, rows);
    expect(initial.map((s) => s.label)).toEqual([
      "id",
      "department",
      "name",
      "salary",
      "active",
      "First Name",
    ]);

    // 2. Partial column -> filtered columns, and quotes names with spaces
    const firstSuggestions = getFilterSuggestions("first", 5, columns, rows);
    expect(firstSuggestions[0]?.label).toBe("First Name");
    expect(applyFilterSuggestion("first", firstSuggestions[0]!)).toEqual({
      text: '"First Name" ',
      cursor: 13,
    });

    // 3. After column name -> operators
    const opSuggestions = getFilterSuggestions("department ", 11, columns, rows);
    expect(opSuggestions.map((s) => s.label)).toContain("=");
    expect(opSuggestions.map((s) => s.label)).toContain("ILIKE");
    expect(opSuggestions.map((s) => s.label)).toContain("IS NULL");

    // 4. After operator -> distinct values from that column, quoted for strings
    const valSuggestions = getFilterSuggestions("department = ", 13, columns, rows);
    expect(valSuggestions.map((s) => s.insertText)).toEqual(["'Engineering'", "'Sales'"]);
    expect(valSuggestions[0]?.detail).toBe("3 rows");

    // 5. Partial quoted value -> replaces from opening quote without double-quoting
    const partialVal = getFilterSuggestions("department = 'eng", 17, columns, rows);
    expect(partialVal[0]?.label).toBe("Engineering");
    expect(applyFilterSuggestion("department = 'eng", partialVal[0]!)).toEqual({
      text: "department = 'Engineering'",
      cursor: 26,
    });

    // 6. Numeric column values are unquoted
    const numVals = getFilterSuggestions("salary >= ", 10, columns, rows);
    expect(numVals.map((s) => s.insertText)).toContain("120");
    expect(numVals.map((s) => s.insertText)).toContain("95");

    // 7. After complete predicate + space -> AND / OR
    const comb = getFilterSuggestions("department = 'Sales' ", 21, columns, rows);
    expect(comb.map((s) => s.label)).toEqual(["AND", "OR"]);

    // 8. After AND -> columns again
    const afterAnd = getFilterSuggestions("department = 'Sales' AND sal", 28, columns, rows);
    expect(afterAnd[0]?.label).toBe("salary");

    // 9. Inside IN (...) -> values
    const inVals = getFilterSuggestions("department IN (", 15, columns, rows);
    expect(inVals.map((s) => s.insertText)).toEqual(["'Engineering'", "'Sales'"]);

    // 10. Closed string literal -> no redundant value suggestions until user types space
    expect(getFilterSuggestions("department = 'Sales'", 20, columns, rows)).toEqual([]);

    // 11. Column suggestions always quote identifiers for SQL safety (double quotes by default, brackets for SQL Server)
    expect(initial[1]?.insertText).toBe('"department" ');
    const sqlServerInitial = getFilterSuggestions("", 0, columns, rows, undefined, "sqlserver");
    expect(sqlServerInitial[1]?.insertText).toBe("[department] ");

    // 12. Partial quoted column replaces from opening quote without double-quoting
    const partialQuotedCol = getFilterSuggestions('"dep', 4, columns, rows);
    expect(partialQuotedCol[0]?.label).toBe("department");
    expect(applyFilterSuggestion('"dep', partialQuotedCol[0]!)).toEqual({
      text: '"department" ',
      cursor: 13,
    });

    // 13. Closed quoted column suppresses redundant suggestions until user types space
    expect(getFilterSuggestions('"department"', 12, columns, rows)).toEqual([]);
  });
});

describe("SQL WHERE compilation and identifier/value quoting", () => {
  const sqlColumns: ColumnMeta[] = [
    ...columns,
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
      name: "ExternalId",
      db_type: "uuid",
      kind: "uuid",
      nullable: true,
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
      name: "UpdatedAt",
      db_type: "timestamptz",
      kind: "timestamptz",
      nullable: false,
      table_oid: null,
      column_id: null,
    },
    {
      name: "order",
      db_type: "int4",
      kind: "int",
      nullable: false,
      table_oid: null,
      column_id: null,
    },
  ];

  test("quotes column identifiers and literal values consistently across dialects", () => {
    expect(formatColumnIdentifier("FirstName")).toBe('"FirstName"');
    expect(formatColumnIdentifier('a"b', "postgres")).toBe('"a""b"');
    expect(formatColumnIdentifier("FirstName", "oracle")).toBe('"FirstName"');
    expect(formatColumnIdentifier("Order]Items", "sqlserver")).toBe("[Order]]Items]");

    expect(formatFilterLiteral("Alice", "text")).toBe("'Alice'");
    expect(formatFilterLiteral("O'Brien", "text")).toBe("'O''Brien'");
    expect(formatFilterLiteral("00123", "text")).toBe("'00123'");
    expect(formatFilterLiteral(123, "text")).toBe("'123'");
    expect(formatFilterLiteral(123, "int")).toBe("123");
    expect(formatFilterLiteral("120.50", "decimal")).toBe("120.50");
    expect(formatFilterLiteral(true, "bool", "postgres")).toBe("true");
    expect(formatFilterLiteral(true, "bool", "sqlserver")).toBe("1");
    expect(formatFilterLiteral(false, "bool", "sqlserver")).toBe("0");
    expect(formatFilterLiteral(null, "text")).toBe("NULL");
  });

  test("quotes unquoted column names with double quotes and string values with single quotes", () => {
    expect(compileSqlWhereExpression("department = Engineering", sqlColumns, "postgres")).toBe(
      "\"department\" = 'Engineering'",
    );
    expect(compileSqlWhereExpression("email = alice@example.com", sqlColumns, "postgres")).toBe(
      "\"Email\" = 'alice@example.com'",
    );
    expect(
      compileSqlWhereExpression(
        "externalid = 550e8400-e29b-41d4-a716-446655440000",
        sqlColumns,
        "postgres",
      ),
    ).toBe("\"ExternalId\" = '550e8400-e29b-41d4-a716-446655440000'");
    expect(
      compileSqlWhereExpression("createdat >= 2026-01-15T10:30:00Z", sqlColumns, "postgres"),
    ).toBe("\"CreatedAt\" >= '2026-01-15T10:30:00Z'");
    expect(compileSqlWhereExpression("DocumentCode = 00123", sqlColumns, "postgres")).toBe(
      "\"DocumentCode\" = '00123'",
    );
    expect(compileSqlWhereExpression("id = 42 AND order > 5", sqlColumns, "postgres")).toBe(
      '"id" = 42 AND "order" > 5',
    );
    expect(compileSqlWhereExpression("UpdatedAt > CreatedAt", sqlColumns, "postgres")).toBe(
      '"UpdatedAt" > "CreatedAt"',
    );
    expect(
      compileSqlWhereExpression("department IN (Engineering, Sales)", sqlColumns, "postgres"),
    ).toBe("\"department\" IN ('Engineering', 'Sales')");
    expect(
      compileSqlWhereExpression(
        "CreatedAt BETWEEN 2026-01-01 AND 2026-12-31",
        sqlColumns,
        "postgres",
      ),
    ).toBe("\"CreatedAt\" BETWEEN '2026-01-01' AND '2026-12-31'");
    expect(compileSqlWhereExpression("name LIKE A%", sqlColumns, "postgres")).toBe(
      "\"name\" LIKE 'A%'",
    );
    expect(compileSqlWhereExpression("department == Engineering", sqlColumns, "postgres")).toBe(
      "\"department\" = 'Engineering'",
    );
    expect(compileSqlWhereExpression("department != Sales", sqlColumns, "postgres")).toBe(
      "\"department\" <> 'Sales'",
    );
    expect(compileSqlWhereExpression("department IS NOT NULL", sqlColumns, "postgres")).toBe(
      '"department" IS NOT NULL',
    );
  });

  test("translates helper operators and booleans per SQL dialect and escapes LIKE wildcards", () => {
    expect(compileSqlWhereExpression("name CONTAINS 50%", sqlColumns, "postgres")).toBe(
      "\"name\" ILIKE '%50\\%%' ESCAPE '\\'",
    );
    expect(compileSqlWhereExpression("id STARTS WITH 42", sqlColumns, "postgres")).toBe(
      "CAST(\"id\" AS TEXT) ILIKE '42%'",
    );
    expect(compileSqlWhereExpression("name ENDS WITH '[a]'", sqlColumns, "sqlserver")).toBe(
      "LOWER([name]) LIKE '%\\[a]' ESCAPE '\\'",
    );
    expect(compileSqlWhereExpression("name ENDS WITH [First Name]", sqlColumns, "sqlserver")).toBe(
      "LOWER([name]) LIKE LOWER(CONCAT('%', [First Name]))",
    );
    expect(compileSqlWhereExpression("name ILIKE A%", sqlColumns, "oracle")).toBe(
      "LOWER(\"name\") LIKE LOWER('A%')",
    );
    expect(compileSqlWhereExpression("active = true", sqlColumns, "postgres")).toBe(
      '"active" = true',
    );
    expect(compileSqlWhereExpression("active = 1", sqlColumns, "postgres")).toBe('"active" = true');
    expect(compileSqlWhereExpression("active = true", sqlColumns, "sqlserver")).toBe(
      "[active] = 1",
    );
    expect(compileSqlWhereExpression("NOT active", sqlColumns, "sqlserver")).toBe("[active] = 0");
    expect(compileSqlWhereExpression("active", sqlColumns, "postgres")).toBe('"active"');
    expect(compileSqlWhereExpression("department = true", sqlColumns, "postgres")).toBe(
      "\"department\" = 'true'",
    );
  });

  test("preserves native SQL expressions and supports bare values in local filter evaluation", () => {
    expect(compileSqlWhereExpression("LOWER(\"name\") = 'alice'", sqlColumns, "postgres")).toBe(
      "LOWER(\"name\") = 'alice'",
    );
    expect(compileSqlWhereExpression("salary - 10 > 80", sqlColumns, "postgres")).toBe(
      "salary - 10 > 80",
    );
    expect(compileSqlWhereExpression("ROWNUM <= 10", sqlColumns, "oracle")).toBe("ROWNUM <= 10");

    const localRows: Cell[][] = [
      [
        1,
        "Engineering",
        "Alice",
        "120",
        true,
        "Alice",
        "alice@example.com",
        "00123",
        "550e8400-e29b-41d4-a716-446655440000",
        "2026-01-15",
        "2026-01-16",
        1,
      ],
      [
        2,
        "Sales",
        "Bob",
        "95",
        false,
        "Bob",
        "bob@example.com",
        "00456",
        "660e8400-e29b-41d4-a716-446655440001",
        "2025-12-01",
        "2025-12-02",
        2,
      ],
    ];
    const emailFilter = compileFilterExpression("email = alice@example.com", sqlColumns);
    expect(emailFilter.ok).toBe(true);
    if (emailFilter.ok && emailFilter.mode === "expression") {
      expect(localRows.filter((row) => emailFilter.predicate(row)).map((row) => row[0])).toEqual([
        1,
      ]);
    }

    const uuidFilter = compileFilterExpression(
      "externalid = 550e8400-e29b-41d4-a716-446655440000",
      sqlColumns,
    );
    expect(uuidFilter.ok).toBe(true);
    if (uuidFilter.ok && uuidFilter.mode === "expression") {
      expect(localRows.filter((row) => uuidFilter.predicate(row)).map((row) => row[0])).toEqual([
        1,
      ]);
    }

    const emailSuggestions = getFilterSuggestions("email = alice@", 14, sqlColumns, localRows);
    expect(emailSuggestions[0]?.insertText).toBe("'alice@example.com'");
    expect(applyFilterSuggestion("email = alice@", emailSuggestions[0]!)).toEqual({
      text: "email = 'alice@example.com'",
      cursor: 27,
    });
  });
});
