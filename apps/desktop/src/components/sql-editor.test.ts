import { describe, expect, it } from "vitest";

import { navigationClickFull } from "@/components/sql-editor";
import { resolveNavigationTarget } from "@/features/table-inspector";
import type { ObjectKind } from "@/ipc/bindings/protocol";

function clickEvent(
  overrides: Partial<
    Pick<MouseEvent, "button" | "altKey" | "ctrlKey" | "metaKey" | "shiftKey">
  > = {},
) {
  return {
    button: 0,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    ...overrides,
  };
}

describe("navigationClickFull", () => {
  it("opens in the upper Schema tab on Ctrl+Click or Cmd+Click", () => {
    expect(navigationClickFull(clickEvent({ ctrlKey: true }))).toBe(true);
    expect(navigationClickFull(clickEvent({ metaKey: true }))).toBe(true);
  });

  it("opens pinned in the lower panel on Ctrl+Shift+Click or Cmd+Shift+Click", () => {
    expect(navigationClickFull(clickEvent({ ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(navigationClickFull(clickEvent({ metaKey: true, shiftKey: true }))).toBe(false);
  });

  it("ignores non-primary clicks, plain clicks, and Alt-modified clicks", () => {
    expect(navigationClickFull(clickEvent())).toBeNull();
    expect(navigationClickFull(clickEvent({ shiftKey: true }))).toBeNull();
    expect(navigationClickFull(clickEvent({ ctrlKey: true, button: 1 }))).toBeNull();
    expect(navigationClickFull(clickEvent({ ctrlKey: true, button: 2 }))).toBeNull();
    expect(navigationClickFull(clickEvent({ ctrlKey: true, altKey: true }))).toBeNull();
    expect(navigationClickFull(clickEvent({ metaKey: true, altKey: true }))).toBeNull();
  });
});

describe("resolveNavigationTarget", () => {
  it("opens tables and other relations in the upper tab on Ctrl+Click", () => {
    const relations: ObjectKind[] = ["table", "view", "materialized_view", "foreign_table"];
    for (const kind of relations) {
      expect(resolveNavigationTarget(kind, true)).toBe("tab");
    }
  });

  it("pins tables and other relations in the lower panel on Ctrl+Shift+Click", () => {
    const relations: ObjectKind[] = ["table", "view", "materialized_view", "foreign_table"];
    for (const kind of relations) {
      expect(resolveNavigationTarget(kind, false)).toBe("pinned");
    }
  });

  it("always opens functions and procedures in the upper tab", () => {
    const routines: ObjectKind[] = ["function", "procedure"];
    for (const kind of routines) {
      expect(resolveNavigationTarget(kind, true)).toBe("tab");
      expect(resolveNavigationTarget(kind, false)).toBe("tab");
    }
  });
});
