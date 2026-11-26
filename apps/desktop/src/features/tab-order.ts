import type { ResultSet } from "@/components/result-grid";
import type { SavedTab } from "@/ipc/bindings/protocol";

export const MAX_TAB_TITLE_LENGTH = 80;
export const MESSAGES_TAB_ID = "messages";

export type DropPlacement = "before" | "after";

export interface TabDropTarget {
  id: string;
  placement: DropPlacement;
}

export interface TabRect {
  id: string;
  left: number;
  width: number;
}

export function normalizeTabTitle(value: string): string | undefined {
  const cleaned = value.replace(/\s+/g, " ").trim().slice(0, MAX_TAB_TITLE_LENGTH).trim();
  return cleaned.length > 0 ? cleaned : undefined;
}

export function reorderItems<T>(items: readonly T[], fromIndex: number, toIndex: number): T[] {
  if (
    fromIndex < 0 ||
    toIndex < 0 ||
    fromIndex >= items.length ||
    toIndex >= items.length ||
    fromIndex === toIndex
  ) {
    return items as T[];
  }
  const next = [...items];
  const [moved] = next.splice(fromIndex, 1);
  if (moved === undefined) return items as T[];
  next.splice(toIndex, 0, moved);
  return next;
}

export function reorderById<T>(
  items: readonly T[],
  activeId: string,
  targetId: string,
  placement: DropPlacement,
  getId: (item: T) => string,
): T[] {
  if (activeId === targetId) return items as T[];
  const fromIndex = items.findIndex((item) => getId(item) === activeId);
  const originalTargetIndex = items.findIndex((item) => getId(item) === targetId);
  if (fromIndex === -1 || originalTargetIndex === -1) return items as T[];

  const remaining = items.filter((_, index) => index !== fromIndex);
  const targetIndex = remaining.findIndex((item) => getId(item) === targetId);
  if (targetIndex === -1) return items as T[];

  const insertIndex = placement === "after" ? targetIndex + 1 : targetIndex;
  if (insertIndex === fromIndex) return items as T[];

  const moved = items[fromIndex];
  if (moved === undefined) return items as T[];
  remaining.splice(insertIndex, 0, moved);
  return remaining;
}

export function moveItemByOffset<T>(
  items: readonly T[],
  id: string,
  delta: -1 | 1,
  getId: (item: T) => string,
): T[] {
  const index = items.findIndex((item) => getId(item) === id);
  if (index === -1) return items as T[];
  const nextIndex = index + delta;
  if (nextIndex < 0 || nextIndex >= items.length) return items as T[];
  return reorderItems(items, index, nextIndex);
}

export function reorderByOrder<T>(
  items: readonly T[],
  order: readonly string[],
  getId: (item: T) => string,
): T[] {
  if (items.length < 2) return items as T[];
  const byId = new Map<string, T>();
  for (const item of items) {
    byId.set(getId(item), item);
  }
  const ordered: T[] = [];
  const seen = new Set<string>();
  for (const id of order) {
    const item = byId.get(id);
    if (!item || seen.has(id)) continue;
    seen.add(id);
    ordered.push(item);
  }
  for (const item of items) {
    const id = getId(item);
    if (seen.has(id)) continue;
    seen.add(id);
    ordered.push(item);
  }
  if (ordered.length === items.length && ordered.every((item, index) => item === items[index])) {
    return items as T[];
  }
  return ordered;
}

