import { invoke } from "@tauri-apps/api/core";

import { browserMode } from "@/ipc/client";

export const DEFAULT_SQL_FILE_NAME = "query.sql";
export const MAX_SQL_FILE_BYTES = 8_000_000;

export interface SaveFilePickerWritable {
  write(data: string): Promise<void>;
  close(): Promise<void>;
}

export interface SaveFilePickerHandle {
  name?: string;
  createWritable(): Promise<SaveFilePickerWritable>;
}

interface OpenFilePickerHandle extends SaveFilePickerHandle {
  getFile(): Promise<File>;
}

interface FilePickerAcceptType {
  description?: string;
  accept: Record<string, string[]>;
}

interface SaveFilePickerOptions {
  suggestedName?: string;
  startIn?: string;
  types?: FilePickerAcceptType[];
}

interface OpenFilePickerOptions {
  multiple?: boolean;
  startIn?: string;
  types?: FilePickerAcceptType[];
}

type ShowSaveFilePicker = (options?: SaveFilePickerOptions) => Promise<SaveFilePickerHandle>;
type ShowOpenFilePicker = (options?: OpenFilePickerOptions) => Promise<OpenFilePickerHandle[]>;

interface FilePickerWindow {
  showSaveFilePicker?: ShowSaveFilePicker;
  showOpenFilePicker?: ShowOpenFilePicker;
}

const SQL_FILE_PICKER_TYPES: FilePickerAcceptType[] = [
  {
    description: "SQL files",
    accept: { "application/sql": [".sql"], "text/plain": [".sql"] },
  },
];

export interface SavedSqlState {
  path?: string;
  content: string;
  handle?: SaveFilePickerHandle;
}

export interface SaveSqlOptions {
  suggestedPath?: string;
  handle?: SaveFilePickerHandle;
  saveAs?: boolean;
}

export interface SaveSqlResult {
  path: string;
  handle?: SaveFilePickerHandle;
}

export interface OpenedSqlFile {
  path: string;
  content: string;
  handle?: SaveFilePickerHandle;
}

export function isSqlTabUnsaved(text: string, saved?: SavedSqlState): boolean {
  if (saved !== undefined) {
    return text !== saved.content;
  }
  return text.length > 0;
}

export function seedSavedSqlTabs(
  tabs: ReadonlyArray<{ id: string; text: string; filePath?: string }>,
): Record<string, SavedSqlState> {
  const next: Record<string, SavedSqlState> = {};
  for (const tab of tabs) {
    const path = tab.filePath?.trim() || undefined;
    next[tab.id] = {
      ...(path !== undefined ? { path } : {}),
      content: tab.text,
    };
  }
  return next;
}

export function recordSavedSqlTab(
  current: Record<string, SavedSqlState>,
  tabId: string,
  content: string,
  path?: string,
  handle?: SaveFilePickerHandle,
): Record<string, SavedSqlState> {
  const next: SavedSqlState = {
    ...(path !== undefined ? { path } : {}),
    ...(handle !== undefined ? { handle } : {}),
    content,
  };
  const existing = current[tabId];
  if (
    existing &&
    existing.path === next.path &&
    existing.content === next.content &&
    existing.handle === next.handle
  ) {
    return current;
  }
  return { ...current, [tabId]: next };
}

export function removeSavedSqlTabs(
  current: Record<string, SavedSqlState>,
  closing: ReadonlySet<string>,
): Record<string, SavedSqlState> {
  let changed = false;
  const next = { ...current };
  for (const id of closing) {
    if (id in next) {
      delete next[id];
      changed = true;
    }
  }
  return changed ? next : current;
}

export function suggestedSqlFileName(suggestedPath?: string): string {
  const trimmed = suggestedPath?.trim();
  if (!trimmed) return DEFAULT_SQL_FILE_NAME;
  const segments = trimmed.split(/[/\\]/).filter(Boolean);
  const candidate = segments.at(-1)?.trim();
  if (!candidate || candidate === "." || candidate === "..") return DEFAULT_SQL_FILE_NAME;
  return candidate;
}

export function canUseNativeOpenSqlPicker(): boolean {
  return !browserMode || typeof (globalThis as FilePickerWindow).showOpenFilePicker === "function";
}

export async function openSqlFile(suggestedPath?: string): Promise<OpenedSqlFile | null> {
  if (!browserMode) {
    return invoke<OpenedSqlFile | null>("open_sql_file", {
      suggestedPath: suggestedPath ?? null,
    });
  }

  const picker = (globalThis as FilePickerWindow).showOpenFilePicker;
  if (typeof picker !== "function") {
    return null;
  }

  try {
    const [handle] = await picker({
      multiple: false,
      startIn: "documents",
      types: SQL_FILE_PICKER_TYPES,
    });
    if (!handle) return null;
    const file = await handle.getFile();
    if (file.size > MAX_SQL_FILE_BYTES) {
      throw new Error("The SQL file exceeds 8 MB.");
    }
    const content = await file.text();
    return {
      path: handle.name ?? file.name,
      content,
      handle,
    };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      return null;
    }
    throw error;
  }
}

export async function saveSqlFile(
  content: string,
  options?: SaveSqlOptions,
): Promise<SaveSqlResult | null> {
  if (!browserMode) {
    const savedPath = await invoke<string | null>("save_sql_file", {
      content,
      suggestedPath: options?.suggestedPath ?? null,
      saveAs: options?.saveAs ?? false,
    });
    return savedPath ? { path: savedPath } : null;
  }

  return saveSqlFileInBrowser(content, options);
}

async function writeToFileHandle(handle: SaveFilePickerHandle, content: string): Promise<void> {
  const writable = await handle.createWritable();
  try {
    await writable.write(content);
  } finally {
    await writable.close();
  }
}

async function saveSqlFileInBrowser(
  content: string,
  options?: SaveSqlOptions,
): Promise<SaveSqlResult | null> {
  const suggestedName = suggestedSqlFileName(options?.suggestedPath);
  const saveAs = options?.saveAs ?? false;
  if (!saveAs && options?.handle) {
    try {
      await writeToFileHandle(options.handle, content);
      return {
        path: options.handle.name ?? suggestedName,
        handle: options.handle,
      };
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        return null;
      }
      if (!(error instanceof DOMException && error.name === "NotFoundError")) {
        throw error;
      }
    }
  }

  const picker = (globalThis as FilePickerWindow).showSaveFilePicker;
  if (typeof picker === "function") {
    try {
      const handle = await picker({
        suggestedName,
        startIn: "documents",
        types: SQL_FILE_PICKER_TYPES,
      });
      await writeToFileHandle(handle, content);
      return {
        path: handle.name ?? suggestedName,
        handle,
      };
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        return null;
      }
      throw error;
    }
  }

  const url = URL.createObjectURL(new Blob([content], { type: "text/plain;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = suggestedName;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
  return { path: suggestedName };
}
