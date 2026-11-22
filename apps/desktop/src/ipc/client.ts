import { Channel, invoke, isTauri } from "@tauri-apps/api/core";

import type {
  CatalogScope,
  AuditEntry,
  Object as CatalogObject,
  NextResult,
  ObjectReference,
  ObjectDetails,
  ResolvedObject,
  CatalogSnapshot,
  HistoryItem,
  Cell,
  Connection,
  Page,
  ParsedUrl,
  QueryPlan,
  RunEvent,
  RunMode,
  RunRequest,
  SessionInfo,
  Settings,
  TransactionState,
  Target,
  Workspace,
} from "./bindings/protocol";
import { createDevTransport } from "./transport-dev";

interface Commands {
  list_connections: [undefined, Connection[]];
  save_connection: [{ profile: Connection; password?: string }, Connection];
  test_connection: [{ profile: Connection; password?: string }, SessionInfo];
  delete_connection: [{ id: string }, null];
  parse_connection_url: [{ url: string }, ParsedUrl];
  open_session: [{ connectionId: string; database?: string; password?: string }, SessionInfo];
  close_session: [{ sessionId: string }, null];
  stop: [{ sessionId: string; runId?: string }, null];
  plan_query: [
    { text: string; target: Target; mode: RunMode; production: boolean; kind?: Connection["kind"] },
    QueryPlan,
  ];
  fetch_more: [{ sessionId: string; cursorId: string; count: number }, Page];
  set_dbms_output: [{ sessionId: string; enabled: boolean }, null];
  next_result: [{ sessionId: string; cursorId: string; count: number }, NextResult];
  get_cell: [{ sessionId: string; cursorId: string; row: number; column: number }, Cell];
  list_databases: [{ scope: CatalogScope }, string[]];
  list_schemas: [{ scope: CatalogScope }, string[]];
  catalog_snapshot: [{ scope: CatalogScope; schema: string }, CatalogSnapshot];
  refresh_metadata: [{ connectionId: string }, null];
  history_list: [{ connectionId: string; limit?: number }, HistoryItem[]];
  resolve_at: [
    { scope: CatalogScope; text: string; offset: number; sessionId?: string },
    ResolvedObject | null,
  ];
  resolve_object: [{ scope: CatalogScope; reference: ObjectReference }, CatalogObject | null];
  object_details: [{ scope: CatalogScope; object: CatalogObject }, ObjectDetails];
  open_inspection_session: [{ scope: CatalogScope }, SessionInfo];

  settings_get: [undefined, Settings];
  settings_save: [{ settings: Settings }, null];
  set_transaction_mode: [{ sessionId: string; manual: boolean }, TransactionState];
  finish_transaction: [{ sessionId: string; commit: boolean }, TransactionState];
  audit_list: [{ limit?: number }, AuditEntry[]];
  mcp_config: [undefined, { mcpServers: Record<string, { command: string; args: string[] }> }];
  workspace_load: [undefined, Workspace];
  workspace_save: [{ workspace: Workspace }, null];
}

const dev = createDevTransport({
  url: import.meta.env.VITE_STRATA_DEV_URL ?? "http://localhost:7420",
  token: import.meta.env.VITE_STRATA_DEV_TOKEN ?? "",
});

export const browserMode = !isTauri();

export function dispatch<K extends keyof Commands>(
  command: K,
  ...args: Commands[K][0] extends undefined ? [] : [Commands[K][0]]
): Promise<Commands[K][1]> {
  const request = { command, args: args[0] };
  return browserMode ? dev.dispatch(request) : invoke("dispatch", { request });
}

export function runQuery(request: RunRequest, onEvent: (event: RunEvent) => void) {
  if (browserMode) return dev.run(request, onEvent);
  const channel = new Channel<RunEvent>();
  const done = new Promise<void>((resolve) => {
    channel.onmessage = (event) => {
      onEvent(event);
      if (event.type === "done") resolve();
    };
  });
  // Large Tauri frames are retrieved asynchronously by the WebView.
  return Promise.all([invoke<void>("run_query", { request, channel }), done]).then(() => {});
}

export function errorMessage(error: unknown): string {
  if (
    typeof error === "object" &&
    error &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }
  return typeof error === "string" ? error : "The operation failed.";
}
