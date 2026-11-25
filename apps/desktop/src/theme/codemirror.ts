import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { EditorView } from "@codemirror/view";

export const editorThemeSpec = {
  "&": { height: "100%", color: "var(--foreground)", background: "var(--background)" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    fontFamily: "var(--editor-font)",
    fontSize: "var(--editor-font-size, var(--font-size-ui))",
    lineHeight: "var(--leading-editor)",
  },
  ".cm-content": { paddingBlock: "10px", caretColor: "var(--editor-caret)" },
  ".cm-cursor, .cm-dropCursor": {
    borderLeft: "2px solid var(--editor-caret)",
    marginLeft: "-1px",
  },
  ".cm-line": { paddingInline: "10px" },
  ".cm-gutters": {
    background: "var(--surface)",
    color: "var(--muted-foreground)",
    borderColor: "var(--border)",
  },
  ".cm-lineNumbers .cm-gutterElement": { paddingInline: "10px 6px" },
  ".cm-activeLine": { backgroundColor: "var(--editor-active-line)" },
  ".cm-activeLineGutter": {
    backgroundColor: "var(--editor-active-line)",
    color: "var(--foreground)",
  },
  ".cm-statement": { backgroundColor: "var(--editor-statement)" },
  "& .cm-selectionBackground": {
    backgroundColor: "var(--editor-selection-inactive)",
  },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground": {
    backgroundColor: "var(--editor-selection)",
  },
  ".cm-content ::selection": {
    backgroundColor: "var(--editor-selection)",
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
  "&.cm-editor .cm-tooltip": {
    backgroundColor: "var(--popover)",
    color: "var(--popover-foreground)",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius)",
    boxShadow: "var(--elevation-popover)",
  },
  "&.cm-editor .cm-tooltip-section:not(:first-child)": {
    borderTop: "1px solid var(--border)",
  },
  "&.cm-editor .cm-tooltip .cm-tooltip-arrow:before": {
    borderTopColor: "var(--border)",
    borderBottomColor: "var(--border)",
  },
  "&.cm-editor .cm-tooltip .cm-tooltip-arrow:after": {
    borderTopColor: "var(--popover)",
    borderBottomColor: "var(--popover)",
  },
  "&.cm-editor .cm-tooltip.cm-tooltip-autocomplete > ul": {
    fontFamily: "var(--editor-font)",
    fontSize: "var(--font-size-label)",
    padding: "4px",
    maxHeight: "14em",
  },
  "&.cm-editor .cm-tooltip.cm-tooltip-autocomplete > ul > li": {
    padding: "3px 8px",
    borderRadius: "calc(var(--radius) * 0.6)",
    color: "var(--popover-foreground)",
    lineHeight: "1.45",
  },
  "&.cm-editor .cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]": {
    background: "var(--accent)",
    color: "var(--accent-foreground)",
  },
  "&.cm-editor .cm-tooltip.cm-tooltip-autocomplete-disabled > ul > li[aria-selected]": {
    background: "var(--muted)",
    color: "var(--muted-foreground)",
  },
  "&.cm-editor .cm-tooltip.cm-tooltip-autocomplete > ul > completion-section": {
    color: "var(--muted-foreground)",
    borderBottom: "1px solid var(--border)",
    padding: "3px 8px",
  },
  "&.cm-editor .cm-completionMatchedText": {
    textDecoration: "none",
    fontWeight: "600",
    color: "var(--workspace-accent)",
  },
  "&.cm-editor .cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected] .cm-completionMatchedText":
    {
      color: "var(--accent-foreground)",
    },
  "&.cm-editor .cm-completionDetail": {
    color: "var(--muted-foreground)",
    fontStyle: "normal",
    marginLeft: "0.75em",
  },
  "&.cm-editor .cm-completionIcon": {
    color: "var(--muted-foreground)",
    opacity: "0.85",
  },
  "&.cm-editor .cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected] .cm-completionDetail, &.cm-editor .cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected] .cm-completionIcon":
    {
      color: "var(--accent-foreground)",
      opacity: "0.85",
    },
  "&.cm-editor .cm-tooltip.cm-completionInfo": {
    backgroundColor: "var(--popover)",
    color: "var(--popover-foreground)",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius)",
    boxShadow: "var(--elevation-popover)",
  },
} as const;

export const editorTheme = [
  EditorView.theme(editorThemeSpec),
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
