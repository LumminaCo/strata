import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { ResultSet } from "@/components/result-grid";
import {
  MessagesTabItem,
  ResultTabItem,
  ScriptTabItem,
  type TabDragBindings,
} from "@/features/tab-controls";
import {
  MAX_TAB_TITLE_LENGTH,
  MESSAGES_TAB_ID,
  computeDropTarget,
  defaultResultTabLabel,
  defaultScriptTabLabel,
  moveItemByOffset,
  normalizeTabTitle,
  reorderById,
  reorderByOrder,
  reorderItems,
  resolveResultPanelOrder,
  resultTabLabel,
  scriptTabLabel,
} from "@/features/tab-order";
import type { Connection, SavedTab } from "@/ipc/bindings/protocol";

const idleDragProps: TabDragBindings = {
  ref: () => {},
  onPointerDown: () => {},
  onClickCapture: () => {},
  onDragStart: () => {},
  "data-dragging": undefined,
  "data-drop-position": undefined,
};

function sampleConnection(overrides: Partial<Connection> = {}): Connection {
  return {
    id: "conn-1",
    name: "Analytics",
    kind: "postgres",
    env: "dev",
    color: null,
    folder: null,
    host: "localhost",
    port: 5432,
    database: "pagila",
    user: "strata",
    secret: "prompt",
    readOnly: false,
    agentAccess: "none",
    allowAgentDdl: false,
    options: null,
    tls: "prefer",
    ...overrides,
  };
}

function sampleTab(id: string, overrides: Partial<SavedTab> = {}): SavedTab {
  return {
    id,
    connectionId: "conn-1",
    text: "SELECT 1;",
    ...overrides,
  };
}

function sampleResult(id: string, index: number, overrides: Partial<ResultSet> = {}): ResultSet {
  return {
    id,
    index,
    columns: [],
    rows: [],
    more: false,
    capped: false,
    ...overrides,
  };
}

describe("tab title normalization and labels", () => {
  it("normalizes whitespace, clears empty titles, and caps length", () => {
    expect(normalizeTabTitle("   ")).toBeUndefined();
    expect(normalizeTabTitle("  Monthly\n\tRevenue  ")).toBe("Monthly Revenue");
    expect(normalizeTabTitle("a".repeat(MAX_TAB_TITLE_LENGTH + 25))).toHaveLength(
      MAX_TAB_TITLE_LENGTH,
    );
  });

  it("formats script tab labels using custom title when present and connection numbering otherwise", () => {
    const first = sampleTab("t1");
    const second = sampleTab("t2", { title: "Customer cohorts" });
    const third = sampleTab("t3");
    const orphan = sampleTab("t4", { connectionId: "missing" });
    const tabs = [first, second, third, orphan];

    expect(defaultScriptTabLabel(tabs, first, "Analytics")).toBe("Analytics");
    expect(scriptTabLabel(tabs, first, "Analytics")).toBe("Analytics");
    expect(defaultScriptTabLabel(tabs, second, "Analytics")).toBe("Analytics 2");
    expect(scriptTabLabel(tabs, second, "Analytics")).toBe("Customer cohorts");
    expect(scriptTabLabel(tabs, third, "Analytics")).toBe("Analytics 3");
    expect(scriptTabLabel(tabs, orphan, undefined)).toBe("Deleted connection");
  });

  it("formats result tab labels preserving original result index unless renamed", () => {
    const first = sampleResult("r1", 0);
    const second = sampleResult("r2", 1, { title: "Active users" });
    const blank = sampleResult("r3", 2, { title: "   " });

    expect(defaultResultTabLabel(first)).toBe("Result 1");
    expect(resultTabLabel(first)).toBe("Result 1");
    expect(defaultResultTabLabel(second)).toBe("Result 2");
    expect(resultTabLabel(second)).toBe("Active users");
    expect(resultTabLabel(blank)).toBe("Result 3");
  });
});

