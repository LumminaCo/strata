export const SIDEBAR_WIDTH_STORAGE_KEY = "strata.sidebarWidth";
export const SIDEBAR_DEFAULT_WIDTH = 224;
export const SIDEBAR_MIN_WIDTH = 156;
export const SIDEBAR_MAX_WIDTH = 1200;

export const ACTIVITY_SIDEBAR_WIDTH_STORAGE_KEY = "strata.activitySidebarWidth";
export const ACTIVITY_SIDEBAR_DEFAULT_WIDTH = 312;
export const ACTIVITY_SIDEBAR_MIN_WIDTH = 220;
export const ACTIVITY_SIDEBAR_MAX_WIDTH = 1200;

type StorageReader = Pick<Storage, "getItem">;
type StorageWriter = Pick<Storage, "setItem">;

function defaultStorage(): Storage | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

function clampWidth(width: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(width)));
}

function readPersistedWidth(
  key: string,
  defaultWidth: number,
  min: number,
  max: number,
  storage: StorageReader | null = defaultStorage(),
): number {
  if (!storage) return defaultWidth;
  try {
    const raw = storage.getItem(key);
    if (!raw) return defaultWidth;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) return defaultWidth;
    return clampWidth(parsed, min, max);
  } catch {
    return defaultWidth;
  }
}

function writePersistedWidth(
  key: string,
  width: number,
  min: number,
  max: number,
  storage: StorageWriter | null = defaultStorage(),
): void {
  if (!storage || !Number.isFinite(width) || width < min) return;
  try {
    storage.setItem(key, String(clampWidth(width, min, max)));
  } catch {
    /* Ignore storage errors in restricted environments. */
  }
}

export function clampSidebarWidth(width: number): number {
  return clampWidth(width, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH);
}

export function readSidebarWidth(storage: StorageReader | null = defaultStorage()): number {
  return readPersistedWidth(
    SIDEBAR_WIDTH_STORAGE_KEY,
    SIDEBAR_DEFAULT_WIDTH,
    SIDEBAR_MIN_WIDTH,
    SIDEBAR_MAX_WIDTH,
    storage,
  );
}

export function writeSidebarWidth(
  width: number,
  storage: StorageWriter | null = defaultStorage(),
): void {
  writePersistedWidth(
    SIDEBAR_WIDTH_STORAGE_KEY,
    width,
    SIDEBAR_MIN_WIDTH,
    SIDEBAR_MAX_WIDTH,
    storage,
  );
}

export function clampActivitySidebarWidth(width: number): number {
  return clampWidth(width, ACTIVITY_SIDEBAR_MIN_WIDTH, ACTIVITY_SIDEBAR_MAX_WIDTH);
}

export function readActivitySidebarWidth(storage: StorageReader | null = defaultStorage()): number {
  return readPersistedWidth(
    ACTIVITY_SIDEBAR_WIDTH_STORAGE_KEY,
    ACTIVITY_SIDEBAR_DEFAULT_WIDTH,
    ACTIVITY_SIDEBAR_MIN_WIDTH,
    ACTIVITY_SIDEBAR_MAX_WIDTH,
    storage,
  );
}

export function writeActivitySidebarWidth(
  width: number,
  storage: StorageWriter | null = defaultStorage(),
): void {
  writePersistedWidth(
    ACTIVITY_SIDEBAR_WIDTH_STORAGE_KEY,
    width,
    ACTIVITY_SIDEBAR_MIN_WIDTH,
    ACTIVITY_SIDEBAR_MAX_WIDTH,
    storage,
  );
}