export function resolveResultPanelOrder(
  savedOrder: readonly string[] | undefined,
  resultIds: readonly string[],
  pinnedKeys: readonly string[],
): string[] {
  const resultSet = new Set(resultIds);
  const pinnedSet = new Set(pinnedKeys);

  if (!savedOrder || savedOrder.length === 0) {
    return [...resultIds, ...pinnedKeys, MESSAGES_TAB_ID];
  }

  const resolved: string[] = [];
  const seen = new Set<string>();
  for (const id of savedOrder) {
    if (seen.has(id)) continue;
    if (id === MESSAGES_TAB_ID || resultSet.has(id) || pinnedSet.has(id)) {
      seen.add(id);
      resolved.push(id);
    }
  }

  const missingResults = resultIds.filter((id) => !seen.has(id));
  if (missingResults.length > 0) {
    let lastResultIndex = -1;
    for (let index = resolved.length - 1; index >= 0; index -= 1) {
      const id = resolved[index];
      if (id !== undefined && resultSet.has(id)) {
        lastResultIndex = index;
        break;
      }
    }
    const insertAt = lastResultIndex >= 0 ? lastResultIndex + 1 : 0;
    resolved.splice(insertAt, 0, ...missingResults);
    for (const id of missingResults) seen.add(id);
  }

  const missingPinned = pinnedKeys.filter((id) => !seen.has(id));
  if (missingPinned.length > 0) {
    let lastPinnedIndex = -1;
    for (let index = resolved.length - 1; index >= 0; index -= 1) {
      const id = resolved[index];
      if (id !== undefined && pinnedSet.has(id)) {
        lastPinnedIndex = index;
        break;
      }
    }
    const messagesIndex = resolved.indexOf(MESSAGES_TAB_ID);
    const insertAt =
      lastPinnedIndex >= 0
        ? lastPinnedIndex + 1
        : messagesIndex >= 0
          ? messagesIndex
          : resolved.length;
    resolved.splice(insertAt, 0, ...missingPinned);
    for (const id of missingPinned) seen.add(id);
  }

  if (!seen.has(MESSAGES_TAB_ID)) {
    resolved.push(MESSAGES_TAB_ID);
  }

  return resolved;
}

export function computeDropTarget(
  pointerX: number,
  draggingId: string,
  rects: readonly TabRect[],
): TabDropTarget | null {
  if (rects.length < 2) return null;
  const draggingIndex = rects.findIndex((rect) => rect.id === draggingId);
  if (draggingIndex === -1) return null;

  let chosen: TabRect | undefined;
  let placement: DropPlacement = "before";

  const first = rects[0];
  const last = rects[rects.length - 1];
  if (!first || !last) return null;

  if (pointerX <= first.left) {
    chosen = first;
    placement = "before";
  } else if (pointerX >= last.left + last.width) {
    chosen = last;
    placement = "after";
  } else {
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const rect of rects) {
      const right = rect.left + rect.width;
      if (pointerX >= rect.left && pointerX <= right) {
        chosen = rect;
        placement = pointerX < rect.left + rect.width / 2 ? "before" : "after";
        break;
      }
      const distance = pointerX < rect.left ? rect.left - pointerX : pointerX - right;
      if (distance < bestDistance) {
        bestDistance = distance;
        chosen = rect;
        placement = pointerX < rect.left + rect.width / 2 ? "before" : "after";
      }
    }
  }

  if (!chosen || chosen.id === draggingId) return null;

  const targetIndex = rects.findIndex((rect) => rect.id === chosen.id);
  const insertAfterRemove =
    (targetIndex > draggingIndex ? targetIndex - 1 : targetIndex) + (placement === "after" ? 1 : 0);
  if (insertAfterRemove === draggingIndex) return null;

  return { id: chosen.id, placement };
}

export function defaultScriptTabLabel(
  tabs: readonly SavedTab[],
  tab: SavedTab,
  connectionName?: string,
): string {
  const title = connectionName ?? "Deleted connection";
  const number = tabs
    .filter((value) => value.connectionId === tab.connectionId)
    .findIndex((value) => value.id === tab.id);
  return number > 0 ? `${title} ${number + 1}` : title;
}

export function scriptTabLabel(
  tabs: readonly SavedTab[],
  tab: SavedTab,
  connectionName?: string,
): string {
  const custom = tab.title ? normalizeTabTitle(tab.title) : undefined;
  return custom ?? defaultScriptTabLabel(tabs, tab, connectionName);
}

export function defaultResultTabLabel(result: Pick<ResultSet, "index">): string {
  return `Result ${result.index + 1}`;
}

export function resultTabLabel(result: Pick<ResultSet, "index" | "title">): string {
  const custom = result.title ? normalizeTabTitle(result.title) : undefined;
  return custom ?? defaultResultTabLabel(result);
}
