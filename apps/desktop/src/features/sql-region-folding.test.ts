import { PostgreSQL, sql } from "@codemirror/lang-sql";
import {
  codeFolding,
  foldable,
  foldedRanges,
  foldEffect,
  unfoldEffect,
} from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";

import { sqlRegionFolding } from "@/features/sql-region-folding";

const people = "SELECT full_name FROM strata_demo.people WHERE city = 'Bogotá';";
const types = "SELECT exact_value, labels FROM strata_demo.type_zoo WHERE id = 1;";

function editorState(doc: string) {
  return EditorState.create({
    doc,
    extensions: [sql({ dialect: PostgreSQL }), codeFolding(), sqlRegionFolding],
  });
}

function rangeAt(state: EditorState, lineNumber: number) {
  const { from, to } = state.doc.line(lineNumber);
  return foldable(state, from, to);
}

describe("SQL region folding", () => {
  it("collapses the queries and closing marker while preserving the header and SQL text", () => {
    const header = "-- #Region Consultas de Bogotá";
    const source = [header, people, types, "-- #End", people].join("\n");
    const state = editorState(source);
    const range = rangeAt(state, 1);
    if (!range) throw new Error("Expected a foldable SQL region");
    expect(range.from).toBe(header.length);
    expect(state.sliceDoc(range.from, range.to)).toBe(`\n${people}\n${types}\n-- #End`);
    expect(state.sliceDoc(range.to)).toBe(`\n${people}`);

    const folded = state.update({ effects: foldEffect.of(range) }).state;
    expect(foldedRanges(folded).size).toBe(1);
    expect(folded.doc.toString()).toBe(source);
    const unfolded = folded.update({ effects: unfoldEffect.of(range) }).state;
    expect(foldedRanges(unfolded).size).toBe(0);
    expect(unfolded.doc.toString()).toBe(source);
  });

  it("pairs nested and consecutive regions with their corresponding closing markers", () => {
    const state = editorState(
      [
        "-- #Region Strata demo",
        "  -- #region Personas",
        people,
        "  -- #end",
        types,
        "-- #End",
        "-- #Region Tipos",
        types,
        "-- #End",
      ].join("\r\n"),
    );
    for (const [start, end] of [
      [1, 6],
      [2, 4],
      [7, 9],
    ] as const) {
      expect(rangeAt(state, start)).toEqual({
        from: state.doc.line(start).to,
        to: state.doc.line(end).to,
      });
    }
  });

  it("updates the available ranges when a closing marker is added or renamed", () => {
    const state = editorState(["-- #End", "-- #Region Personas", people].join("\n"));
    expect(rangeAt(state, 1)).toBeNull();
    expect(rangeAt(state, 2)).toBeNull();

    const closed = state.update({ changes: { from: state.doc.length, insert: "\n-- #End" } }).state;
    expect(rangeAt(closed, 2)?.to).toBe(closed.doc.length);

    const renamed = closed.update({ changes: { from: closed.doc.length, insert: "ing" } }).state;
    expect(rangeAt(renamed, 2)).toBeNull();
  });
});
