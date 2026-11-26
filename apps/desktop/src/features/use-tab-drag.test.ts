import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { createTabDragController, type TabDragState } from "@/features/use-tab-drag";

interface FakeWindow {
  listeners: Map<string, Set<(event: unknown) => void>>;
  addEventListener: (type: string, listener: (event: unknown) => void) => void;
  removeEventListener: (type: string, listener: (event: unknown) => void) => void;
  dispatch: (type: string, event: unknown) => void;
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
  getSelection: () => { removeAllRanges: () => void };
}

function installFakeDom() {
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  const removeAllRanges = vi.fn();
  const fakeWindow: FakeWindow = {
    listeners,
    addEventListener(type, listener) {
      const set = listeners.get(type) ?? new Set();
      set.add(listener);
      listeners.set(type, set);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    dispatch(type, event) {
      const snapshot = Array.from(listeners.get(type) ?? []);
      for (const listener of snapshot) {
        listener(event);
      }
    },
    setTimeout,
    clearTimeout,
    getSelection: () => ({ removeAllRanges }),
  };

  const fakeDocument = {
    body: {
      dataset: {} as Record<string, string | undefined>,
    },
  };

  vi.stubGlobal("window", fakeWindow);
  vi.stubGlobal("document", fakeDocument);
  return { fakeWindow, fakeDocument, removeAllRanges };
}

function fakeElement(left: number, width: number, isConnected = true): HTMLElement {
  return {
    isConnected,
    getBoundingClientRect: () =>
      ({
        left,
        right: left + width,
        width,
        top: 0,
        bottom: 28,
        height: 28,
        x: left,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect,
  } as unknown as HTMLElement;
}

function pointerEvent(clientX: number, clientY = 14, overrides: Record<string, unknown> = {}) {
  return {
    button: 0,
    clientX,
    clientY,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    defaultPrevented: false,
    target: { closest: () => null } as unknown as EventTarget,
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createTabDragController", () => {
  it("reorders result tabs on drag and drop, suppresses the trailing click, and cleans up", () => {
    const { fakeWindow, fakeDocument, removeAllRanges } = installFakeDom();
    const reorders: Array<[string, string, string]> = [];
    const states: TabDragState[] = [];
    const list = {
      scrollLeft: 20,
      getBoundingClientRect: () => ({ left: 0, right: 320 }),
    } as unknown as HTMLElement;

    const controller = createTabDragController({
      getDisabled: () => false,
      getList: () => list,
      onReorder: (activeId, targetId, placement) => reorders.push([activeId, targetId, placement]),
      onStateChange: (state) => states.push(state),
    });

    const refResult1 = controller.registerRef("cursor-1");
    expect(controller.registerRef("cursor-1")).toBe(refResult1);

    refResult1(fakeElement(10, 80));
    controller.registerRef("cursor-2")(fakeElement(92, 80));
    controller.registerRef("messages")(fakeElement(174, 80));

    controller.startTracking("cursor-1", pointerEvent(40, 14));

    // Movement below threshold does not initiate dragging.
    fakeWindow.dispatch("pointermove", { clientX: 43, clientY: 14 });
    expect(fakeDocument.body.dataset.tabDragging).toBeUndefined();
    expect(states).toEqual([]);

    // Dragging over the right half of Messages selects Messages as an "after" target.
    fakeWindow.dispatch("pointermove", { clientX: 230, clientY: 14 });
    expect(fakeDocument.body.dataset.tabDragging).toBe("true");
    expect(removeAllRanges).toHaveBeenCalledTimes(1);
    expect(states.at(-1)).toEqual({
      draggingId: "cursor-1",
      dropTarget: { id: "messages", placement: "after" },
    });

    fakeWindow.dispatch("pointerup", {});
    expect(reorders).toEqual([["cursor-1", "messages", "after"]]);
    expect(fakeDocument.body.dataset.tabDragging).toBeUndefined();
    expect(fakeWindow.listeners.get("pointermove")?.size ?? 0).toBe(0);

    // Trailing click fired right after pointerup is suppressed.
    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();
    controller.handleClickCapture({ preventDefault, stopPropagation });
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(stopPropagation).toHaveBeenCalledTimes(1);

    // Native browser dragstart is always blocked on tabs.
    const preventNativeDrag = vi.fn();
    controller.handleDragStart({ preventDefault: preventNativeDrag });
    expect(preventNativeDrag).toHaveBeenCalledTimes(1);

    controller.dispose();
  });

  it("cancels drag cleanly on Escape, defaultPrevented pointerdown, or disable mid-drag", () => {
    const { fakeWindow, fakeDocument } = installFakeDom();
    let disabled = false;
    const reorders: Array<[string, string, string]> = [];

    const controller = createTabDragController({
      getDisabled: () => disabled,
      getList: () => null,
      onReorder: (activeId, targetId, placement) => reorders.push([activeId, targetId, placement]),
      onStateChange: () => {},
    });

    controller.registerRef("cursor-1")(fakeElement(10, 80));
    controller.registerRef("cursor-2")(fakeElement(92, 80));

    // Ignores pointerdown already claimed (for example by a panel resize handle).
    controller.startTracking("cursor-1", pointerEvent(40, 14, { defaultPrevented: true }));
    expect(fakeWindow.listeners.get("pointermove")?.size ?? 0).toBe(0);

    // Escape cancels without committing reorder.
    controller.startTracking("cursor-1", pointerEvent(40, 14));
    fakeWindow.dispatch("pointermove", { clientX: 150, clientY: 14 });
    expect(fakeDocument.body.dataset.tabDragging).toBe("true");
    const preventEscape = vi.fn();
    fakeWindow.dispatch("keydown", { key: "Escape", preventDefault: preventEscape });
    expect(preventEscape).toHaveBeenCalledTimes(1);
    expect(reorders).toEqual([]);
    expect(fakeDocument.body.dataset.tabDragging).toBeUndefined();
    expect(fakeWindow.listeners.get("pointermove")?.size ?? 0).toBe(0);

    // Cancelling mid-drag removes window listeners immediately.
    controller.startTracking("cursor-1", pointerEvent(40, 14));
    fakeWindow.dispatch("pointermove", { clientX: 150, clientY: 14 });
    disabled = true;
    controller.cancel();
    expect(fakeDocument.body.dataset.tabDragging).toBeUndefined();
    expect(fakeWindow.listeners.get("pointermove")?.size ?? 0).toBe(0);
    expect(reorders).toEqual([]);

    controller.dispose();
  });
});
