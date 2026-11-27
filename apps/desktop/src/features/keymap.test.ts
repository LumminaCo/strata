import { describe, expect, it, vi } from "vitest";

import { isBrowserShortcut, shortcuts, workspaceKeydown } from "@/features/keymap";

function key(shortcut: string, preventDefault = vi.fn(), extra?: Partial<KeyboardEvent>) {
  const parts = shortcut.split("+");
  return {
    key: parts.at(-1)!,
    ctrlKey: parts.includes("Ctrl"),
    metaKey: parts.includes("Cmd"),
    shiftKey: parts.includes("Shift"),
    altKey: parts.includes("Alt"),
    preventDefault,
    ...extra,
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
      activity: vi.fn(),
      explorer: vi.fn(),
      results: vi.fn(),
      navigate: vi.fn(),
      explain: vi.fn(),
      format: vi.fn(),
      openSql: vi.fn(),
      saveSql: vi.fn(),
      saveSqlAs: vi.fn(),
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

  it("maps Ctrl+S to saveSql and Ctrl+Shift+S to saveSqlAs", () => {
    for (const [shortcut, expected] of [
      ["Ctrl+s", "saveSql"],
      ["Cmd+s", "saveSql"],
      ["Ctrl+Shift+S", "saveSqlAs"],
      ["Cmd+Shift+S", "saveSqlAs"],
    ] as const) {
      const handlers = actions();
      const preventDefault = vi.fn();
      const event = key(shortcut, preventDefault);
      expect(workspaceKeydown(event, handlers, false), shortcut).toBe(true);
      expect(preventDefault).toHaveBeenCalledOnce();
      expect(handlers[expected]).toHaveBeenCalledOnce();
      const other = expected === "saveSql" ? "saveSqlAs" : "saveSql";
      expect(handlers[other]).not.toHaveBeenCalled();
    }
  });

  it("maps Ctrl+B to explorer and Ctrl+Alt+B to activity", () => {
    for (const [shortcut, expected, extra] of [
      ["Ctrl+b", "explorer", undefined],
      ["Cmd+b", "explorer", undefined],
      ["Ctrl+Alt+b", "activity", undefined],
      ["Cmd+Alt+b", "activity", undefined],
      ["Cmd+Alt+∫", "activity", { code: "KeyB" }],
    ] as const) {
      const handlers = actions();
      const preventDefault = vi.fn();
      const event = key(shortcut, preventDefault, extra);
      expect(workspaceKeydown(event, handlers, false), shortcut).toBe(true);
      expect(preventDefault).toHaveBeenCalledOnce();
      expect(handlers[expected]).toHaveBeenCalledOnce();
      const other = expected === "explorer" ? "activity" : "explorer";
      expect(handlers[other]).not.toHaveBeenCalled();
    }
  });

  it("maps Ctrl+J to results and leaves Ctrl+Shift+J alone", () => {
    for (const shortcut of ["Ctrl+j", "Cmd+j"]) {
      const handlers = actions();
      const preventDefault = vi.fn();
      expect(workspaceKeydown(key(shortcut, preventDefault), handlers, false), shortcut).toBe(true);
      expect(preventDefault).toHaveBeenCalledOnce();
      expect(handlers.results).toHaveBeenCalledOnce();
    }
    const handlers = actions();
    expect(workspaceKeydown(key("Ctrl+Shift+J"), handlers, false)).toBe(false);
    expect(handlers.results).not.toHaveBeenCalled();
  });
});