describe("tab reordering helpers", () => {
  it("reorders by index and returns the same reference on invalid or no-op moves", () => {
    const list = ["a", "b", "c", "d"];
    expect(reorderItems(list, 0, 2)).toEqual(["b", "c", "a", "d"]);
    expect(reorderItems(list, 3, 1)).toEqual(["a", "d", "b", "c"]);
    expect(reorderItems(list, 1, 1)).toBe(list);
    expect(reorderItems(list, -1, 2)).toBe(list);
    expect(reorderItems(list, 0, 99)).toBe(list);
  });

  it("reorders by id with before/after placement across both directions", () => {
    const items = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];
    const getId = (item: { id: string }) => item.id;

    expect(reorderById(items, "a", "c", "after", getId).map(getId)).toEqual(["b", "c", "a", "d"]);
    expect(reorderById(items, "a", "c", "before", getId).map(getId)).toEqual(["b", "a", "c", "d"]);
    expect(reorderById(items, "d", "b", "before", getId).map(getId)).toEqual(["a", "d", "b", "c"]);
    expect(reorderById(items, "d", "b", "after", getId).map(getId)).toEqual(["a", "b", "d", "c"]);

    // Adjacent no-op placements keep the exact original reference.
    expect(reorderById(items, "a", "b", "before", getId)).toBe(items);
    expect(reorderById(items, "b", "a", "after", getId)).toBe(items);
    expect(reorderById(items, "b", "b", "after", getId)).toBe(items);
  });

  it("shifts items left and right within bounds", () => {
    const items = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const getId = (item: { id: string }) => item.id;

    expect(moveItemByOffset(items, "b", -1, getId).map(getId)).toEqual(["b", "a", "c"]);
    expect(moveItemByOffset(items, "b", 1, getId).map(getId)).toEqual(["a", "c", "b"]);
    expect(moveItemByOffset(items, "a", -1, getId)).toBe(items);
    expect(moveItemByOffset(items, "c", 1, getId)).toBe(items);
  });

  it("computes horizontal drop targets and suppresses no-op indicators", () => {
    const rects = [
      { id: "a", left: 0, width: 100 },
      { id: "b", left: 104, width: 100 },
      { id: "c", left: 208, width: 100 },
    ];

    // Dragging "a": hovering over "a" or left half of "b" is a no-op.
    expect(computeDropTarget(50, "a", rects)).toBeNull();
    expect(computeDropTarget(120, "a", rects)).toBeNull();
    // Right half of "b" drops after "b".
    expect(computeDropTarget(180, "a", rects)).toEqual({ id: "b", placement: "after" });
    // Past the right edge drops after "c".
    expect(computeDropTarget(400, "a", rects)).toEqual({ id: "c", placement: "after" });

    // Dragging "c": left of the first tab drops before "a".
    expect(computeDropTarget(-20, "c", rects)).toEqual({ id: "a", placement: "before" });
    // Left half of "b" drops before "b", right half of "b" is a no-op.
    expect(computeDropTarget(120, "c", rects)).toEqual({ id: "b", placement: "before" });
    expect(computeDropTarget(190, "c", rects)).toBeNull();
  });

  it("syncs item arrays to an explicit order and keeps reference when already ordered", () => {
    const items = [
      { id: "cursor-1", name: "Result 1" },
      { id: "cursor-2", name: "Result 2" },
      { id: "cursor-3", name: "Result 3" },
    ];
    const getId = (item: { id: string }) => item.id;

    expect(reorderByOrder(items, ["cursor-1", "pinned:users", "cursor-2", "cursor-3"], getId)).toBe(
      items,
    );
    expect(
      reorderByOrder(items, ["cursor-3", "messages", "cursor-1", "cursor-2"], getId).map(getId),
    ).toEqual(["cursor-3", "cursor-1", "cursor-2"]);
  });

  it("resolves unified result panel order across results, pinned inspections, and Messages", () => {
    const pinnedUsers = JSON.stringify(["conn-1", "pagila", "public", 101, "users"]);
    const pinnedOrders = JSON.stringify(["conn-1", "pagila", "public", 102, "orders"]);

    // Default order places results, then pinned inspections, then Messages.
    expect(resolveResultPanelOrder(undefined, ["cursor-1", "cursor-2"], [pinnedUsers])).toEqual([
      "cursor-1",
      "cursor-2",
      pinnedUsers,
      MESSAGES_TAB_ID,
    ]);

    // Preserves custom order when dragging results past pinned inspections and Messages.
    const customOrder = [pinnedUsers, MESSAGES_TAB_ID, "cursor-2", "cursor-1"];
    expect(resolveResultPanelOrder(customOrder, ["cursor-1", "cursor-2"], [pinnedUsers])).toEqual(
      customOrder,
    );

    // Appends a new result tab (Ctrl+Shift+Enter) right after the last existing result tab.
    expect(
      resolveResultPanelOrder(customOrder, ["cursor-1", "cursor-2", "cursor-3"], [pinnedUsers]),
    ).toEqual([pinnedUsers, MESSAGES_TAB_ID, "cursor-2", "cursor-1", "cursor-3"]);

    // Appends a newly pinned table inspection right after the last pinned tab.
    expect(
      resolveResultPanelOrder(customOrder, ["cursor-1", "cursor-2"], [pinnedUsers, pinnedOrders]),
    ).toEqual([pinnedUsers, pinnedOrders, MESSAGES_TAB_ID, "cursor-2", "cursor-1"]);

    // Replaces old results on a normal run while preserving pinned and Messages order.
    expect(resolveResultPanelOrder(customOrder, ["cursor-9"], [pinnedUsers])).toEqual([
      "cursor-9",
      pinnedUsers,
      MESSAGES_TAB_ID,
    ]);
  });
});

