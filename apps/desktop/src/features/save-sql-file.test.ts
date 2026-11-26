import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  browserMode: false,
  invoke: vi.fn<(command: string, args?: Record<string, unknown>) => Promise<unknown>>(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: state.invoke,
}));

vi.mock("@/ipc/client", () => ({
  get browserMode() {
    return state.browserMode;
  },
}));

import {
  DEFAULT_SQL_FILE_NAME,
  MAX_SQL_FILE_BYTES,
  canUseNativeOpenSqlPicker,
  isSqlTabUnsaved,
  openSqlFile,
  recordSavedSqlTab,
  removeSavedSqlTabs,
  saveSqlFile,
  suggestedSqlFileName,
} from "./save-sql-file";

afterEach(() => {
  state.browserMode = false;
  state.invoke.mockReset();
  Reflect.deleteProperty(globalThis, "showSaveFilePicker");
  Reflect.deleteProperty(globalThis, "showOpenFilePicker");
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
  it("invokes save_sql_file with saveAs=false for normal saves and saveAs=true for Save As in desktop mode", async () => {
    state.browserMode = false;
    state.invoke.mockResolvedValueOnce("/home/ada/Documents/Strata/report.sql");

    const saved = await saveSqlFile("SELECT 1;", {
      suggestedPath: "/home/ada/Documents/Strata/report.sql",
    });

    expect(state.invoke).toHaveBeenCalledWith("save_sql_file", {
      content: "SELECT 1;",
      suggestedPath: "/home/ada/Documents/Strata/report.sql",
      saveAs: false,
    });
    expect(saved).toEqual({ path: "/home/ada/Documents/Strata/report.sql" });

    state.invoke.mockResolvedValueOnce("/home/ada/Documents/Strata/report_v2.sql");
    const savedAs = await saveSqlFile("SELECT 2;", {
      suggestedPath: "/home/ada/Documents/Strata/report.sql",
      saveAs: true,
    });

    expect(state.invoke).toHaveBeenLastCalledWith("save_sql_file", {
      content: "SELECT 2;",
      suggestedPath: "/home/ada/Documents/Strata/report.sql",
      saveAs: true,
    });
    expect(savedAs).toEqual({ path: "/home/ada/Documents/Strata/report_v2.sql" });
  });

  it("returns null when the native save dialog is cancelled", async () => {
    state.browserMode = false;
    state.invoke.mockResolvedValueOnce(null);

    await expect(saveSqlFile("SELECT 1;")).resolves.toBeNull();
    expect(state.invoke).toHaveBeenCalledWith("save_sql_file", {
      content: "SELECT 1;",
      suggestedPath: null,
      saveAs: false,
    });
  });

  it("reuses an existing browser file handle on save and opens the picker only on saveAs", async () => {
    state.browserMode = true;
    const writeExisting = vi.fn().mockResolvedValue(undefined);
    const closeExisting = vi.fn().mockResolvedValue(undefined);
    const existingHandle = {
      name: "monthly_sales.sql",
      createWritable: vi.fn().mockResolvedValue({ write: writeExisting, close: closeExisting }),
    };

    const writeNew = vi.fn().mockResolvedValue(undefined);
    const closeNew = vi.fn().mockResolvedValue(undefined);
    const newHandle = {
      name: "monthly_sales_v2.sql",
      createWritable: vi.fn().mockResolvedValue({ write: writeNew, close: closeNew }),
    };
    const picker = vi.fn().mockResolvedValue(newHandle);
    vi.stubGlobal("showSaveFilePicker", picker);

    const overwritten = await saveSqlFile("SELECT 42;", {
      suggestedPath: "monthly_sales.sql",
      handle: existingHandle,
    });

    expect(picker).not.toHaveBeenCalled();
    expect(writeExisting).toHaveBeenCalledWith("SELECT 42;");
    expect(closeExisting).toHaveBeenCalledOnce();
    expect(overwritten).toEqual({ path: "monthly_sales.sql", handle: existingHandle });

    const savedAs = await saveSqlFile("SELECT 99;", {
      suggestedPath: "monthly_sales.sql",
      handle: existingHandle,
      saveAs: true,
    });

    expect(picker).toHaveBeenCalledWith({
      suggestedName: "monthly_sales.sql",
      startIn: "documents",
      types: [
        {
          description: "SQL files",
          accept: { "application/sql": [".sql"], "text/plain": [".sql"] },
        },
      ],
    });
    expect(writeNew).toHaveBeenCalledWith("SELECT 99;");
    expect(closeNew).toHaveBeenCalledOnce();
    expect(savedAs).toEqual({ path: "monthly_sales_v2.sql", handle: newHandle });
  });

  it("falls back to showSaveFilePicker when a previously saved browser file handle is missing", async () => {
    state.browserMode = true;
    const staleHandle = {
      name: "deleted.sql",
      createWritable: vi.fn().mockRejectedValue(new DOMException("Missing", "NotFoundError")),
    };
    const write = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn().mockResolvedValue(undefined);
    const replacementHandle = {
      name: "recreated.sql",
      createWritable: vi.fn().mockResolvedValue({ write, close }),
    };
    const picker = vi.fn().mockResolvedValue(replacementHandle);
    vi.stubGlobal("showSaveFilePicker", picker);

    const saved = await saveSqlFile("SELECT 1;", {
      suggestedPath: "deleted.sql",
      handle: staleHandle,
    });

    expect(picker).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledWith("SELECT 1;");
    expect(saved).toEqual({ path: "recreated.sql", handle: replacementHandle });
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

    expect(saved).toEqual({ path: DEFAULT_SQL_FILE_NAME });
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(anchor.href).toBe("blob:sql");
    expect(anchor.download).toBe(DEFAULT_SQL_FILE_NAME);
    expect(click).toHaveBeenCalledOnce();
  });
});

