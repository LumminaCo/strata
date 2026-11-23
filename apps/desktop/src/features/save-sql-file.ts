import { invoke } from "@tauri-apps/api/core";

import { browserMode } from "@/ipc/client";

export const DEFAULT_SQL_FILE_NAME = "query.sql";

interface SaveFilePickerWritable {
  write(data: string): Promise<void>;
  close(): Promise<void>;
}

interface SaveFilePickerHandle {
  name?: string;
  createWritable(): Promise<SaveFilePickerWritable>;
}

interface SaveFilePickerOptions {
  suggestedName?: string;
  startIn?: string;
  types?: Array<{
    description?: string;
    accept: Record<string, string[]>;
  }>;
}

type ShowSaveFilePicker = (options?: SaveFilePickerOptions) => Promise<SaveFilePickerHandle>;

interface SaveFilePickerWindow {
  showSaveFilePicker?: ShowSaveFilePicker;
}

export function suggestedSqlFileName(suggestedPath?: string): string {
  const trimmed = suggestedPath?.trim();
  if (!trimmed) return DEFAULT_SQL_FILE_NAME;
  const segments = trimmed.split(/[/\\]/).filter(Boolean);
  const candidate = segments.at(-1)?.trim();
  if (!candidate || candidate === "." || candidate === "..") return DEFAULT_SQL_FILE_NAME;
  return candidate;
}

export async function saveSqlFile(content: string, suggestedPath?: string): Promise<string | null> {
  if (!browserMode) {
    return invoke<string | null>("save_sql_file", {
      content,
      suggestedPath: suggestedPath ?? null,
    });
  }

  return saveSqlFileInBrowser(content, suggestedPath);
}

async function saveSqlFileInBrowser(
  content: string,
  suggestedPath?: string,
): Promise<string | null> {
  const suggestedName = suggestedSqlFileName(suggestedPath);
  const picker = (globalThis as SaveFilePickerWindow).showSaveFilePicker;
  if (typeof picker === "function") {
    try {
      const handle = await picker({
        suggestedName,
        startIn: "documents",
        types: [
          {
            description: "SQL files",
            accept: { "application/sql": [".sql"], "text/plain": [".sql"] },
          },
        ],
      });
      const writable = await handle.createWritable();
      try {
        await writable.write(content);
      } finally {
        await writable.close();
      }
      return handle.name ?? suggestedName;
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
  return suggestedName;
}
