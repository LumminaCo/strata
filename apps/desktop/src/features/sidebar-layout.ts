export const SIDEBAR_WIDTH_STORAGE_KEY = "strata.sidebarWidth";
export const SIDEBAR_DEFAULT_WIDTH = 224;
export const SIDEBAR_MIN_WIDTH = 156;
export const SIDEBAR_MAX_WIDTH = 1200;

type StorageReader = Pick<Storage, "getItem">;
type StorageWriter = Pick<Storage, "setItem">;

function defaultStorage(): Storage | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

export function clampSidebarWidth(width: number): number {
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(width)));
}

export function readSidebarWidth(storage: StorageReader | null = defaultStorage()): number {
  if (!storage) return SIDEBAR_DEFAULT_WIDTH;
  try {
    const raw = storage.getItem(SIDEBAR_WIDTH_STORAGE_KEY);
    if (!raw) return SIDEBAR_DEFAULT_WIDTH;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) return SIDEBAR_DEFAULT_WIDTH;
    return clampSidebarWidth(parsed);
  } catch {
    return SIDEBAR_DEFAULT_WIDTH;
  }
}

export function writeSidebarWidth(
  width: number,
  storage: StorageWriter | null = defaultStorage(),
): void {
  if (!storage || !Number.isFinite(width) || width < SIDEBAR_MIN_WIDTH) return;
  try {
    storage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(clampSidebarWidth(width)));
  } catch {
    /* Ignore storage errors in restricted environments. */
  }
}
