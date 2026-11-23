import { describe, expect, it } from "vitest";

import { isBrowserShortcut, shortcuts } from "@/features/keymap";

function key(shortcut: string) {
  const parts = shortcut.split("+");
  return {
    key: parts.at(-1)!,
    ctrlKey: parts.includes("Ctrl"),
    metaKey: parts.includes("Cmd"),
    shiftKey: parts.includes("Shift"),
    altKey: parts.includes("Alt"),
  } as KeyboardEvent;
}

describe("isBrowserShortcut", () => {
  it("catches reload and devtools shortcuts", () => {
    for (const shortcut of [
      "F5",
      "Shift+F5",
      "Ctrl+F5",
      "Ctrl+r",
      "Ctrl+Shift+R",
      "Cmd+r",
      "F12",
      "Ctrl+Shift+I",
      "Ctrl+Shift+J",
      "Ctrl+Shift+C",
      "Cmd+Shift+I",
    ]) {
      expect(isBrowserShortcut(key(shortcut)), shortcut).toBe(true);
    }
  });

  it("leaves app and editing shortcuts alone", () => {
    for (const shortcut of [
      ...Object.values(shortcuts),
      "Ctrl+c",
      "Ctrl+v",
      "Ctrl+x",
      "Ctrl+i",
      "r",
      "Shift+R",
    ]) {
      expect(isBrowserShortcut(key(shortcut)), shortcut).toBe(false);
    }
  });
});
