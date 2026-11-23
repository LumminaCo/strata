import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  QueryNotificationStack,
  appendQueryToast,
  formatElapsed,
  formatQueryToastDetail,
  formatQueryToastTitle,
  type QueryCompletion,
} from "@/features/query-notifications";
import {
  playQuerySound,
  primeQuerySound,
  resetQuerySoundForTest,
  type QueryAudioContext,
} from "@/features/query-sound";

function sampleCompletion(overrides: Partial<QueryCompletion> = {}): QueryCompletion {
  return {
    id: "run-1",
    tabId: "tab-1",
    tabLabel: "Analytics",
    connectionName: "Analytics",
    connectionKind: "postgres",
    connectionEnv: "dev",
    database: "pagila",
    mode: "statement",
    status: "success",
    statements: 1,
    rows: 1_250,
    affectedRows: 0,
    resultSets: 1,
    elapsedMs: 1_420,
    ...overrides,
  };
}

function createFakeAudioContext(state: AudioContextState = "running") {
  const oscillators: Array<{
    type: OscillatorType;
    frequencies: Array<{ value: number; time: number }>;
    startedAt: number | undefined;
    stoppedAt: number | undefined;
    disconnected: boolean;
    onended: (() => void) | null;
  }> = [];
  const gains: Array<{
    events: Array<{ kind: string; value: number; time: number }>;
    disconnected: boolean;
  }> = [];
  let currentState = state;
  const resume = vi.fn(async () => {
    currentState = "running";
  });

  const ctx = {
    get currentTime() {
      return 10;
    },
    get state() {
      return currentState;
    },
    destination: {
      connect: vi.fn(),
      disconnect: vi.fn(),
    },
    resume,
    createOscillator() {
      const record = {
        type: "sine" as OscillatorType,
        frequencies: [] as Array<{ value: number; time: number }>,
        startedAt: undefined as number | undefined,
        stoppedAt: undefined as number | undefined,
        disconnected: false,
        onended: null as (() => void) | null,
      };
      oscillators.push(record);
      return {
        get type() {
          return record.type;
        },
        set type(next: OscillatorType) {
          record.type = next;
        },
        frequency: {
          setValueAtTime(value: number, startTime: number) {
            record.frequencies.push({ value, time: startTime });
          },
        },
        get onended() {
          return record.onended;
        },
        set onended(fn: (() => void) | null) {
          record.onended = fn;
        },
        connect: vi.fn(),
        disconnect() {
          record.disconnected = true;
        },
        start(when?: number) {
          record.startedAt = when;
        },
        stop(when?: number) {
          record.stoppedAt = when;
        },
      };
    },
    createGain() {
      const record = {
        events: [] as Array<{ kind: string; value: number; time: number }>,
        disconnected: false,
      };
      gains.push(record);
      return {
        gain: {
          setValueAtTime(value: number, startTime: number) {
            record.events.push({ kind: "set", value, time: startTime });
          },
          linearRampToValueAtTime(value: number, endTime: number) {
            record.events.push({ kind: "linear", value, time: endTime });
          },
          exponentialRampToValueAtTime(value: number, endTime: number) {
            record.events.push({ kind: "exp", value, time: endTime });
          },
        },
        connect: vi.fn(),
        disconnect() {
          record.disconnected = true;
        },
      };
    },
  } as unknown as QueryAudioContext;

  return { ctx, oscillators, gains, resume };
}

afterEach(() => {
  resetQuerySoundForTest();
});

describe("query notification helpers", () => {
  it("formats elapsed durations cleanly across ms, seconds, and minutes", () => {
    expect(formatElapsed(0)).toBe("0 ms");
    expect(formatElapsed(428)).toBe("428 ms");
    expect(formatElapsed(1_420)).toBe("1.42 s");
    expect(formatElapsed(14_830)).toBe("14.8 s");
    expect(formatElapsed(60_000)).toBe("1m");
    expect(formatElapsed(135_000)).toBe("2m 15s");
  });

  it("formats titles and details for statement, script, explain, and error completions", () => {
    expect(formatQueryToastTitle({ mode: "statement", status: "success" })).toBe("Query finished");
    expect(formatQueryToastTitle({ mode: "script", status: "success" })).toBe("Script finished");
    expect(formatQueryToastTitle({ mode: "explain", status: "error" })).toBe("Explain failed");

    expect(formatQueryToastDetail(sampleCompletion())).toBe("1,250 rows returned");
    expect(formatQueryToastDetail(sampleCompletion({ rows: 1, resultSets: 1 }))).toBe(
      "1 row returned",
    );
    expect(
      formatQueryToastDetail(sampleCompletion({ rows: 40, resultSets: 2, statements: 2 })),
    ).toBe("40 rows returned · 2 result sets · 2 statements");
    expect(
      formatQueryToastDetail(
        sampleCompletion({ rows: 0, resultSets: 0, affectedRows: 12, statements: 1 }),
      ),
    ).toBe("12 rows affected");
    expect(
      formatQueryToastDetail(
        sampleCompletion({ rows: 0, resultSets: 0, affectedRows: 0, statements: 3 }),
      ),
    ).toBe("3 statements");
    expect(
      formatQueryToastDetail(
        sampleCompletion({ status: "error", errorMessage: 'relation "missing" does not exist' }),
      ),
    ).toBe('relation "missing" does not exist');
  });

  it("caps stacked toasts to the configured limit while deduplicating ids", () => {
    let list: QueryCompletion[] = [];
    list = appendQueryToast(list, sampleCompletion({ id: "1" }), 3);
    list = appendQueryToast(list, sampleCompletion({ id: "2" }), 3);
    list = appendQueryToast(list, sampleCompletion({ id: "3" }), 3);
    list = appendQueryToast(list, sampleCompletion({ id: "4" }), 3);
    expect(list.map((item) => item.id)).toEqual(["2", "3", "4"]);

    list = appendQueryToast(list, sampleCompletion({ id: "3", elapsedMs: 999 }), 3);
    expect(list.map((item) => item.id)).toEqual(["2", "4", "3"]);
    expect(list[2]?.elapsedMs).toBe(999);
  });
});

