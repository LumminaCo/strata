import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { EditorView } from "@codemirror/view";

export const editorTheme = [
  EditorView.theme({
    "&": { height: "100%", color: "var(--foreground)", background: "var(--background)" },
    "&.cm-focused": { outline: "none" },
    ".cm-scroller": {
      fontFamily: "var(--editor-font)",
      fontSize: "var(--editor-font-size, var(--font-size-ui))",
      lineHeight: "var(--leading-editor)",
    },
    ".cm-content": { paddingBlock: "10px", caretColor: "var(--workspace-accent)" },
    ".cm-line": { paddingInline: "10px" },
    ".cm-gutters": {
      background: "var(--surface)",
      color: "var(--muted-foreground)",
      borderColor: "var(--border)",
    },
    ".cm-lineNumbers .cm-gutterElement": { paddingInline: "10px 6px" },
    ".cm-activeLine, .cm-activeLineGutter": { background: "var(--editor-active-line)" },
    ".cm-statement": { background: "var(--editor-statement)" },
    "& .cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
      background: "var(--editor-selection)",
    },
    ".cm-panels": {
      background: "var(--surface)",
      color: "var(--foreground)",
      borderColor: "var(--border)",
    },
    ".cm-panel input, .cm-panel button": {
      color: "var(--foreground)",
      background: "var(--background)",
      borderColor: "var(--border)",
    },
    ".cm-diagnostic-error": { borderColor: "var(--destructive)" },
  }),
  syntaxHighlighting(
    HighlightStyle.define([
      { tag: [tags.keyword, tags.operatorKeyword, tags.typeName], color: "var(--syntax-keyword)" },
      { tag: tags.string, color: "var(--syntax-string)" },
      { tag: [tags.number, tags.bool, tags.null], color: "var(--syntax-number)" },
      { tag: tags.comment, color: "var(--syntax-comment)", fontStyle: "italic" },
      { tag: tags.name, color: "var(--syntax-identifier)" },
      { tag: tags.function(tags.variableName), color: "var(--syntax-function)" },
    ]),
  ),
];
