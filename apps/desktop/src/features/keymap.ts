import { completionKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, historyKeymap } from "@codemirror/commands";
import { foldKeymap } from "@codemirror/language";
import { searchKeymap } from "@codemirror/search";
import { keymap } from "@codemirror/view";

export const editorKeys = keymap.of([
  ...completionKeymap,
  ...defaultKeymap,
  ...historyKeymap,
  ...searchKeymap,
  ...foldKeymap,
]);

export const shortcuts = {
  run: "Ctrl+Enter",
  runInNewTab: "Ctrl+Shift+Enter",
  script: "Alt+X",
  stop: "Ctrl+.",
  newTab: "Ctrl+T",
  closeTab: "Ctrl+W",
  palette: "Ctrl+K",
  activity: "Ctrl+Alt+B",
  explorer: "Ctrl+B",
  navigate: "F4",
  explain: "Ctrl+Shift+E",
  format: "Ctrl+Shift+F",
  openSql: "Ctrl+O",
  saveSql: "Ctrl+S",
  saveSqlAs: "Ctrl+Shift+S",
};

// Webview shortcuts that reload the app or open devtools; blocked in production builds.
export function isBrowserShortcut(event: KeyboardEvent) {
  const key = event.key.toLowerCase();
  const modifier = event.ctrlKey || event.metaKey;
  return (
    key === "f5" ||
    key === "f12" ||
    (modifier && key === "r") ||
    (modifier && event.shiftKey && (key === "i" || key === "j" || key === "c"))
  );
}

type Actions = Record<keyof typeof shortcuts | "nextTab" | "previousTab", () => void>;

export function workspaceKeydown(event: KeyboardEvent, actions: Actions, browserMode: boolean) {
  const primary = event.ctrlKey || event.metaKey;
  const modifier = primary && !event.altKey;
  const key = event.key.toLowerCase();
  const isKeyB = key === "b" || event.code === "KeyB";
  let action: keyof Actions | undefined;
  if (primary && event.altKey && !event.shiftKey && isKeyB) {
    action = "activity";
  } else if (modifier) {
    if (key === "enter") action = event.shiftKey ? "runInNewTab" : "run";
    if (key === ".") action = "stop";
    if (event.shiftKey && key === "e") action = "explain";
    if (event.shiftKey && key === "f") action = "format";
    if (key === "t") action = "newTab";
    if (key === "o") action = "openSql";
    if (key === "s") action = event.shiftKey ? "saveSqlAs" : "saveSql";
    if (key === "w") action = "closeTab";
    if (key === "k" || key === "p") action = "palette";
    if (!event.shiftKey && isKeyB) action = "explorer";
    if (key === "tab") action = event.shiftKey ? "previousTab" : "nextTab";
  }
  if (event.altKey && !event.ctrlKey && !event.metaKey) {
    if (key === "x") action = "script";
    if (browserMode) {
      if (key === "t") action = "newTab";
      if (key === "w") action = "closeTab";
      if (key === "]") action = "nextTab";
      if (key === "[") action = "previousTab";
    }
  }
  if (key === "f4") action = "navigate";
  if (!action) return false;
  event.preventDefault();
  actions[action]();
  return true;
}
