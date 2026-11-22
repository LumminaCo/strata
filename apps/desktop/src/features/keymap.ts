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
  script: "Ctrl+Shift+Enter",
  stop: "Ctrl+.",
  newTab: "Ctrl+T",
  closeTab: "Ctrl+W",
  palette: "Ctrl+K",
  history: "Ctrl+H",
  explorer: "Ctrl+B",
};

type Actions = Record<keyof typeof shortcuts | "nextTab" | "previousTab", () => void>;

export function workspaceKeydown(event: KeyboardEvent, actions: Actions, browserMode: boolean) {
  const modifier = (event.ctrlKey || event.metaKey) && !event.altKey;
  const key = event.key.toLowerCase();
  let action: keyof Actions | undefined;
  if (modifier) {
    if (key === "enter") action = event.shiftKey ? "script" : "run";
    if (key === ".") action = "stop";
    if (key === "t") action = "newTab";
    if (key === "w") action = "closeTab";
    if (key === "k" || key === "p") action = "palette";
    if (key === "h") action = "history";
    if (key === "b") action = "explorer";
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
  if (!action) return false;
  event.preventDefault();
  actions[action]();
  return true;
}
