import type { Cell, ColumnMeta } from "@/ipc/bindings/protocol";

export interface SortRule {
  column: number;
  descending: boolean;
}

export interface ResultFilter {
  id: string;
  expression: string;
}

export type SuggestionKind = "column" | "operator" | "value" | "keyword";

export interface FilterSuggestion {
  label: string;
  insertText: string;
  kind: SuggestionKind;
  detail?: string;
  replaceStart: number;
  replaceEnd: number;
  cursorOffset?: number;
}

export type CompiledFilter =
  | { ok: true; mode: "empty" }
  | { ok: true; mode: "text"; needle: string; predicate: (row: Cell[]) => boolean }
  | { ok: true; mode: "expression"; predicate: (row: Cell[]) => boolean }
  | { ok: false; error: string };

const NUMERIC_KINDS = new Set(["int", "float", "decimal"]);
const INTEGER_PATTERN = /^[+-]?\d+$/;
const NUMBER_PATTERN = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const SIMPLE_IDENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_$]*$/;

const RESERVED_KEYWORDS = new Set([
  "AND",
  "OR",
  "NOT",
  "IS",
  "NULL",
  "TRUE",
  "FALSE",
  "LIKE",
  "ILIKE",
  "IN",
  "BETWEEN",
  "CONTAINS",
  "STARTS",
  "ENDS",
  "WITH",
]);

export function toggleColumnSort(
  sorts: readonly SortRule[],
  column: number,
  options?: { replace?: boolean },
): SortRule[] {
  const existingIndex = sorts.findIndex((rule) => rule.column === column);
  if (options?.replace) {
    if (sorts.length === 1 && existingIndex === 0) {
      const current = sorts[0];
      return current && !current.descending ? [{ column, descending: true }] : [];
    }
    return [{ column, descending: false }];
  }
  if (existingIndex === -1) {
    return [...sorts, { column, descending: false }];
  }
  const existing = sorts[existingIndex];
  if (!existing) return [...sorts];
  if (!existing.descending) {
    return sorts.map((rule, index) =>
      index === existingIndex ? { ...rule, descending: true } : rule,
    );
  }
  return sorts.filter((_, index) => index !== existingIndex);
}

export function setColumnSort(
  sorts: readonly SortRule[],
  column: number,
  descending: boolean,
  options?: { replace?: boolean },
): SortRule[] {
  if (options?.replace) {
    return [{ column, descending }];
  }
  const existingIndex = sorts.findIndex((rule) => rule.column === column);
  if (existingIndex === -1) {
    return [...sorts, { column, descending }];
  }
  return sorts.map((rule, index) => (index === existingIndex ? { column, descending } : rule));
}

export function removeColumnSort(sorts: readonly SortRule[], column: number): SortRule[] {
  const next = sorts.filter((rule) => rule.column !== column);
  return next.length === sorts.length ? [...sorts] : next;
}

export function moveSortRule(
  sorts: readonly SortRule[],
  column: number,
  delta: -1 | 1,
): SortRule[] {
  const index = sorts.findIndex((rule) => rule.column === column);
  if (index === -1) return [...sorts];
  const target = index + delta;
  if (target < 0 || target >= sorts.length) return [...sorts];
  const next = [...sorts];
  const [moved] = next.splice(index, 1);
  if (!moved) return [...sorts];
  next.splice(target, 0, moved);
  return next;
}

export function formatSortHeader(
  name: string,
  sorts: readonly SortRule[],
  columnIndex: number,
): string {
  const priority = sorts.findIndex((rule) => rule.column === columnIndex);
  if (priority === -1) return name;
  const rule = sorts[priority];
  if (!rule) return name;
  const arrow = rule.descending ? "↓" : "↑";
  return sorts.length > 1 ? `${name} ${arrow}${priority + 1}` : `${name} ${arrow}`;
}

export function formatColumnIdentifier(name: string): string {
  if (SIMPLE_IDENT_PATTERN.test(name) && !RESERVED_KEYWORDS.has(name.toUpperCase())) {
    return name;
  }
  return `"${name.replaceAll('"', '""')}"`;
}

export function formatFilterLiteral(value: Cell, kind?: string): string {
  if (value === null) return "NULL";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  if (kind && NUMERIC_KINDS.has(kind) && NUMBER_PATTERN.test(value.trim())) {
    return value.trim();
  }
  return `'${value.replaceAll("'", "''")}'`;
}

function parseExactInteger(value: Cell): bigint | null {
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return BigInt(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (INTEGER_PATTERN.test(trimmed)) {
      try {
        return BigInt(trimmed);
      } catch {
        return null;
      }
    }
  }
  return null;
}

function parseFiniteNumber(value: Cell): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed && NUMBER_PATTERN.test(trimmed)) {
      const parsed = Number(trimmed);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function parseBooleanValue(value: Cell): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const lower = value.trim().toLowerCase();
    if (lower === "true") return true;
    if (lower === "false") return false;
  }
  return null;
}

