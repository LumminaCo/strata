import { expect, test, vi } from "vite-plus/test";

import type { RunEvent } from "./bindings/protocol";
import { runQuery } from "./client";

const { nativeInvoke } = vi.hoisted(() => ({
  nativeInvoke: vi
    .fn<
      (
        command: string,
        args: { channel: { onmessage: (event: RunEvent) => void } },
      ) => Promise<void>
    >()
    .mockResolvedValue(undefined),
}));

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => true,
  invoke: nativeInvoke,
  Channel: class {},
}));

test("waits for delayed Tauri channel frames after invoke resolves", async () => {
  const receive = vi.fn();
  const complete = vi.fn();
  const running = runQuery(
    {
      runId: "query",
      sessionId: "session",
      text: "SELECT 1",
      target: { cursor: 0 },
      mode: "statement",
      confirmed: false,
    },
    receive,
  ).then(complete);

  const channel = nativeInvoke.mock.calls[0]?.[1].channel;
  expect(channel).toBeDefined();
  await Promise.resolve();
  expect(complete).not.toHaveBeenCalled();

  const rows = { type: "rows", cursorId: "cursor", rows: [[1]] } satisfies RunEvent;
  channel?.onmessage(rows);
  expect(receive).toHaveBeenCalledWith(rows);
  expect(complete).not.toHaveBeenCalled();

  channel?.onmessage({ type: "done", elapsedMs: 1, statements: 1 });
  await running;
  expect(complete).toHaveBeenCalledOnce();
});
