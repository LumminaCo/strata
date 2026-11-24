import { useCallback, useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";

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

export interface TabDragBindings {
  ref: (element: HTMLElement | null) => void;
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  onClickCapture: (event: ReactMouseEvent<HTMLElement>) => void;
  "data-dragging": "true" | undefined;
  "data-drop-position": DropPlacement | undefined;
}

export interface UseTabDragOptions {
  disabled?: boolean;
  onReorder: (activeId: string, targetId: string, placement: DropPlacement) => void;
}

export function useTabDrag({ disabled = false, onReorder }: UseTabDragOptions) {
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<TabDropTarget | null>(null);

  const listRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef(new Map<string, HTMLElement>());
  const sessionRef = useRef<DragSession | null>(null);
  const suppressClickRef = useRef(false);
  const onReorderRef = useRef(onReorder);
  onReorderRef.current = onReorder;

  const stopSession = useCallback((commit: boolean) => {
    const session = sessionRef.current;
    if (!session) return;
    sessionRef.current = null;
    delete document.body.dataset.tabDragging;

    if (session.started) {
      suppressClickRef.current = true;
      window.setTimeout(() => {
        suppressClickRef.current = false;
      }, 0);
      if (commit && session.dropTarget) {
        onReorderRef.current(session.id, session.dropTarget.id, session.dropTarget.placement);
      }
    }

    setDraggingId(null);
    setDropTarget(null);
  }, []);

  useEffect(() => {
    return () => {
      delete document.body.dataset.tabDragging;
    };
  }, []);

  useEffect(() => {
    if (disabled && sessionRef.current) {
      stopSession(false);
    }
  }, [disabled, stopSession]);

  const measureRects = useCallback((): TabRect[] => {
    const rects: TabRect[] = [];
    for (const [id, element] of itemRefs.current.entries()) {
      if (!element.isConnected) continue;
      const box = element.getBoundingClientRect();
      if (box.width <= 0) continue;
      rects.push({ id, left: box.left, width: box.width });
    }
    rects.sort((a, b) => a.left - b.left);
    return rects;
  }, []);

  const startTracking = useCallback(
    (id: string, event: ReactPointerEvent<HTMLElement>) => {
      if (disabled || event.button !== 0 || event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("[data-no-drag='true'], input, textarea")) return;

      const session: DragSession = {
        id,
        startX: event.clientX,
        startY: event.clientY,
        started: false,
        dropTarget: null,
      };
      sessionRef.current = session;

      const handlePointerMove = (moveEvent: PointerEvent) => {
        const current = sessionRef.current;
        if (!current) return;
        const dx = moveEvent.clientX - current.startX;
        const dy = moveEvent.clientY - current.startY;
        if (!current.started) {
          if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
          current.started = true;
          document.body.dataset.tabDragging = "true";
          setDraggingId(current.id);
        }

        const list = listRef.current;
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
        setDropTarget((previous) => {
          if (previous?.id === nextTarget?.id && previous?.placement === nextTarget?.placement) {
            return previous;
          }
          return nextTarget;
        });
      };

      const cleanup = () => {
        window.removeEventListener("pointermove", handlePointerMove);
        window.removeEventListener("pointerup", handlePointerUp);
        window.removeEventListener("pointercancel", handlePointerCancel);
        window.removeEventListener("keydown", handleKeyDown);
      };

      const handlePointerUp = () => {
        cleanup();
        stopSession(true);
      };

      const handlePointerCancel = () => {
        cleanup();
        stopSession(false);
      };

      const handleKeyDown = (keyEvent: KeyboardEvent) => {
        if (keyEvent.key !== "Escape") return;
        keyEvent.preventDefault();
        cleanup();
        stopSession(false);
      };

      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", handlePointerUp);
      window.addEventListener("pointercancel", handlePointerCancel);
      window.addEventListener("keydown", handleKeyDown);
    },
    [disabled, measureRects, stopSession],
  );

  const registerRef = useCallback(
    (id: string) => (element: HTMLElement | null) => {
      if (element) itemRefs.current.set(id, element);
      else itemRefs.current.delete(id);
    },
    [],
  );

  const handleClickCapture = useCallback((event: ReactMouseEvent<HTMLElement>) => {
    if (!suppressClickRef.current) return;
    event.preventDefault();
    event.stopPropagation();
  }, []);

  const getTabProps = useCallback(
    (id: string): TabDragBindings => ({
      ref: registerRef(id),
      onPointerDown: (event: ReactPointerEvent<HTMLElement>) => startTracking(id, event),
      onClickCapture: handleClickCapture,
      "data-dragging": draggingId === id ? "true" : undefined,
      "data-drop-position": dropTarget?.id === id ? dropTarget.placement : undefined,
    }),
    [draggingId, dropTarget, handleClickCapture, registerRef, startTracking],
  );

  return {
    listRef,
    draggingId,
    dropTarget,
    getTabProps,
  };
}