describe("tab control rendering", () => {
  it("renders script tab with custom title tooltip and inline rename input when renaming", () => {
    const connection = sampleConnection();
    const tab = sampleTab("t1", { title: "Invoices" });

    const normalMarkup = renderToStaticMarkup(
      <ScriptTabItem
        tab={tab}
        connection={connection}
        label="Invoices"
        defaultLabel="Analytics"
        active
        renaming={false}
        canMoveLeft={false}
        canMoveRight
        canCloseOthers
        canCloseRight
        closeShortcut="Ctrl+W"
        dragProps={{ ...idleDragProps, "data-drop-position": "after" }}
        onSelect={() => {}}
        onStartRename={() => {}}
        onCommitRename={() => {}}
        onCancelRename={() => {}}
        onResetName={() => {}}
        onMoveLeft={() => {}}
        onMoveRight={() => {}}
        onDuplicate={() => {}}
        onClose={() => {}}
        onCloseOthers={() => {}}
        onCloseRight={() => {}}
      />,
    );

    expect(normalMarkup).toContain("Invoices");
    expect(normalMarkup).toContain('title="Invoices (Analytics)"');
    expect(normalMarkup).toContain('data-drop-position="after"');
    expect(normalMarkup).toContain('data-slot="context-menu-trigger"');

    const renameMarkup = renderToStaticMarkup(
      <ScriptTabItem
        tab={tab}
        connection={connection}
        label="Invoices"
        defaultLabel="Analytics"
        active
        renaming
        canMoveLeft={false}
        canMoveRight
        canCloseOthers
        canCloseRight
        closeShortcut="Ctrl+W"
        dragProps={idleDragProps}
        onSelect={() => {}}
        onStartRename={() => {}}
        onCommitRename={() => {}}
        onCancelRename={() => {}}
        onResetName={() => {}}
        onMoveLeft={() => {}}
        onMoveRight={() => {}}
        onDuplicate={() => {}}
        onClose={() => {}}
        onCloseOthers={() => {}}
        onCloseRight={() => {}}
      />,
    );

    expect(renameMarkup).toContain('class="tab-rename-input"');
    expect(renameMarkup).toContain('value="Invoices"');
    expect(renameMarkup).toContain('placeholder="Analytics"');
    expect(renameMarkup).toContain('data-no-drag="true"');
    expect(normalMarkup).not.toContain('class="unsaved-dot"');
    expect(normalMarkup).not.toContain('data-unsaved="true"');
  });

  it("renders a white unsaved dot on the left side of unsaved script tabs", () => {
    const connection = sampleConnection();
    const tab = sampleTab("t1", { title: "Invoices" });

    const unsavedMarkup = renderToStaticMarkup(
      <ScriptTabItem
        tab={tab}
        connection={connection}
        label="Invoices"
        defaultLabel="Analytics"
        active
        unsaved
        renaming={false}
        canMoveLeft={false}
        canMoveRight
        canCloseOthers
        canCloseRight
        closeShortcut="Ctrl+W"
        dragProps={idleDragProps}
        onSelect={() => {}}
        onStartRename={() => {}}
        onCommitRename={() => {}}
        onCancelRename={() => {}}
        onResetName={() => {}}
        onMoveLeft={() => {}}
        onMoveRight={() => {}}
        onDuplicate={() => {}}
        onClose={() => {}}
        onCloseOthers={() => {}}
        onCloseRight={() => {}}
      />,
    );

    expect(unsavedMarkup).toContain('data-unsaved="true"');
    expect(unsavedMarkup).toContain('title="Invoices (Analytics) · Unsaved"');
    expect(unsavedMarkup).toContain('<span class="unsaved-dot" aria-hidden="true"></span>');
    expect(unsavedMarkup).toContain('<span class="sr-only"> (unsaved)</span>');
    expect(unsavedMarkup.indexOf('class="unsaved-dot"')).toBeLessThan(
      unsavedMarkup.indexOf("db-icon"),
    );

    const renamingUnsavedMarkup = renderToStaticMarkup(
      <ScriptTabItem
        tab={tab}
        connection={connection}
        label="Invoices"
        defaultLabel="Analytics"
        active
        unsaved
        renaming
        canMoveLeft={false}
        canMoveRight
        canCloseOthers
        canCloseRight
        closeShortcut="Ctrl+W"
        dragProps={idleDragProps}
        onSelect={() => {}}
        onStartRename={() => {}}
        onCommitRename={() => {}}
        onCancelRename={() => {}}
        onResetName={() => {}}
        onMoveLeft={() => {}}
        onMoveRight={() => {}}
        onDuplicate={() => {}}
        onClose={() => {}}
        onCloseOthers={() => {}}
        onCloseRight={() => {}}
      />,
    );

    expect(renamingUnsavedMarkup).toContain('data-unsaved="true"');
    expect(renamingUnsavedMarkup.indexOf('class="unsaved-dot"')).toBeLessThan(
      renamingUnsavedMarkup.indexOf("db-icon"),
    );

    const linkedTab = sampleTab("t2", {
      title: "Invoices",
      filePath: "/home/ada/Documents/Strata/invoices.sql",
    });
    const linkedMarkup = renderToStaticMarkup(
      <ScriptTabItem
        tab={linkedTab}
        connection={connection}
        label="Invoices"
        defaultLabel="Analytics"
        active
        unsaved={false}
        renaming={false}
        canMoveLeft={false}
        canMoveRight
        canCloseOthers
        canCloseRight
        closeShortcut="Ctrl+W"
        dragProps={idleDragProps}
        onSelect={() => {}}
        onStartRename={() => {}}
        onCommitRename={() => {}}
        onCancelRename={() => {}}
        onResetName={() => {}}
        onMoveLeft={() => {}}
        onMoveRight={() => {}}
        onDuplicate={() => {}}
        onClose={() => {}}
        onCloseOthers={() => {}}
        onCloseRight={() => {}}
      />,
    );
    expect(linkedMarkup).toContain(
      'title="Invoices (Analytics) · /home/ada/Documents/Strata/invoices.sql"',
    );
  });

  it("renders result tab with custom label and inline rename input", () => {
    const result = sampleResult("r1", 1, { title: "Top customers" });

    const normalMarkup = renderToStaticMarkup(
      <ResultTabItem
        result={result}
        label="Top customers"
        defaultLabel="Result 2"
        active
        renaming={false}
        fetching={false}
        canMoveLeft
        canMoveRight={false}
        canCloseOthers
        dragProps={{ ...idleDragProps, "data-dragging": "true" }}
        onSelect={() => {}}
        onStartRename={() => {}}
        onCommitRename={() => {}}
        onCancelRename={() => {}}
        onResetName={() => {}}
        onMoveLeft={() => {}}
        onMoveRight={() => {}}
        onClose={() => {}}
        onCloseOthers={() => {}}
      />,
    );

    expect(normalMarkup).toContain("Top customers");
    expect(normalMarkup).toContain('title="Top customers (Result 2)"');
    expect(normalMarkup).toContain('data-dragging="true"');

    const renameMarkup = renderToStaticMarkup(
      <ResultTabItem
        result={result}
        label="Top customers"
        defaultLabel="Result 2"
        active
        renaming
        fetching={false}
        canMoveLeft
        canMoveRight={false}
        canCloseOthers
        dragProps={idleDragProps}
        onSelect={() => {}}
        onStartRename={() => {}}
        onCommitRename={() => {}}
        onCancelRename={() => {}}
        onResetName={() => {}}
        onMoveLeft={() => {}}
        onMoveRight={() => {}}
        onClose={() => {}}
        onCloseOthers={() => {}}
      />,
    );

    expect(renameMarkup).toContain('class="tab-rename-input"');
    expect(renameMarkup).toContain('value="Top customers"');
    expect(renameMarkup).toContain('placeholder="Result 2"');
  });

  it("renders Messages tab with draggable result-tab wrapper and drop indicator attributes", () => {
    const markup = renderToStaticMarkup(
      <MessagesTabItem
        active
        canMoveLeft
        canMoveRight={false}
        dragProps={{ ...idleDragProps, "data-drop-position": "before" }}
        onSelect={() => {}}
        onMoveLeft={() => {}}
        onMoveRight={() => {}}
      />,
    );

    expect(markup).toContain("Messages");
    expect(markup).toContain('class="result-tab"');
    expect(markup).toContain('data-drop-position="before"');
    expect(markup).toContain('data-slot="context-menu-trigger"');
    expect(markup).toContain('aria-selected="true"');
  });
});