function compareNonNull(
  left: Exclude<Cell, null>,
  right: Exclude<Cell, null>,
  kind: string | undefined,
  collator: Intl.Collator,
): number {
  if (typeof left === "number" && typeof right === "number") {
    return left - right;
  }
  if (kind && NUMERIC_KINDS.has(kind)) {
    const leftInt = parseExactInteger(left);
    const rightInt = parseExactInteger(right);
    if (leftInt !== null && rightInt !== null) {
      return leftInt < rightInt ? -1 : leftInt > rightInt ? 1 : 0;
    }
    const leftNum = parseFiniteNumber(left);
    const rightNum = parseFiniteNumber(right);
    if (leftNum !== null && rightNum !== null) {
      return leftNum - rightNum;
    }
  }
  if (typeof left === "boolean" && typeof right === "boolean") {
    return Number(left) - Number(right);
  }
  return collator.compare(String(left), String(right));
}

export function compareRowsBySorts(
  rowA: readonly Cell[] | undefined,
  rowB: readonly Cell[] | undefined,
  sorts: readonly SortRule[],
  columns: readonly ColumnMeta[],
  collator: Intl.Collator,
): number {
  for (const rule of sorts) {
    const left = rowA?.[rule.column] ?? null;
    const right = rowB?.[rule.column] ?? null;
    if (left === null && right === null) continue;
    if (left === null) return 1;
    if (right === null) return -1;
    const cmp = compareNonNull(left, right, columns[rule.column]?.kind, collator);
    if (cmp !== 0) return rule.descending ? -cmp : cmp;
  }
  return 0;
}

// --- Lexer & Parser for SQL-style Result Filter Expressions ---

type TokenKind =
  | "ident"
  | "quoted_ident"
  | "string"
  | "number"
  | "operator"
  | "lparen"
  | "rparen"
  | "comma";

interface Token {
  kind: TokenKind;
  value: string;
  raw: string;
  start: number;
  end: number;
  unterminated?: boolean;
}

