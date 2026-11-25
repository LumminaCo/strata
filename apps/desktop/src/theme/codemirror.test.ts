import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { EditorSelection, EditorState } from "@codemirror/state";
import { expect, test } from "vite-plus/test";

import { setStatement, statementMarks } from "@/components/sql-editor";
import { editorThemeSpec } from "@/theme/codemirror";

function parseTokens(css: string, selector: ":root" | ":root.dark"): Record<string, string> {
  const escaped = selector.replace(".", "\\.");
  const block = css.match(new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\n\\}`))?.[1];
  if (!block) throw new Error(`Missing ${selector} block in tokens.css`);
  const tokens: Record<string, string> = {};
  for (const [, name, value] of block.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    if (name && value) tokens[name] = value.trim();
  }
  return tokens;
}

function isTranslucentHex(color: string | undefined): boolean {
  if (!color || !/^#[0-9a-f]{8}$/i.test(color)) return false;
  const alpha = parseInt(color.slice(7, 9), 16);
  return alpha > 0 && alpha < 0x40;
}

test("styles CodeMirror caret and focused/unfocused selection explicitly", () => {
  expect(editorThemeSpec[".cm-cursor, .cm-dropCursor"]).toEqual({
    borderLeft: "2px solid var(--editor-caret)",
    marginLeft: "-1px",
  });
  expect(editorThemeSpec[".cm-content"].caretColor).toBe("var(--editor-caret)");
  expect(
    editorThemeSpec["&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground"],
  ).toEqual({
    backgroundColor: "var(--editor-selection)",
  });
  expect(editorThemeSpec["& .cm-selectionBackground"]).toEqual({
    backgroundColor: "var(--editor-selection-inactive)",
  });
  expect(editorThemeSpec[".cm-activeLine"]).toEqual({
    backgroundColor: "var(--editor-active-line)",
  });
  expect(editorThemeSpec[".cm-statement"]).toEqual({
    backgroundColor: "var(--editor-statement)",
  });
});

test("keeps active line and statement tints translucent and distinct from selection in light and dark themes", () => {
  const css = readFileSync(resolve(import.meta.dirname, "../styles/tokens.css"), "utf8");
  const light = parseTokens(css, ":root");
  const dark = parseTokens(css, ":root.dark");

  expect(light["--editor-caret"]).toBe("var(--foreground)");
  expect(light["--editor-selection"]).toBe("var(--selection)");

  for (const theme of [light, dark]) {
    expect(isTranslucentHex(theme["--editor-active-line"])).toBe(true);
    expect(isTranslucentHex(theme["--editor-statement"])).toBe(true);
    expect(theme["--selection"]).not.toBe(theme["--accent"]);
    expect(theme["--selection"]).not.toBe(theme["--editor-active-line"]);
    expect(theme["--selection"]).not.toBe(theme["--editor-statement"]);
    expect(theme["--editor-selection-inactive"]).toBeTruthy();
    expect(theme["--editor-selection-inactive"]).not.toBe(theme["--selection"]);
  }
});

test("hides statement highlight while text is selected and restores it on cursor collapse", () => {
  let state = EditorState.create({
    doc: "SELECT id FROM users;",
    extensions: [statementMarks],
  });

  state = state.update({ effects: setStatement.of([0, 21]) }).state;
  expect(state.field(statementMarks).decorations.size).toBe(1);

  state = state.update({ selection: EditorSelection.range(7, 14) }).state;
  expect(state.field(statementMarks).decorations.size).toBe(0);

  state = state.update({ selection: EditorSelection.cursor(7) }).state;
  expect(state.field(statementMarks).decorations.size).toBe(1);

  state = state.update({ changes: { from: 21, insert: " " } }).state;
  expect(state.field(statementMarks).decorations.size).toBe(0);
});