describe("QueryNotificationStack rendering", () => {
  it("renders success and error toasts with View tab only for background tabs", () => {
    const markup = renderToStaticMarkup(
      <QueryNotificationStack
        activeTabId="tab-1"
        notice="MCP configuration copied."
        onDismissNotice={() => {}}
        onDismissNotification={() => {}}
        onViewTab={() => {}}
        notifications={[
          sampleCompletion({ id: "a", tabId: "tab-1", tabLabel: "Primary" }),
          sampleCompletion({
            id: "b",
            tabId: "tab-2",
            tabLabel: "Reporting 2",
            connectionKind: "sqlserver",
            connectionEnv: "prod",
            status: "error",
            mode: "script",
            elapsedMs: 5_210,
            errorMessage: "Statement timeout exceeded",
          }),
        ]}
      />,
    );

    expect(markup).toContain('class="notification-stack"');
    expect(markup).toContain("MCP configuration copied.");
    expect(markup).toContain("Query finished");
    expect(markup).toContain("1.42 s");
    expect(markup).toContain("1,250 rows returned");
    expect(markup).toContain("Script failed");
    expect(markup).toContain("5.21 s");
    expect(markup).toContain("Statement timeout exceeded");
    expect(markup).toContain('data-status="success"');
    expect(markup).toContain('data-status="error"');
    // Only the background tab ("tab-2") gets the "View tab" button.
    expect(markup.match(/View tab/g)?.length).toBe(1);
  });

  it("renders nothing when there are no notifications or notices", () => {
    const markup = renderToStaticMarkup(
      <QueryNotificationStack
        activeTabId="tab-1"
        notice=""
        onDismissNotice={() => {}}
        onDismissNotification={() => {}}
        onViewTab={() => {}}
        notifications={[]}
      />,
    );
    expect(markup).toBe("");
  });
});

describe("query completion audio", () => {
  it("synthesizes a two-note chime with overtones for success and disconnects nodes on end", () => {
    const fake = createFakeAudioContext("running");
    expect(playQuerySound("success", () => fake.ctx)).toBe(true);

    // Two primary notes + two octave shimmer overtones = 4 oscillators.
    expect(fake.oscillators).toHaveLength(4);
    expect(fake.oscillators[0]?.frequencies[0]?.value).toBeCloseTo(659.25, 2);
    expect(fake.oscillators[2]?.frequencies[0]?.value).toBeCloseTo(987.77, 2);
    expect(fake.oscillators[0]?.startedAt).toBeLessThan(fake.oscillators[2]!.startedAt!);

    fake.oscillators[0]?.onended?.();
    expect(fake.oscillators[0]?.disconnected).toBe(true);
    expect(fake.gains[0]?.disconnected).toBe(true);
  });

  it("synthesizes a distinct descending tone for query errors", () => {
    const fake = createFakeAudioContext("running");
    expect(playQuerySound("error", () => fake.ctx)).toBe(true);

    expect(fake.oscillators).toHaveLength(2);
    expect(fake.oscillators[0]?.type).toBe("triangle");
    expect(fake.oscillators[0]?.frequencies[0]?.value).toBeGreaterThan(
      fake.oscillators[1]!.frequencies[0]!.value,
    );
  });

  it("resumes a suspended AudioContext when primed or played", async () => {
    const fake = createFakeAudioContext("suspended");
    expect(primeQuerySound(() => fake.ctx)).toBe(true);
    expect(fake.resume).toHaveBeenCalledTimes(1);

    resetQuerySoundForTest();
    const suspended = createFakeAudioContext("suspended");
    expect(playQuerySound("success", () => suspended.ctx)).toBe(true);
    expect(suspended.resume).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(suspended.oscillators).toHaveLength(4);
  });

  it("returns false cleanly when Web Audio is unavailable", () => {
    expect(primeQuerySound(() => null)).toBe(false);
    expect(playQuerySound("success", () => null)).toBe(false);
  });
});