function tokenizeFilter(input: string): { tokens: Token[]; error?: string } {
  const tokens: Token[] = [];
  let i = 0;
  const len = input.length;

  while (i < len) {
    const ch = input[i]!;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === "(") {
      tokens.push({ kind: "lparen", value: "(", raw: "(", start: i, end: i + 1 });
      i++;
      continue;
    }
    if (ch === ")") {
      tokens.push({ kind: "rparen", value: ")", raw: ")", start: i, end: i + 1 });
      i++;
      continue;
    }
    if (ch === ",") {
      tokens.push({ kind: "comma", value: ",", raw: ",", start: i, end: i + 1 });
      i++;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`" || ch === "[") {
      const start = i;
      const close = ch === "[" ? "]" : ch;
      const isString = ch === "'";
      i++;
      let value = "";
      let closed = false;
      while (i < len) {
        const cur = input[i]!;
        if (cur === close) {
          if (input[i + 1] === close) {
            value += close;
            i += 2;
            continue;
          }
          closed = true;
          i++;
          break;
        }
        value += cur;
        i++;
      }
      tokens.push({
        kind: isString ? "string" : "quoted_ident",
        value,
        raw: input.slice(start, i),
        start,
        end: i,
        unterminated: !closed,
      });
      if (!closed) {
        return {
          tokens,
          error: isString ? "Unterminated string literal." : "Unterminated quoted identifier.",
        };
      }
      continue;
    }
    const two = input.slice(i, i + 2);
    if (two === "!=" || two === "<>" || two === "<=" || two === ">=" || two === "==") {
      tokens.push({ kind: "operator", value: two, raw: two, start: i, end: i + 2 });
      i += 2;
      continue;
    }
    if (ch === "=" || ch === "<" || ch === ">") {
      tokens.push({ kind: "operator", value: ch, raw: ch, start: i, end: i + 1 });
      i++;
      continue;
    }
    const prev = tokens.at(-1);
    const unaryMinusAllowed =
      !prev ||
      prev.kind === "operator" ||
      prev.kind === "lparen" ||
      prev.kind === "comma" ||
      (prev.kind === "ident" &&
        ["AND", "OR", "NOT", "BETWEEN", "IN", "LIKE", "ILIKE", "CONTAINS", "WITH"].includes(
          prev.value.toUpperCase(),
        ));
    if (
      (ch >= "0" && ch <= "9") ||
      (ch === "-" &&
        unaryMinusAllowed &&
        i + 1 < len &&
        input[i + 1]! >= "0" &&
        input[i + 1]! <= "9")
    ) {
      const start = i;
      if (ch === "-") i++;
      while (i < len && input[i]! >= "0" && input[i]! <= "9") i++;
      if (input[i] === "." && i + 1 < len && input[i + 1]! >= "0" && input[i + 1]! <= "9") {
        i++;
        while (i < len && input[i]! >= "0" && input[i]! <= "9") i++;
      }
      const raw = input.slice(start, i);
      tokens.push({ kind: "number", value: raw, raw, start, end: i });
      continue;
    }
    if (/[A-Za-z_\p{L}]/u.test(ch)) {
      const start = i;
      i++;
      while (i < len && /[A-Za-z0-9_$\p{L}\p{N}]/u.test(input[i]!)) i++;
      const raw = input.slice(start, i);
      tokens.push({ kind: "ident", value: raw, raw, start, end: i });
      continue;
    }
    return { tokens, error: `Unexpected character "${ch}".` };
  }

  return { tokens };
}

function resolveColumnIndex(columns: readonly ColumnMeta[], name: string): number {
  const exact = columns.findIndex((col) => col.name === name);
  if (exact !== -1) return exact;
  const lower = name.toLocaleLowerCase();
  return columns.findIndex((col) => col.name.toLocaleLowerCase() === lower);
}

function looksLikeExpression(tokens: readonly Token[]): boolean {
  for (const token of tokens) {
    if (
      token.kind === "operator" ||
      token.kind === "lparen" ||
      token.kind === "rparen" ||
      token.kind === "quoted_ident"
    ) {
      return true;
    }
    if (token.kind === "ident") {
      const upper = token.value.toUpperCase();
      if (
        upper === "IS" ||
        upper === "IN" ||
        upper === "LIKE" ||
        upper === "ILIKE" ||
        upper === "BETWEEN" ||
        upper === "CONTAINS" ||
        upper === "STARTS" ||
        upper === "ENDS"
      ) {
        return true;
      }
    }
  }
  return false;
}

type ValueOperand = { kind: "literal"; value: Cell } | { kind: "column"; columnIndex: number };

function compareValuesForFilter(
  left: Cell,
  right: Cell,
  columnKind: string | undefined,
): number | null {
  if (left === null || right === null) return null;
  if (typeof left === "boolean" || typeof right === "boolean" || columnKind === "bool") {
    const lb = parseBooleanValue(left);
    const rb = parseBooleanValue(right);
    if (lb !== null && rb !== null) return Number(lb) - Number(rb);
  }
  const leftInt = parseExactInteger(left);
  const rightInt = parseExactInteger(right);
  if (leftInt !== null && rightInt !== null) {
    return leftInt < rightInt ? -1 : leftInt > rightInt ? 1 : 0;
  }
  const leftNum = parseFiniteNumber(left);
  const rightNum = parseFiniteNumber(right);
  if (
    leftNum !== null &&
    rightNum !== null &&
    (typeof left === "number" ||
      typeof right === "number" ||
      (columnKind !== undefined && NUMERIC_KINDS.has(columnKind)))
  ) {
    return leftNum - rightNum;
  }
  const ls = String(left);
  const rs = String(right);
  return ls < rs ? -1 : ls > rs ? 1 : 0;
}

function compileLikePattern(pattern: string, caseInsensitive: boolean): RegExp {
  let regex = "^";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === "%") regex += ".*";
    else if (ch === "_") regex += ".";
    else regex += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  regex += "$";
  return new RegExp(regex, caseInsensitive ? "is" : "s");
}

function resolveOperand(operand: ValueOperand, row: readonly Cell[]): Cell {
  return operand.kind === "column" ? (row[operand.columnIndex] ?? null) : operand.value;
}

export function compileFilterExpression(
  input: string,
  columns: readonly ColumnMeta[],
): CompiledFilter {
  const trimmed = input.trim();
  if (!trimmed) return { ok: true, mode: "empty" };

  const lexed = tokenizeFilter(trimmed);
  if (!lexed.error && !looksLikeExpression(lexed.tokens)) {
    const needle = trimmed.toLocaleLowerCase();
    return {
      ok: true,
      mode: "text",
      needle,
      predicate: (row) =>
        row.some((cell) =>
          (cell === null ? "null" : String(cell).toLocaleLowerCase()).includes(needle),
        ),
    };
  }
  if (lexed.error) {
    // Allow plain text searches containing characters like `@`, `/`, `:`, `-`, `.` when there are no SQL operators.
    if (!looksLikeExpression(lexed.tokens) && !trimmed.includes("'") && !trimmed.includes('"')) {
      const needle = trimmed.toLocaleLowerCase();
      return {
        ok: true,
        mode: "text",
        needle,
        predicate: (row) =>
          row.some((cell) =>
            (cell === null ? "null" : String(cell).toLocaleLowerCase()).includes(needle),
          ),
      };
    }
    return { ok: false, error: lexed.error };
  }

  const tokens = lexed.tokens;
  let pos = 0;

  const peek = (offset = 0) => tokens[pos + offset];
  const isKeyword = (token: Token | undefined, word: string) =>
    token?.kind === "ident" && token.value.toUpperCase() === word;

  function parseValue(): ValueOperand {
    const token = peek();
    if (!token) throw new Error("Expected a value.");
    if (token.kind === "string") {
      pos++;
      return { kind: "literal", value: token.value };
    }
    if (token.kind === "number") {
      pos++;
      const numeric = Number(token.value);
      return {
        kind: "literal",
        value: Number.isSafeInteger(numeric) || token.value.includes(".") ? numeric : token.value,
      };
    }
    if (token.kind === "quoted_ident") {
      pos++;
      const columnIndex = resolveColumnIndex(columns, token.value);
      if (columnIndex === -1) throw new Error(`Unknown column "${token.value}".`);
      return { kind: "column", columnIndex };
    }
    if (token.kind === "ident") {
      pos++;
      const upper = token.value.toUpperCase();
      if (upper === "NULL") return { kind: "literal", value: null };
      if (upper === "TRUE") return { kind: "literal", value: true };
      if (upper === "FALSE") return { kind: "literal", value: false };
      const columnIndex = resolveColumnIndex(columns, token.value);
      if (columnIndex !== -1) return { kind: "column", columnIndex };
      return { kind: "literal", value: token.value };
    }
    throw new Error(`Expected a value near "${token.raw}".`);
  }

  function parsePredicate(): (row: Cell[]) => boolean {
    const colToken = peek();
    if (!colToken || (colToken.kind !== "ident" && colToken.kind !== "quoted_ident")) {
      throw new Error(
        colToken ? `Expected a column name near "${colToken.raw}".` : "Expected a column name.",
      );
    }
    pos++;
    const columnIndex = resolveColumnIndex(columns, colToken.value);
    if (columnIndex === -1) {
      throw new Error(`Unknown column "${colToken.value}".`);
    }
    const columnKind = columns[columnIndex]?.kind;

    const op = peek();
    if (!op) {
      throw new Error(`Expected an operator after "${colToken.value}".`);
    }

    // IS [NOT] NULL
    if (isKeyword(op, "IS")) {
      pos++;
      let negated = false;
      if (isKeyword(peek(), "NOT")) {
        negated = true;
        pos++;
      }
      if (!isKeyword(peek(), "NULL")) {
        throw new Error('Expected "NULL" after "IS".');
      }
      pos++;
      return (row) => {
        const isNull = (row[columnIndex] ?? null) === null;
        return negated ? !isNull : isNull;
      };
    }

    // Optional NOT prefix for IN / BETWEEN / LIKE / ILIKE / CONTAINS / STARTS WITH / ENDS WITH
    let negated = false;
    if (isKeyword(op, "NOT")) {
      negated = true;
      pos++;
    }
    const nextOp = peek();
    if (!nextOp) {
      throw new Error(`Expected an operator after "${colToken.value}".`);
    }

    if (isKeyword(nextOp, "IN")) {
      pos++;
      if (peek()?.kind !== "lparen") {
        throw new Error('Expected "(" after "IN".');
      }
      pos++;
      const items: ValueOperand[] = [];
      if (peek()?.kind === "rparen") {
        throw new Error("IN (...) requires at least one value.");
      }
      while (true) {
        items.push(parseValue());
        if (peek()?.kind === "comma") {
          pos++;
          continue;
        }
        if (peek()?.kind === "rparen") {
          pos++;
          break;
        }
        throw new Error('Expected "," or ")" in IN list.');
      }
      return (row) => {
        const cell = row[columnIndex] ?? null;
        if (cell === null) return false;
        const matched = items.some((item) => {
          const target = resolveOperand(item, row);
          if (target === null) return false;
          return compareValuesForFilter(cell, target, columnKind) === 0;
        });
        return negated ? !matched : matched;
      };
    }

    if (isKeyword(nextOp, "BETWEEN")) {
      pos++;
      const low = parseValue();
      if (!isKeyword(peek(), "AND")) {
        throw new Error('Expected "AND" in BETWEEN expression.');
      }
      pos++;
      const high = parseValue();
      return (row) => {
        const cell = row[columnIndex] ?? null;
        if (cell === null) return false;
        const lowVal = resolveOperand(low, row);
        const highVal = resolveOperand(high, row);
        const cmpLow = compareValuesForFilter(cell, lowVal, columnKind);
        const cmpHigh = compareValuesForFilter(cell, highVal, columnKind);
        if (cmpLow === null || cmpHigh === null) return false;
        const matched = cmpLow >= 0 && cmpHigh <= 0;
        return negated ? !matched : matched;
      };
    }

    if (isKeyword(nextOp, "LIKE") || isKeyword(nextOp, "ILIKE")) {
      const caseInsensitive = nextOp.value.toUpperCase() === "ILIKE";
      pos++;
      const rhs = parseValue();
      const staticRegex =
        rhs.kind === "literal" && rhs.value !== null
          ? compileLikePattern(String(rhs.value), caseInsensitive)
          : null;
      return (row) => {
        const cell = row[columnIndex] ?? null;
        if (cell === null) return false;
        const regex =
          staticRegex ??
          (() => {
            const val = resolveOperand(rhs, row);
            return val === null ? null : compileLikePattern(String(val), caseInsensitive);
          })();
        if (!regex) return false;
        const matched = regex.test(String(cell));
        return negated ? !matched : matched;
      };
    }

    if (isKeyword(nextOp, "CONTAINS")) {
      pos++;
      const rhs = parseValue();
      return (row) => {
        const cell = row[columnIndex] ?? null;
        const target = resolveOperand(rhs, row);
        if (cell === null || target === null) return false;
        const matched = String(cell)
          .toLocaleLowerCase()
          .includes(String(target).toLocaleLowerCase());
        return negated ? !matched : matched;
      };
    }

    if (isKeyword(nextOp, "STARTS") || isKeyword(nextOp, "ENDS")) {
      const starts = nextOp.value.toUpperCase() === "STARTS";
      pos++;
      if (!isKeyword(peek(), "WITH")) {
        throw new Error(`Expected "WITH" after "${nextOp.value.toUpperCase()}".`);
      }
      pos++;
      const rhs = parseValue();
      return (row) => {
        const cell = row[columnIndex] ?? null;
        const target = resolveOperand(rhs, row);
        if (cell === null || target === null) return false;
        const lhs = String(cell).toLocaleLowerCase();
        const needle = String(target).toLocaleLowerCase();
        const matched = starts ? lhs.startsWith(needle) : lhs.endsWith(needle);
        return negated ? !matched : matched;
      };
    }

    if (negated) {
      throw new Error(`Unexpected "NOT" before "${nextOp.raw}".`);
    }

    if (nextOp.kind === "operator") {
      const operator = nextOp.value;
      pos++;
      const rhs = parseValue();
      return (row) => {
        const cell = row[columnIndex] ?? null;
        const target = resolveOperand(rhs, row);
        const cmp = compareValuesForFilter(cell, target, columnKind);
        if (cmp === null) return false;
        switch (operator) {
          case "=":
          case "==":
            return cmp === 0;
          case "!=":
          case "<>":
            return cmp !== 0;
          case "<":
            return cmp < 0;
          case "<=":
            return cmp <= 0;
          case ">":
            return cmp > 0;
          case ">=":
            return cmp >= 0;
          default:
            return false;
        }
      };
    }

    throw new Error(`Unsupported operator "${nextOp.raw}".`);
  }

  function parsePrimary(): (row: Cell[]) => boolean {
    if (peek()?.kind === "lparen") {
      pos++;
      const inner = parseOr();
      if (peek()?.kind !== "rparen") {
        throw new Error('Expected closing ")".');
      }
      pos++;
      return inner;
    }
    return parsePredicate();
  }

  function parseNot(): (row: Cell[]) => boolean {
    if (isKeyword(peek(), "NOT")) {
      pos++;
      const operand = parseNot();
      return (row) => !operand(row);
    }
    return parsePrimary();
  }

  function parseAnd(): (row: Cell[]) => boolean {
    let left = parseNot();
    while (isKeyword(peek(), "AND")) {
      pos++;
      const right = parseNot();
      const prev = left;
      left = (row) => prev(row) && right(row);
    }
    return left;
  }

  function parseOr(): (row: Cell[]) => boolean {
    let left = parseAnd();
    while (isKeyword(peek(), "OR")) {
      pos++;
      const right = parseAnd();
      const prev = left;
      left = (row) => prev(row) || right(row);
    }
    return left;
  }

  try {
    const predicate = parseOr();
    const leftover = peek();
    if (leftover) {
      return { ok: false, error: `Unexpected token "${leftover.raw}".` };
    }
    return { ok: true, mode: "expression", predicate };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Invalid filter expression.",
    };
  }
}

export function computeRowIndices(
  rows: readonly Cell[][],
  columns: readonly ColumnMeta[],
  options: {
    filters?: readonly ResultFilter[];
    draftFilter?: string;
    sorts?: readonly SortRule[];
  },
): { indices: number[] | undefined; activeFilterCount: number } {
  const predicates: ((row: Cell[]) => boolean)[] = [];

  for (const item of options.filters ?? []) {
    const compiled = compileFilterExpression(item.expression, columns);
    if (compiled.ok && compiled.mode !== "empty") {
      predicates.push(compiled.predicate);
    }
  }

  if (options.draftFilter) {
    const compiled = compileFilterExpression(options.draftFilter, columns);
    if (compiled.ok && compiled.mode !== "empty") {
      predicates.push(compiled.predicate);
    }
  }

  const sorts = (options.sorts ?? []).filter(
    (rule) => rule.column >= 0 && rule.column < columns.length,
  );
  const activeFilterCount = predicates.length;

  if (predicates.length === 0 && sorts.length === 0) {
    return { indices: undefined, activeFilterCount: 0 };
  }

  const indices: number[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row) continue;
    if (predicates.every((predicate) => predicate(row))) {
      indices.push(i);
    }
  }

  if (sorts.length > 0) {
    const collator = new Intl.Collator(undefined, { numeric: true });
    indices.sort((a, b) => {
      const cmp = compareRowsBySorts(rows[a], rows[b], sorts, columns, collator);
      return cmp !== 0 ? cmp : a - b;
    });
  }

  return { indices, activeFilterCount };
}

// --- Context-Aware Autocomplete for Filter Expressions ---

interface DistinctValueEntry {
  value: Exclude<Cell, null>;
  count: number;
}

const MAX_SCAN_ROWS = 20_000;
const MAX_DISTINCT_VALUES = 80;

export function collectColumnValues(
  rows: readonly Cell[][],
  columnIndex: number,
  limit = MAX_DISTINCT_VALUES,
): DistinctValueEntry[] {
  const counts = new Map<string, DistinctValueEntry>();
  const scanLimit = Math.min(rows.length, MAX_SCAN_ROWS);
  for (let i = 0; i < scanLimit; i++) {
    const cell = rows[i]?.[columnIndex] ?? null;
    if (cell === null) continue;
    const key = `${typeof cell}:${String(cell)}`;
    const existing = counts.get(key);
    if (existing) {
      existing.count++;
    } else if (counts.size < limit * 3) {
      counts.set(key, { value: cell, count: 1 });
    }
  }
  return Array.from(counts.values())
    .sort((a, b) => b.count - a.count || String(a.value).localeCompare(String(b.value)))
    .slice(0, limit);
}

interface OperatorOption {
  label: string;
  insertText: string;
  detail: string;
  cursorOffset?: number;
  numericPriority?: boolean;
  textPriority?: boolean;
}

const OPERATOR_OPTIONS: OperatorOption[] = [
  { label: "=", insertText: "= ", detail: "equals" },
  { label: "!=", insertText: "!= ", detail: "not equals" },
  { label: ">", insertText: "> ", detail: "greater than", numericPriority: true },
  { label: ">=", insertText: ">= ", detail: "greater or equal", numericPriority: true },
  { label: "<", insertText: "< ", detail: "less than", numericPriority: true },
  { label: "<=", insertText: "<= ", detail: "less or equal", numericPriority: true },
  { label: "CONTAINS", insertText: "CONTAINS ", detail: "contains text", textPriority: true },
  { label: "ILIKE", insertText: "ILIKE ", detail: "case-insensitive pattern", textPriority: true },
  { label: "LIKE", insertText: "LIKE ", detail: "SQL pattern", textPriority: true },
  { label: "STARTS WITH", insertText: "STARTS WITH ", detail: "prefix match", textPriority: true },
  { label: "ENDS WITH", insertText: "ENDS WITH ", detail: "suffix match", textPriority: true },
  { label: "IN (...)", insertText: "IN ()", detail: "in list", cursorOffset: -1 },
  { label: "NOT IN (...)", insertText: "NOT IN ()", detail: "not in list", cursorOffset: -1 },
  { label: "BETWEEN", insertText: "BETWEEN ", detail: "inclusive range", numericPriority: true },
  { label: "IS NULL", insertText: "IS NULL", detail: "is null" },
  { label: "IS NOT NULL", insertText: "IS NOT NULL", detail: "is not null" },
];

function rankMatch(label: string, query: string): number | null {
  if (!query) return 0;
  const lowerLabel = label.toLocaleLowerCase();
  const lowerQuery = query.toLocaleLowerCase();
  if (lowerLabel === lowerQuery) return 0;
  if (lowerLabel.startsWith(lowerQuery)) return 1;
  if (lowerLabel.includes(lowerQuery)) return 2;
  return null;
}

function findLastColumnIndex(tokens: readonly Token[], columns: readonly ColumnMeta[]): number {
  for (let i = tokens.length - 1; i >= 0; i--) {
    const token = tokens[i];
    if (!token) continue;
    if (token.kind === "ident" || token.kind === "quoted_ident") {
      if (token.kind === "ident" && RESERVED_KEYWORDS.has(token.value.toUpperCase())) continue;
      const idx = resolveColumnIndex(columns, token.value);
      if (idx !== -1) return idx;
    }
  }
  return -1;
}

type AutocompleteContext =
  | { kind: "none" }
  | { kind: "column"; query: string; replaceStart: number }
  | { kind: "operator"; columnIndex: number; query: string; replaceStart: number }
  | { kind: "value"; columnIndex: number; query: string; replaceStart: number; insideIn: boolean }
  | { kind: "combinator"; query: string; replaceStart: number };

function detectAutocompleteContext(
  input: string,
  cursor: number,
  columns: readonly ColumnMeta[],
): AutocompleteContext {
  const before = input.slice(0, cursor);
  const { tokens } = tokenizeFilter(before);
  const trailingSpace = /\s$/.test(before);

  if (tokens.length === 0) {
    return { kind: "column", query: "", replaceStart: cursor };
  }

  // Split into completed tokens before the current fragment and the active fragment (if any).
  let prevTokens = tokens;
  let active: Token | undefined;
  if (!trailingSpace) {
    const last = tokens.at(-1);
    if (
      last &&
      last.end === cursor &&
      last.kind !== "lparen" &&
      last.kind !== "rparen" &&
      last.kind !== "comma"
    ) {
      if (last.kind === "string" && !last.unterminated) {
        return { kind: "none" };
      }
      active = last;
      prevTokens = tokens.slice(0, -1);
    }
  }

  const replaceStart = active ? active.start : cursor;
  const query = active ? (active.kind === "string" ? active.value : active.raw) : "";
  const prev = prevTokens.at(-1);
  const prev2 = prevTokens.at(-2);
  const upperPrev = prev?.kind === "ident" ? prev.value.toUpperCase() : "";
  const upperPrev2 = prev2?.kind === "ident" ? prev2.value.toUpperCase() : "";

  // Check if we're inside an IN (...) value list.
  let openParenIndex = -1;
  let depth = 0;
  for (let i = prevTokens.length - 1; i >= 0; i--) {
    const t = prevTokens[i]!;
    if (t.kind === "rparen") depth++;
    else if (t.kind === "lparen") {
      if (depth === 0) {
        openParenIndex = i;
        break;
      }
      depth--;
    }
  }
  const insideIn =
    openParenIndex > 0 &&
    prevTokens[openParenIndex - 1]?.kind === "ident" &&
    prevTokens[openParenIndex - 1]?.value.toUpperCase() === "IN";

  if (insideIn) {
    if (prev?.kind === "lparen" || prev?.kind === "comma") {
      const colIdx = findLastColumnIndex(prevTokens.slice(0, openParenIndex), columns);
      return {
        kind: "value",
        columnIndex: colIdx,
        query: active?.kind === "string" ? active.value : (active?.value ?? ""),
        replaceStart,
        insideIn: true,
      };
    }
  }

  // At start of expression or right after AND / OR / NOT / (
  if (!prev || prev.kind === "lparen" || upperPrev === "OR") {
    return { kind: "column", query, replaceStart };
  }

  if (upperPrev === "AND") {
    // Distinguish `col BETWEEN low AND <high>` from `<pred> AND <col>`
    if (
      prevTokens.length >= 3 &&
      prevTokens[prevTokens.length - 3]?.kind === "ident" &&
      prevTokens[prevTokens.length - 3]?.value.toUpperCase() === "BETWEEN"
    ) {
      const colIdx = findLastColumnIndex(prevTokens.slice(0, -3), columns);
      return {
        kind: "value",
        columnIndex: colIdx,
        query: active?.kind === "string" ? active.value : (active?.value ?? ""),
        replaceStart,
        insideIn: false,
      };
    }
    return { kind: "column", query, replaceStart };
  }

  // After `col NOT ` -> operator (NOT IN, NOT LIKE, NOT ILIKE, NOT CONTAINS, NOT BETWEEN)
  if (upperPrev === "NOT") {
    if (prev2 && (prev2.kind === "ident" || prev2.kind === "quoted_ident")) {
      const colIdx = resolveColumnIndex(columns, prev2.value);
      if (colIdx !== -1) {
        return {
          kind: "operator",
          columnIndex: colIdx,
          query: `NOT ${query}`.trim(),
          replaceStart: prev.start,
        };
      }
    }
    if (upperPrev2 === "IS") {
      const colIdx = findLastColumnIndex(prevTokens.slice(0, -2), columns);
      return {
        kind: "operator",
        columnIndex: colIdx,
        query: `IS NOT ${query}`.trim(),
        replaceStart: prev2!.start,
      };
    }
    return { kind: "column", query, replaceStart };
  }

  // After `col IS ` -> IS NULL / IS NOT NULL
  if (upperPrev === "IS") {
    const colIdx = findLastColumnIndex(prevTokens.slice(0, -1), columns);
    return {
      kind: "operator",
      columnIndex: colIdx,
      query: `IS ${query}`.trim(),
      replaceStart: prev.start,
    };
  }

  // After `col STARTS ` / `col ENDS `
  if (upperPrev === "STARTS" || upperPrev === "ENDS") {
    const colIdx = findLastColumnIndex(prevTokens.slice(0, -1), columns);
    return {
      kind: "operator",
      columnIndex: colIdx,
      query: `${upperPrev} ${query}`.trim(),
      replaceStart: prev.start,
    };
  }

  // After value-expecting operator: `=`, `!=`, `<`, `>`, `<=`, `>=`, `LIKE`, `ILIKE`, `CONTAINS`, `BETWEEN`, `WITH`
  if (
    prev.kind === "operator" ||
    upperPrev === "LIKE" ||
    upperPrev === "ILIKE" ||
    upperPrev === "CONTAINS" ||
    upperPrev === "BETWEEN" ||
    upperPrev === "WITH"
  ) {
    const colIdx = findLastColumnIndex(prevTokens.slice(0, -1), columns);
    return {
      kind: "value",
      columnIndex: colIdx,
      query: active?.kind === "string" ? active.value : (active?.value ?? ""),
      replaceStart,
      insideIn: false,
    };
  }

  // After a column name (and NOT after a value-expecting operator): expect an operator!
  if (prev.kind === "ident" || prev.kind === "quoted_ident") {
    const colIdx = resolveColumnIndex(columns, prev.value);
    const prevWasPredicateStart =
      !prev2 ||
      prev2.kind === "lparen" ||
      upperPrev2 === "AND" ||
      upperPrev2 === "OR" ||
      upperPrev2 === "NOT";
    if (colIdx !== -1 && prevWasPredicateStart) {
      return { kind: "operator", columnIndex: colIdx, query, replaceStart };
    }
  }

  // Otherwise we just finished a value, `NULL`, or `)` -> suggest AND / OR
  return { kind: "combinator", query, replaceStart };
}

export function getFilterSuggestions(
  input: string,
  cursor: number,
  columns: readonly ColumnMeta[],
  rows: readonly Cell[][],
  valueCache?: Map<number, DistinctValueEntry[]>,
): FilterSuggestion[] {
  if (columns.length === 0) return [];

  const ctx = detectAutocompleteContext(input, cursor, columns);
  if (ctx.kind === "none") return [];

  const currentSlice = input.slice(ctx.replaceStart, cursor);
  const keepUseful = (items: FilterSuggestion[]) =>
    items.filter(
      (item) =>
        !(
          item.replaceStart === ctx.replaceStart &&
          item.replaceEnd === cursor &&
          item.insertText === currentSlice
        ),
    );

  if (ctx.kind === "column") {
    const matches: { rank: number; suggestion: FilterSuggestion }[] = [];
    for (const column of columns) {
      const rank = rankMatch(column.name, ctx.query);
      if (rank === null) continue;
      matches.push({
        rank,
        suggestion: {
          label: column.name,
          insertText: `${formatColumnIdentifier(column.name)} `,
          kind: "column",
          detail: column.db_type,
          replaceStart: ctx.replaceStart,
          replaceEnd: cursor,
        },
      });
    }
    const notRank = rankMatch("NOT", ctx.query);
    if (notRank !== null && ctx.query.length > 0) {
      matches.push({
        rank: notRank + 3,
        suggestion: {
          label: "NOT",
          insertText: "NOT ",
          kind: "keyword",
          detail: "negate condition",
          replaceStart: ctx.replaceStart,
          replaceEnd: cursor,
        },
      });
    }
    return matches
      .sort((a, b) => a.rank - b.rank)
      .slice(0, 30)
      .map((entry) => entry.suggestion);
  }

  if (ctx.kind === "operator") {
    const colKind = columns[ctx.columnIndex]?.kind ?? "";
    const isNumeric = NUMERIC_KINDS.has(colKind);
    const matches: { rank: number; priority: number; suggestion: FilterSuggestion }[] = [];
    for (let i = 0; i < OPERATOR_OPTIONS.length; i++) {
      const op = OPERATOR_OPTIONS[i]!;
      const rank = rankMatch(op.label, ctx.query);
      if (rank === null) continue;
      let priority = i;
      if (isNumeric && op.textPriority) priority += 20;
      if (!isNumeric && op.numericPriority) priority += 10;
      matches.push({
        rank,
        priority,
        suggestion: {
          label: op.label,
          insertText: op.insertText,
          kind: "operator",
          detail: op.detail,
          replaceStart: ctx.replaceStart,
          replaceEnd: cursor,
          cursorOffset: op.cursorOffset,
        },
      });
    }
    return matches
      .sort((a, b) => a.rank - b.rank || a.priority - b.priority)
      .slice(0, 16)
      .map((entry) => entry.suggestion);
  }

  if (ctx.kind === "value") {
    const col = ctx.columnIndex >= 0 ? columns[ctx.columnIndex] : undefined;
    const matches: { rank: number; suggestion: FilterSuggestion }[] = [];
    const cleanQuery = ctx.query.replace(/^%+/, "").replace(/%+$/, "");

    if (ctx.columnIndex >= 0) {
      let distinct = valueCache?.get(ctx.columnIndex);
      if (!distinct) {
        distinct = collectColumnValues(rows, ctx.columnIndex);
        valueCache?.set(ctx.columnIndex, distinct);
      }
      for (const entry of distinct) {
        const display = String(entry.value);
        const rank = rankMatch(display, cleanQuery);
        if (rank === null) continue;
        matches.push({
          rank,
          suggestion: {
            label: display,
            insertText: formatFilterLiteral(entry.value, col?.kind),
            kind: "value",
            detail: entry.count === 1 ? "1 row" : `${entry.count} rows`,
            replaceStart: ctx.replaceStart,
            replaceEnd: cursor,
          },
        });
      }
    }

    if (col?.kind === "bool") {
      for (const boolLiteral of ["true", "false"]) {
        const rank = rankMatch(boolLiteral, cleanQuery);
        if (
          rank !== null &&
          !matches.some((item) => item.suggestion.insertText.toLowerCase() === boolLiteral)
        ) {
          matches.push({
            rank,
            suggestion: {
              label: boolLiteral,
              insertText: boolLiteral,
              kind: "keyword",
              detail: "boolean",
              replaceStart: ctx.replaceStart,
              replaceEnd: cursor,
            },
          });
        }
      }
    }

    // Suggest other columns for column-to-column comparisons (e.g., updated_at > created_at)
    if (!ctx.insideIn && cleanQuery.length > 0) {
      for (let i = 0; i < columns.length; i++) {
        if (i === ctx.columnIndex) continue;
        const other = columns[i]!;
        const rank = rankMatch(other.name, cleanQuery);
        if (rank === null) continue;
        matches.push({
          rank: rank + 3,
          suggestion: {
            label: other.name,
            insertText: formatColumnIdentifier(other.name),
            kind: "column",
            detail: other.db_type,
            replaceStart: ctx.replaceStart,
            replaceEnd: cursor,
          },
        });
      }
    }

    return keepUseful(
      matches
        .sort((a, b) => a.rank - b.rank)
        .slice(0, 24)
        .map((entry) => entry.suggestion),
    );
  }

  // Combinators: AND, OR
  const combinators = [
    { label: "AND", insertText: "AND ", detail: "both conditions match" },
    { label: "OR", insertText: "OR ", detail: "either condition matches" },
  ];
  const matches: { rank: number; suggestion: FilterSuggestion }[] = [];
  for (const item of combinators) {
    const rank = rankMatch(item.label, ctx.query);
    if (rank === null) continue;
    matches.push({
      rank,
      suggestion: {
        label: item.label,
        insertText: item.insertText,
        kind: "keyword",
        detail: item.detail,
        replaceStart: ctx.replaceStart,
        replaceEnd: cursor,
      },
    });
  }
  return matches.sort((a, b) => a.rank - b.rank).map((entry) => entry.suggestion);
}

export function applyFilterSuggestion(
  input: string,
  suggestion: FilterSuggestion,
): { text: string; cursor: number } {
  const before = input.slice(0, suggestion.replaceStart);
  const after = input.slice(suggestion.replaceEnd);
  const text = `${before}${suggestion.insertText}${after}`;
  const cursor =
    suggestion.replaceStart + suggestion.insertText.length + (suggestion.cursorOffset ?? 0);
  return { text, cursor };
}
