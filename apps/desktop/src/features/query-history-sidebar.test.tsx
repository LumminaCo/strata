import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  QueryHistorySidebar,
  formatDuration,
  formatHistoryTime,
  isCredentialOmittedSql,
  suggestQueryTitle,
} from "@/features/query-history-sidebar";
import type { Connection } from "@/ipc/bindings/protocol";

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
    agentAccess: "none",
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

describe("query history sidebar helpers", () => {
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
});

describe("QueryHistorySidebar rendering", () => {
  it("renders left sidebar structure with History and Pinned tabs and connection scope pills", () => {
    const markup = renderToStaticMarkup(
      <QueryHistorySidebar
        profiles={sampleProfiles}
        activeConnection={sampleProfiles[0]}
        canRun
        busy={false}
        revision={0}
        onRun={() => {}}
        onCopy={() => {}}
        onNotify={() => {}}
        onShowConnections={() => {}}
        onCollapse={() => {}}
      />,
    );

    expect(markup).toContain('aria-label="Query history"');
    expect(markup).toContain('role="tablist"');
    expect(markup).toContain("History");
    expect(markup).toContain("Pinned");
    expect(markup).toContain("All connections");
    expect(markup).toContain("Pagila Dev");
    expect(markup).toContain('aria-label="Show connections"');
    expect(markup).toContain('aria-label="Search query history"');
  });
});
