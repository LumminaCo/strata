import { describe, expect, it, vi } from "vitest";

import { isBrowserShortcut, shortcuts, workspaceKeydown } from "@/features/keymap";

function key(shortcut: string, preventDefault = vi.fn()) {
  const parts = shortcut.split("+");
  return {
    key: parts.at(-1)!,
    ctrlKey: parts.includes("Ctrl"),
    metaKey: parts.includes("Cmd"),
    shiftKey: parts.includes("Shift"),
    altKey: parts.includes("Alt"),
    preventDefault,
  } as unknown as KeyboardEvent;
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

describe("workspaceKeydown", () => {
  function actions() {
    return {
      run: vi.fn(),
      runInNewTab: vi.fn(),
      script: vi.fn(),
      stop: vi.fn(),
      newTab: vi.fn(),
      closeTab: vi.fn(),
      nextTab: vi.fn(),
      previousTab: vi.fn(),
      palette: vi.fn(),
      history: vi.fn(),
      explorer: vi.fn(),
      navigate: vi.fn(),
      explain: vi.fn(),
      format: vi.fn(),
      openSql: vi.fn(),
      saveSql: vi.fn(),
    };
  }

  it("maps Ctrl+Enter to run, Ctrl+Shift+Enter to runInNewTab, and Alt+X to script", () => {
    for (const [shortcut, expected] of [
      ["Ctrl+Enter", "run"],
      ["Cmd+Enter", "run"],
      ["Ctrl+Shift+Enter", "runInNewTab"],
      ["Cmd+Shift+Enter", "runInNewTab"],
      ["Alt+x", "script"],
    ] as const) {
      const handlers = actions();
      const preventDefault = vi.fn();
      const event = key(shortcut, preventDefault);
      expect(workspaceKeydown(event, handlers, false), shortcut).toBe(true);
      expect(preventDefault).toHaveBeenCalledOnce();
      expect(handlers[expected]).toHaveBeenCalledOnce();
    }
  });
});
