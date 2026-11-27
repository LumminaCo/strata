import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  ActivitySidebar,
  auditStatusTone,
  buildActivityFeed,
  formatDuration,
  formatHistoryTime,
  isCredentialOmittedSql,
  matchesAuditFilter,
  resolveHistoryActor,
  suggestQueryTitle,
} from "@/features/activity-sidebar";
import type { AuditEntry, Connection, HistoryItem } from "@/ipc/bindings/protocol";

const sampleProfiles: Connection[] = [
  {
    id: "conn-1",
    name: "Pagila Dev",
    kind: "postgres",
    env: "dev",
    color: null,
    folder: null,
    host: "localhost",
    port: 5432,
    database: "pagila",
    user: "postgres",
    secret: "prompt",
    readOnly: false,
    agentAccess: "read",
    allowAgentDdl: false,
    options: null,
    tls: "prefer",
  },
  {
    id: "conn-2",
    name: "Analytics Prod",
    kind: "sqlserver",
    env: "prod",
    color: null,
    folder: null,
    host: "db.internal",
    port: 1433,
    database: "analytics",
    user: "reader",
    secret: "prompt",
    readOnly: true,
    agentAccess: "none",
    allowAgentDdl: false,
    options: null,
    tls: "require",
  },
];

const sampleHistory: HistoryItem[] = [
  {
    id: 10,
    connectionId: "conn-1",
    source: "ui",
    sql: "SELECT * FROM public.actor;",
    startedAt: 2_000,
    durationMs: 12,
    rows: 200,
    status: "ok",
  },
  {
    id: 11,
    connectionId: "conn-2",
    source: "cli",
    sql: "SELECT COUNT(*) FROM sales;",
    startedAt: 4_000,
    durationMs: 35,
    rows: 1,
    status: "ok",
  },
  {
    id: 12,
    connectionId: "conn-1",
    source: "mcp",
    sql: "SELECT id FROM film LIMIT 5;",
    startedAt: 3_000,
    durationMs: 8,
    rows: 5,
    status: "ok",
  },
];

const sampleAudit: [AuditEntry, AuditEntry] = [
  {
    id: 1,
    ts: 5_000,
    clientName: "Claude Code",
    connectionName: "Pagila Dev",
    tool: "run_query",
    sql: "SELECT title FROM film LIMIT 10;",
    class: "read",
    decision: "allowed",
    reason: null,
    rows: 10,
    durationMs: 18,
  },
  {
    id: 2,
    ts: 1_500,
    clientName: "Cursor",
    connectionName: "Analytics Prod",
    tool: "run_write",
    sql: "DELETE FROM sales;",
    class: "write",
    decision: "denied",
    reason: "Write access is disabled for this connection",
    rows: null,
    durationMs: 1,
  },
];

