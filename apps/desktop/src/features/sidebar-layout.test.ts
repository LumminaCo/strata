import { describe, expect, it } from "vite-plus/test";

import {
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_WIDTH_STORAGE_KEY,
  clampSidebarWidth,
  readSidebarWidth,
  writeSidebarWidth,
} from "@/features/sidebar-layout";

function memoryStorage(initial: Record<string, string> = {}) {
  const entries = new Map<string, string>(Object.entries(initial));
  return {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => {
      entries.set(key, value);
    },
    entries,
  };
}

describe("sidebar width persistence and clamping", () => {
  it("clamps and rounds sidebar widths within allowed bounds", () => {
    expect(clampSidebarWidth(SIDEBAR_MIN_WIDTH - 40)).toBe(SIDEBAR_MIN_WIDTH);
    expect(clampSidebarWidth(SIDEBAR_MAX_WIDTH + 400)).toBe(SIDEBAR_MAX_WIDTH);
    expect(clampSidebarWidth(279.6)).toBe(280);
  });

  it("falls back to default width when storage is empty, invalid, or unavailable", () => {
    expect(readSidebarWidth(null)).toBe(SIDEBAR_DEFAULT_WIDTH);
    expect(readSidebarWidth(memoryStorage())).toBe(SIDEBAR_DEFAULT_WIDTH);
    expect(readSidebarWidth(memoryStorage({ [SIDEBAR_WIDTH_STORAGE_KEY]: "not-a-number" }))).toBe(
      SIDEBAR_DEFAULT_WIDTH,
    );
    expect(readSidebarWidth(memoryStorage({ [SIDEBAR_WIDTH_STORAGE_KEY]: "0" }))).toBe(
      SIDEBAR_DEFAULT_WIDTH,
    );
    expect(readSidebarWidth(memoryStorage({ [SIDEBAR_WIDTH_STORAGE_KEY]: "-200" }))).toBe(
      SIDEBAR_DEFAULT_WIDTH,
    );
    expect(
      readSidebarWidth({
        getItem() {
          throw new Error("blocked");
        },
      }),
    ).toBe(SIDEBAR_DEFAULT_WIDTH);
  });

  it("reads and clamps persisted widths", () => {
    expect(readSidebarWidth(memoryStorage({ [SIDEBAR_WIDTH_STORAGE_KEY]: "312" }))).toBe(312);
    expect(readSidebarWidth(memoryStorage({ [SIDEBAR_WIDTH_STORAGE_KEY]: "80" }))).toBe(
      SIDEBAR_MIN_WIDTH,
    );
    expect(readSidebarWidth(memoryStorage({ [SIDEBAR_WIDTH_STORAGE_KEY]: "9999" }))).toBe(
      SIDEBAR_MAX_WIDTH,
    );
  });

  it("writes valid expanded widths and ignores collapsed or invalid widths", () => {
    const storage = memoryStorage();

    writeSidebarWidth(0, storage);
    writeSidebarWidth(SIDEBAR_MIN_WIDTH - 1, storage);
    writeSidebarWidth(Number.NaN, storage);
    expect(storage.entries.has(SIDEBAR_WIDTH_STORAGE_KEY)).toBe(false);

    writeSidebarWidth(341.4, storage);
    expect(storage.getItem(SIDEBAR_WIDTH_STORAGE_KEY)).toBe("341");

    writeSidebarWidth(SIDEBAR_MAX_WIDTH + 50, storage);
    expect(storage.getItem(SIDEBAR_WIDTH_STORAGE_KEY)).toBe(String(SIDEBAR_MAX_WIDTH));

    expect(() =>
      writeSidebarWidth(300, {
        setItem() {
          throw new Error("quota");
        },
      }),
    ).not.toThrow();
  });
});
