import { describe, expect, it } from "vite-plus/test";

import {
  applyResultStart,
  beginQueryActivity,
  finishQueryActivity,
  idle,
  removeResultTabs,
  updateTabFilePath,
  type Activity,
} from "@/features/use-workspace";
import type { SavedTab, SessionInfo } from "@/ipc/bindings/protocol";

const session: SessionInfo = {
  id: "session-1",
  version: "PostgreSQL 17.0",
  database: "pagila",
  schema: "public",
  elapsedMs: 12,
};

const column = {
  name: "id",
  db_type: "int4",
  kind: "int",
  nullable: false,
  table_oid: null,
  column_id: null,
};

function activityWithOneResult(): Activity {
  const started = beginQueryActivity(idle, session, false);
  const withResult = applyResultStart(started, {
    type: "resultStart",
    cursorId: "cursor-1",
    resultIndex: 0,
    columns: [column],
    rows: [[1]],
  });
  return {
    ...withResult,
    results: withResult.results.map((item) => ({ ...item, more: true })),
    messages: [{ level: "info", text: "1 statements completed · 5 ms" }],
    elapsed: 5,
  };
}

describe("result tab activity transitions", () => {
  it("opens results in a new numbered tab and selects it when keepResults is enabled", () => {
    const initial = activityWithOneResult();
    const running = beginQueryActivity(initial, session, true);
    expect(running.results).toHaveLength(1);
    expect(running.results[0]?.more).toBe(false);
    expect(running.selected).toBe("cursor-1");

    const next = applyResultStart(running, {
      type: "resultStart",
      cursorId: "cursor-2",
      resultIndex: 0,
      columns: [column],
      rows: [[2]],
    });
    expect(next.results.map((item) => [item.id, item.index])).toEqual([
      ["cursor-1", 0],
      ["cursor-2", 1],
    ]);
    expect(next.selected).toBe("cursor-2");

    // A second result set from the same run appends without overriding selection.
    const multi = applyResultStart(next, {
      type: "resultStart",
      cursorId: "cursor-3",
      resultIndex: 1,
      columns: [column],
      rows: [[3]],
    });
    expect(multi.results.map((item) => [item.id, item.index])).toEqual([
      ["cursor-1", 0],
      ["cursor-2", 1],
      ["cursor-3", 2],
    ]);
    expect(multi.selected).toBe("cursor-2");
  });

  it("replaces previous results on a normal run", () => {
    const initial = activityWithOneResult();
    const running = beginQueryActivity(initial, session, false);
    expect(running.results).toEqual([]);
    expect(running.selected).toBeNull();

    const next = applyResultStart(running, {
      type: "resultStart",
      cursorId: "cursor-2",
      resultIndex: 0,
      columns: [column],
      rows: [[2]],
    });
    expect(next.results.map((item) => [item.id, item.index])).toEqual([["cursor-2", 0]]);
    expect(next.selected).toBe("cursor-2");
  });

  it("shows messages when a keepResults run finishes without result sets, unless cancelled", () => {
    const initial = activityWithOneResult();
    const running = beginQueryActivity(initial, session, true);

    const finished = finishQueryActivity(
      running,
      { type: "done", statements: 1, elapsedMs: 14 },
      { keepResults: true, resultSets: 0, cancelled: false },
    );
    expect(finished.results).toHaveLength(1);
    expect(finished.selected).toBe("messages");

    const cancelled = finishQueryActivity(
      running,
      { type: "done", statements: 0, elapsedMs: 14 },
      { keepResults: true, resultSets: 0, cancelled: true },
    );
    expect(cancelled.selected).toBe("cursor-1");
  });

  it("closes individual result tabs, adjusts selection, and avoids reusing active numbers", () => {
    const first = activityWithOneResult();
    const second = applyResultStart(beginQueryActivity(first, session, true), {
      type: "resultStart",
      cursorId: "cursor-2",
      resultIndex: 0,
      columns: [column],
      rows: [[2]],
    });

    // Closing an unselected tab keeps the current selection.
    const afterClosingFirst = removeResultTabs(second, ["cursor-1"]);
    expect(afterClosingFirst.results.map((item) => item.id)).toEqual(["cursor-2"]);
    expect(afterClosingFirst.selected).toBe("cursor-2");

    // Reordering results still assigns a unique next index past the highest active index.
    const reordered: Activity = {
      ...second,
      results: [...second.results].reverse(),
    };
    const afterReorder = applyResultStart(beginQueryActivity(reordered, session, true), {
      type: "resultStart",
      cursorId: "cursor-3",
      resultIndex: 0,
      columns: [column],
      rows: [[3]],
    });
    expect(afterReorder.results.map((item) => [item.id, item.index])).toEqual([
      ["cursor-2", 1],
      ["cursor-1", 0],
      ["cursor-3", 2],
    ]);

    // Closing the selected last tab falls back to the previous result, then Messages.
    const afterClosingThird = removeResultTabs(afterReorder, ["cursor-3"]);
    expect(afterClosingThird.selected).toBe("cursor-1");

    const afterClosingAll = removeResultTabs(afterClosingThird, ["cursor-1", "cursor-2"]);
    expect(afterClosingAll.results).toEqual([]);
    expect(afterClosingAll.selected).toBe("messages");
  });

  it("applies custom result titles when running named queries in a new result tab", () => {
    const initial = activityWithOneResult();
    const running = beginQueryActivity(initial, session, true);

    const first = applyResultStart(
      running,
      {
        type: "resultStart",
        cursorId: "cursor-2",
        resultIndex: 0,
        columns: [column],
        rows: [[2]],
      },
      "  Active users  ",
    );
    expect(first.results[1]?.title).toBe("Active users");
    expect(first.selected).toBe("cursor-2");

    const second = applyResultStart(
      first,
      {
        type: "resultStart",
        cursorId: "cursor-3",
        resultIndex: 1,
        columns: [column],
        rows: [[3]],
      },
      "Active users",
    );
    expect(second.results[2]?.title).toBe("Active users (2)");
    expect(second.selected).toBe("cursor-2");
  });
});

describe("tab file path persistence helper", () => {
  it("stores, updates, and clears a tab file path without mutating unrelated tabs", () => {
    const tabs: SavedTab[] = [
      { id: "t1", connectionId: "c1", text: "SELECT 1;" },
      { id: "t2", connectionId: "c1", text: "SELECT 2;" },
    ];

    const linked = updateTabFilePath(tabs, "t1", "/home/ada/Documents/Strata/report.sql");
    expect(linked[0]?.filePath).toBe("/home/ada/Documents/Strata/report.sql");
    expect(linked[1]).toBe(tabs[1]);

    // Re-saving to the same path is a no-op and preserves reference equality.
    expect(updateTabFilePath(linked, "t1", " /home/ada/Documents/Strata/report.sql ")).toBe(linked);

    // Save As updates only the targeted tab to the new file path.
    const moved = updateTabFilePath(linked, "t1", "/home/ada/Documents/Strata/report_v2.sql");
    expect(moved[0]?.filePath).toBe("/home/ada/Documents/Strata/report_v2.sql");

    // Clearing removes the optional field cleanly.
    const cleared = updateTabFilePath(moved, "t1", "   ");
    expect("filePath" in (cleared[0] ?? {})).toBe(false);
  });
});