describe("activity sidebar helpers", () => {
  it("suggests concise titles skipping leading SQL comments", () => {
    expect(
      suggestQueryTitle("-- lookup active users\nSELECT id, email FROM users WHERE active = true;"),
    ).toBe("SELECT id, email FROM users WHERE active = true;");
    expect(suggestQueryTitle("   \n  ")).toBe("");
    const longSql =
      "SELECT customer_id, first_name, last_name, email, create_date FROM public.customer ORDER BY customer_id DESC";
    const suggested = suggestQueryTitle(longSql);
    expect(suggested.length).toBeLessThanOrEqual(60);
    expect(suggested.endsWith("…")).toBe(true);
  });

  it("formats relative timestamps and durations", () => {
    const now = Date.UTC(2026, 10, 27, 15, 0, 0);
    expect(formatHistoryTime(now - 10_000, now)).toBe("Just now");
    expect(formatHistoryTime(now - 5 * 60_000, now)).toBe("5m ago");
    expect(formatHistoryTime(now - 3 * 3_600_000, now)).toBe("3h ago");
    expect(formatHistoryTime(now - 2 * 86_400_000, now)).toBe("2d ago");
    expect(formatHistoryTime(Date.UTC(2025, 0, 15, 12, 0, 0), now)).toContain("2025");

    expect(formatDuration(0)).toBe("0 ms");
    expect(formatDuration(42)).toBe("42 ms");
    expect(formatDuration(1_250)).toBe("1.25 s");
    expect(formatDuration(14_800)).toBe("14.8 s");
  });

  it("detects credential-omitted history placeholders", () => {
    expect(isCredentialOmittedSql("-- Credential statement omitted")).toBe(true);
    expect(isCredentialOmittedSql("  -- Credential statement omitted  ")).toBe(true);
    expect(isCredentialOmittedSql("SELECT 1;")).toBe(false);
  });

  it("classifies history sources and audit decisions", () => {
    expect(resolveHistoryActor("ui")).toBe("user");
    expect(resolveHistoryActor("cli")).toBe("cli");
    expect(resolveHistoryActor("mcp")).toBe("agent");

    expect(auditStatusTone("allowed")).toBe("ok");
    expect(auditStatusTone("denied")).toBe("error");
    expect(auditStatusTone("error")).toBe("error");
    expect(auditStatusTone("pending")).toBe("pending");
  });

  it("filters audit entries by connection name and search query", () => {
    expect(matchesAuditFilter(sampleAudit[0], { connectionName: "Pagila Dev" })).toBe(true);
    expect(matchesAuditFilter(sampleAudit[0], { connectionName: "Analytics Prod" })).toBe(false);
    expect(matchesAuditFilter(sampleAudit[0], { search: "claude" })).toBe(true);
    expect(matchesAuditFilter(sampleAudit[1], { search: "disabled" })).toBe(true);
    expect(matchesAuditFilter(sampleAudit[1], { search: "actor" })).toBe(false);
  });

  it("merges and filters unified user and agent activity chronologically", () => {
    const all = buildActivityFeed(sampleHistory, sampleAudit, { actorFilter: "all" });
    expect(all.map((entry) => entry.key)).toEqual([
      "audit-1",
      "history-11",
      "history-12",
      "history-10",
      "audit-2",
    ]);
    expect(all.map((entry) => entry.actor)).toEqual(["agent", "cli", "agent", "user", "agent"]);

    const userOnly = buildActivityFeed(sampleHistory, sampleAudit, { actorFilter: "user" });
    expect(userOnly.map((entry) => entry.key)).toEqual(["history-11", "history-10"]);

    const agentOnly = buildActivityFeed(sampleHistory, sampleAudit, {
      actorFilter: "agent",
      connectionName: "Pagila Dev",
    });
    expect(agentOnly.map((entry) => entry.key)).toEqual(["audit-1", "history-12"]);
  });
});

describe("ActivitySidebar rendering", () => {
  it("renders right sidebar structure with Activity/Pinned tabs, actor filters, and connection scope pills", () => {
    const markup = renderToStaticMarkup(
      <ActivitySidebar
        open
        profiles={sampleProfiles}
        activeConnection={sampleProfiles[0]}
        canRun
        busy={false}
        revision={0}
        onRun={() => {}}
        onOpenSql={() => {}}
        onCopy={() => {}}
        onNotify={() => {}}
        onCollapse={() => {}}
      />,
    );

    expect(markup).toContain('aria-label="Activity"');
    expect(markup).toContain('aria-label="Collapse activity"');
    expect(markup).toContain('role="tablist"');
    expect(markup).toContain("Activity");
    expect(markup).toContain("Pinned");
    expect(markup).toContain('aria-label="Activity source filter"');
    expect(markup).toContain("All");
    expect(markup).toContain("You");
    expect(markup).toContain("Agent");
    expect(markup).toContain("All connections");
    expect(markup).toContain("Pagila Dev");
    expect(markup).toContain('aria-label="Search activity"');
  });
});
