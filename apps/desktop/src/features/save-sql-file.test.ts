import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  browserMode: false,
  invoke: vi.fn<(command: string, args?: Record<string, unknown>) => Promise<string | null>>(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: state.invoke,
}));

vi.mock("@/ipc/client", () => ({
  get browserMode() {
    return state.browserMode;
  },
}));

import { DEFAULT_SQL_FILE_NAME, saveSqlFile, suggestedSqlFileName } from "./save-sql-file";

afterEach(() => {
  state.browserMode = false;
  state.invoke.mockReset();
  Reflect.deleteProperty(globalThis, "showSaveFilePicker");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("suggestedSqlFileName", () => {
  it("extracts a clean filename from POSIX and Windows paths", () => {
    expect(suggestedSqlFileName("/home/ada/Documents/Strata/sales.sql")).toBe("sales.sql");
    expect(suggestedSqlFileName("C:\\Users\\ada\\Documents\\Strata\\orders.sql")).toBe(
      "orders.sql",
    );
    expect(suggestedSqlFileName(undefined)).toBe(DEFAULT_SQL_FILE_NAME);
    expect(suggestedSqlFileName("   ")).toBe(DEFAULT_SQL_FILE_NAME);
    expect(suggestedSqlFileName("..")).toBe(DEFAULT_SQL_FILE_NAME);
  });
});

describe("saveSqlFile", () => {
  it("invokes the native save_sql_file command in desktop mode", async () => {
    state.browserMode = false;
    state.invoke.mockResolvedValueOnce("/home/ada/Documents/Strata/report.sql");

    const saved = await saveSqlFile("SELECT 1;", "/home/ada/Documents/Strata/query.sql");

    expect(state.invoke).toHaveBeenCalledWith("save_sql_file", {
      content: "SELECT 1;",
      suggestedPath: "/home/ada/Documents/Strata/query.sql",
    });
    expect(saved).toBe("/home/ada/Documents/Strata/report.sql");
  });

  it("returns null when the native save dialog is cancelled", async () => {
    state.browserMode = false;
    state.invoke.mockResolvedValueOnce(null);

    await expect(saveSqlFile("SELECT 1;")).resolves.toBeNull();
    expect(state.invoke).toHaveBeenCalledWith("save_sql_file", {
      content: "SELECT 1;",
      suggestedPath: null,
    });
  });

  it("uses showSaveFilePicker in browser mode when available", async () => {
    state.browserMode = true;
    const write = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn().mockResolvedValue(undefined);
    const picker = vi.fn().mockResolvedValue({
      name: "custom.sql",
      createWritable: vi.fn().mockResolvedValue({ write, close }),
    });
    vi.stubGlobal("showSaveFilePicker", picker);

    const saved = await saveSqlFile("SELECT 42;", "/tmp/previous.sql");

    expect(picker).toHaveBeenCalledWith({
      suggestedName: "previous.sql",
      startIn: "documents",
      types: [
        {
          description: "SQL files",
          accept: { "application/sql": [".sql"], "text/plain": [".sql"] },
        },
      ],
    });
    expect(write).toHaveBeenCalledWith("SELECT 42;");
    expect(close).toHaveBeenCalledOnce();
    expect(saved).toBe("custom.sql");
  });

  it("returns null when the browser save picker is cancelled", async () => {
    state.browserMode = true;
    const picker = vi.fn().mockRejectedValue(new DOMException("Cancelled", "AbortError"));
    vi.stubGlobal("showSaveFilePicker", picker);

    await expect(saveSqlFile("SELECT 42;")).resolves.toBeNull();
  });

  it("falls back to a browser download when showSaveFilePicker is unavailable", async () => {
    state.browserMode = true;
    const click = vi.fn();
    const anchor = { href: "", download: "", click };
    vi.stubGlobal("document", {
      createElement: vi.fn(() => anchor),
    });
    const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:sql");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});

    const saved = await saveSqlFile("SELECT 1;");

    expect(saved).toBe(DEFAULT_SQL_FILE_NAME);
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(anchor.href).toBe("blob:sql");
    expect(anchor.download).toBe(DEFAULT_SQL_FILE_NAME);
    expect(click).toHaveBeenCalledOnce();
  });
});