describe("openSqlFile", () => {
  it("invokes the native open_sql_file command in desktop mode", async () => {
    state.browserMode = false;
    state.invoke.mockResolvedValueOnce({
      path: "/home/ada/Documents/Strata/revenue.sql",
      content: "SELECT * FROM revenue;",
    });

    expect(canUseNativeOpenSqlPicker()).toBe(true);
    const opened = await openSqlFile("/home/ada/Documents/Strata/previous.sql");

    expect(state.invoke).toHaveBeenCalledWith("open_sql_file", {
      suggestedPath: "/home/ada/Documents/Strata/previous.sql",
    });
    expect(opened).toEqual({
      path: "/home/ada/Documents/Strata/revenue.sql",
      content: "SELECT * FROM revenue;",
    });
  });

  it("uses showOpenFilePicker in browser mode and retains the file handle", async () => {
    state.browserMode = true;
    expect(canUseNativeOpenSqlPicker()).toBe(false);

    const handle = {
      name: "orders.sql",
      createWritable: vi.fn(),
      getFile: vi.fn().mockResolvedValue({
        name: "orders.sql",
        size: 20,
        text: vi.fn().mockResolvedValue("SELECT * FROM orders;"),
      }),
    };
    const picker = vi.fn().mockResolvedValue([handle]);
    vi.stubGlobal("showOpenFilePicker", picker);

    expect(canUseNativeOpenSqlPicker()).toBe(true);
    const opened = await openSqlFile();

    expect(opened).toEqual({
      path: "orders.sql",
      content: "SELECT * FROM orders;",
      handle,
    });
  });

  it("rejects browser files larger than 8 MB and returns null on cancel", async () => {
    state.browserMode = true;
    const oversized = {
      name: "huge.sql",
      createWritable: vi.fn(),
      getFile: vi.fn().mockResolvedValue({
        name: "huge.sql",
        size: MAX_SQL_FILE_BYTES + 1,
        text: vi.fn(),
      }),
    };
    vi.stubGlobal("showOpenFilePicker", vi.fn().mockResolvedValueOnce([oversized]));
    await expect(openSqlFile()).rejects.toThrow("The SQL file exceeds 8 MB.");

    vi.stubGlobal(
      "showOpenFilePicker",
      vi.fn().mockRejectedValueOnce(new DOMException("Cancelled", "AbortError")),
    );
    await expect(openSqlFile()).resolves.toBeNull();
  });
});

describe("unsaved SQL tab tracking", () => {
  it("treats empty never-saved tabs as clean and non-empty never-saved tabs as unsaved", () => {
    expect(isSqlTabUnsaved("")).toBe(false);
    expect(isSqlTabUnsaved("SELECT 1;")).toBe(true);
    expect(isSqlTabUnsaved(" ")).toBe(true);
  });

  it("compares tab text against the last saved snapshot", () => {
    const saved = { path: "/home/ada/Documents/Strata/query.sql", content: "SELECT 1;" };
    expect(isSqlTabUnsaved("SELECT 1;", saved)).toBe(false);
    expect(isSqlTabUnsaved("SELECT 2;", saved)).toBe(true);
    expect(isSqlTabUnsaved("", saved)).toBe(true);

    // Reverting to the exact saved text clears the unsaved indicator.
    expect(isSqlTabUnsaved("SELECT 1;", saved)).toBe(false);
  });

  it("records and cleans up saved tab snapshots without unnecessary state churn", () => {
    const initial = {};
    const afterSave = recordSavedSqlTab(initial, "tab-1", "SELECT 1;", "/tmp/a.sql");
    expect(afterSave).toEqual({
      "tab-1": { path: "/tmp/a.sql", content: "SELECT 1;" },
    });
    expect(recordSavedSqlTab(afterSave, "tab-1", "SELECT 1;", "/tmp/a.sql")).toBe(afterSave);

    const handle = { name: "b.sql", createWritable: vi.fn() };
    const updated = recordSavedSqlTab(afterSave, "tab-1", "SELECT 2;", "/tmp/b.sql", handle);
    expect(updated).toEqual({
      "tab-1": { path: "/tmp/b.sql", content: "SELECT 2;", handle },
    });
    expect(recordSavedSqlTab(updated, "tab-1", "SELECT 2;", "/tmp/b.sql", handle)).toBe(updated);

    expect(removeSavedSqlTabs(updated, new Set(["tab-missing"]))).toBe(updated);
    expect(removeSavedSqlTabs(updated, new Set(["tab-1"]))).toEqual({});
  });
});
