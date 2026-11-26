import { useCallback, useEffect, useRef, useState } from "react";
import type {
  DragEvent as ReactDragEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from "react";

import {
  computeDropTarget,
  type DropPlacement,
  type TabDropTarget,
  type TabRect,
} from "@/features/tab-order";

const DRAG_THRESHOLD_PX = 5;
const EDGE_SCROLL_ZONE_PX = 28;
const EDGE_SCROLL_STEP_PX = 14;

interface DragSession {
  id: string;
  startX: number;
  startY: number;
  started: boolean;
  dropTarget: TabDropTarget | null;
}

export interface TabDragState {
  draggingId: string | null;
  dropTarget: TabDropTarget | null;
}

export interface TabDragBindings {
  ref: (element: HTMLElement | null) => void;
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  onClickCapture: (event: ReactMouseEvent<HTMLElement>) => void;
  onDragStart: (event: ReactDragEvent<HTMLElement>) => void;
  "data-dragging": "true" | undefined;
  "data-drop-position": DropPlacement | undefined;
}

export interface UseTabDragOptions {
  disabled?: boolean;
  onReorder: (activeId: string, targetId: string, placement: DropPlacement) => void;
}

interface PointerDownLike {
  button: number;
  clientX: number;
  clientY: number;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  defaultPrevented?: boolean;
  target: EventTarget | null;
}

interface PreventableEventLike {
  preventDefault: () => void;
  stopPropagation: () => void;
}

interface DragStartLike {
  preventDefault: () => void;
}

export interface TabDragControllerOptions {
  getDisabled: () => boolean;
  getList: () => HTMLElement | null;
  onReorder: (activeId: string, targetId: string, placement: DropPlacement) => void;
  onStateChange: (state: TabDragState) => void;
}

export function createTabDragController({
  getDisabled,
  getList,
  onReorder,
  onStateChange,
}: TabDragControllerOptions) {
  const itemRefs = new Map<string, HTMLElement>();
  const refCallbacks = new Map<string, (element: HTMLElement | null) => void>();

  let session: DragSession | null = null;
  let cleanupListeners: (() => void) | null = null;
  let suppressClick = false;
  let suppressClickTimer: number | null = null;
  let state: TabDragState = { draggingId: null, dropTarget: null };

  function emitState(nextDraggingId: string | null, nextDropTarget: TabDropTarget | null) {
    if (
      state.draggingId === nextDraggingId &&
      state.dropTarget?.id === nextDropTarget?.id &&
      state.dropTarget?.placement === nextDropTarget?.placement
    ) {
      return;
    }
    state = { draggingId: nextDraggingId, dropTarget: nextDropTarget };
    onStateChange(state);
  }

  function clearBodyDragFlag() {
    if (typeof document !== "undefined" && document.body) {
      delete document.body.dataset.tabDragging;
    }
  }

  function clearListeners() {
    if (!cleanupListeners) return;
    cleanupListeners();
    cleanupListeners = null;
  }

  function stopSession(commit: boolean) {
    clearListeners();
    const active = session;
    if (!active) return;
    session = null;
    clearBodyDragFlag();

    if (active.started) {
      suppressClick = true;
      if (suppressClickTimer !== null && typeof window !== "undefined") {
        window.clearTimeout(suppressClickTimer);
      }
      if (typeof window !== "undefined") {
        suppressClickTimer = window.setTimeout(() => {
          suppressClick = false;
          suppressClickTimer = null;
        }, 0);
      } else {
        suppressClick = false;
      }
      if (commit && active.dropTarget) {
        onReorder(active.id, active.dropTarget.id, active.dropTarget.placement);
      }
    }

    emitState(null, null);
  }

  function measureRects(): TabRect[] {
    const rects: TabRect[] = [];
    for (const [id, element] of itemRefs.entries()) {
      if (!element.isConnected) continue;
      const box = element.getBoundingClientRect();
      if (box.width <= 0) continue;
      rects.push({ id, left: box.left, width: box.width });
    }
    rects.sort((a, b) => a.left - b.left);
    return rects;
  }

  function startTracking(id: string, event: PointerDownLike) {
    if (
      getDisabled() ||
      event.defaultPrevented ||
      event.button !== 0 ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey
    ) {
      return;
    }
    const target = event.target as HTMLElement | null;
    if (target?.closest?.("[data-no-drag='true'], input, textarea")) return;

    if (session) {
      stopSession(false);
    }

    session = {
      id,
      startX: event.clientX,
      startY: event.clientY,
      started: false,
      dropTarget: null,
    };

    const handlePointerMove = (moveEvent: PointerEvent) => {
      const current = session;
      if (!current) return;
      const dx = moveEvent.clientX - current.startX;
      const dy = moveEvent.clientY - current.startY;
      if (!current.started) {
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
        current.started = true;
        if (typeof document !== "undefined" && document.body) {
          document.body.dataset.tabDragging = "true";
        }
        if (typeof window !== "undefined") {
          window.getSelection?.()?.removeAllRanges();
        }
      }

      const list = getList();
      if (list) {
        const listRect = list.getBoundingClientRect();
        if (moveEvent.clientX < listRect.left + EDGE_SCROLL_ZONE_PX) {
          list.scrollLeft -= EDGE_SCROLL_STEP_PX;
        } else if (moveEvent.clientX > listRect.right - EDGE_SCROLL_ZONE_PX) {
          list.scrollLeft += EDGE_SCROLL_STEP_PX;
        }
      }

      const nextTarget = computeDropTarget(moveEvent.clientX, current.id, measureRects());
      current.dropTarget = nextTarget;
      emitState(current.id, nextTarget);
    };

    const handlePointerUp = () => {
      stopSession(true);
    };

    const handlePointerCancel = () => {
      stopSession(false);
    };

    const handleKeyDown = (keyEvent: KeyboardEvent) => {
      if (keyEvent.key !== "Escape") return;
      keyEvent.preventDefault();
      stopSession(false);
    };

    if (typeof window !== "undefined") {
      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", handlePointerUp);
      window.addEventListener("pointercancel", handlePointerCancel);
      window.addEventListener("keydown", handleKeyDown);
      cleanupListeners = () => {
        window.removeEventListener("pointermove", handlePointerMove);
        window.removeEventListener("pointerup", handlePointerUp);
        window.removeEventListener("pointercancel", handlePointerCancel);
        window.removeEventListener("keydown", handleKeyDown);
      };
    }
  }

  function registerRef(id: string): (element: HTMLElement | null) => void {
    const existing = refCallbacks.get(id);
    if (existing) return existing;
    const callback = (element: HTMLElement | null) => {
      if (element) {
        itemRefs.set(id, element);
      } else {
        itemRefs.delete(id);
      }
    };
    refCallbacks.set(id, callback);
    return callback;
  }

  function handleClickCapture(event: PreventableEventLike) {
    if (!suppressClick) return;
    event.preventDefault();
    event.stopPropagation();
  }

  function handleDragStart(event: DragStartLike) {
    event.preventDefault();
  }

  function cancel() {
    stopSession(false);
  }

  function dispose() {
    stopSession(false);
    if (suppressClickTimer !== null && typeof window !== "undefined") {
      window.clearTimeout(suppressClickTimer);
      suppressClickTimer = null;
    }
    suppressClick = false;
    clearBodyDragFlag();
    itemRefs.clear();
    refCallbacks.clear();
  }

  return {
    registerRef,
    startTracking,
    handleClickCapture,
    handleDragStart,
    cancel,
    dispose,
  };
}

export function useTabDrag({ disabled = false, onReorder }: UseTabDragOptions) {
  const [dragState, setDragState] = useState<TabDragState>({
    draggingId: null,
    dropTarget: null,
  });

  const listRef = useRef<HTMLDivElement>(null);
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;
  const onReorderRef = useRef(onReorder);
  onReorderRef.current = onReorder;

  const controllerRef = useRef<ReturnType<typeof createTabDragController> | null>(null);
  if (!controllerRef.current) {
    controllerRef.current = createTabDragController({
      getDisabled: () => disabledRef.current,
      getList: () => listRef.current,
      onReorder: (activeId, targetId, placement) =>
        onReorderRef.current(activeId, targetId, placement),
      onStateChange: setDragState,
    });
  }

  useEffect(() => {
    const controller = controllerRef.current;
    return () => {
      controller?.dispose();
    };
  }, []);

  useEffect(() => {
    if (disabled) {
      controllerRef.current?.cancel();
    }
  }, [disabled]);

  const getTabProps = useCallback(
    (id: string): TabDragBindings => {
      const controller = controllerRef.current;
      return {
        ref: controller ? controller.registerRef(id) : () => {},
        onPointerDown: (event: ReactPointerEvent<HTMLElement>) =>
          controller?.startTracking(id, event),
        onClickCapture: (event: ReactMouseEvent<HTMLElement>) =>
          controller?.handleClickCapture(event),
        onDragStart: (event: ReactDragEvent<HTMLElement>) => controller?.handleDragStart(event),
        "data-dragging": dragState.draggingId === id ? "true" : undefined,
        "data-drop-position":
          dragState.dropTarget?.id === id ? dragState.dropTarget.placement : undefined,
      };
    },
    [dragState.draggingId, dragState.dropTarget],
  );

  return {
    listRef,
    draggingId: dragState.draggingId,
    dropTarget: dragState.dropTarget,
    getTabProps,
  };
}
