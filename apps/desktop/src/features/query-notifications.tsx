import { AlertCircle, ArrowUpRight, CheckCircle2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { DatabaseIcon } from "@/components/database-icon";
import { Button } from "@/components/ui/button";
import type { Connection, RunMode } from "@/ipc/bindings/protocol";

export interface QueryCompletion {
  id: string;
  tabId: string;
  tabLabel: string;
  connectionName: string;
  connectionKind: Connection["kind"];
  connectionEnv: Connection["env"];
  connectionColor?: string | null;
  database?: string;
  mode: RunMode;
  status: "success" | "error";
  statements: number;
  rows: number;
  affectedRows: number;
  resultSets: number;
  elapsedMs: number;
  errorMessage?: string;
}

export const MAX_QUERY_TOASTS = 3;
export const SUCCESS_TOAST_DURATION_MS = 6_500;
export const ERROR_TOAST_DURATION_MS = 9_000;

export function toastDurationMs(status: QueryCompletion["status"]): number {
  return status === "error" ? ERROR_TOAST_DURATION_MS : SUCCESS_TOAST_DURATION_MS;
}

export function formatElapsed(elapsedMs: number): string {
  const safe = Math.max(0, Math.round(elapsedMs));
  if (safe < 1_000) return `${safe} ms`;
  if (safe < 60_000) {
    const seconds = safe / 1_000;
    return `${seconds.toFixed(safe < 10_000 ? 2 : 1)} s`;
  }
  const totalSeconds = Math.floor(safe / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

export function formatQueryToastTitle(
  completion: Pick<QueryCompletion, "mode" | "status">,
): string {
  const subject =
    completion.mode === "explain" ? "Explain" : completion.mode === "script" ? "Script" : "Query";
  return completion.status === "error" ? `${subject} failed` : `${subject} finished`;
}

export function formatQueryToastDetail(
  completion: Pick<
    QueryCompletion,
    "status" | "resultSets" | "rows" | "affectedRows" | "statements" | "errorMessage"
  >,
): string {
  if (completion.status === "error") {
    return completion.errorMessage?.trim() || "The query ended with an error.";
  }
  const parts: string[] = [];
  if (completion.resultSets > 0) {
    parts.push(
      `${completion.rows.toLocaleString()} ${completion.rows === 1 ? "row" : "rows"} returned`,
    );
    if (completion.resultSets > 1) {
      parts.push(`${completion.resultSets.toLocaleString()} result sets`);
    }
  } else if (completion.affectedRows > 0) {
    parts.push(
      `${completion.affectedRows.toLocaleString()} ${completion.affectedRows === 1 ? "row" : "rows"} affected`,
    );
  }
  if (parts.length === 0 || completion.statements > 1) {
    const count = Math.max(1, completion.statements);
    parts.push(`${count.toLocaleString()} ${count === 1 ? "statement" : "statements"}`);
  }
  return parts.join(" · ");
}

export function appendQueryToast(
  current: QueryCompletion[],
  next: QueryCompletion,
  limit = MAX_QUERY_TOASTS,
): QueryCompletion[] {
  return [...current.filter((item) => item.id !== next.id), next].slice(-limit);
}

interface QueryToastItemProps {
  notification: QueryCompletion;
  isCurrentTab: boolean;
  onDismiss: (id: string) => void;
  onViewTab: (tabId: string) => void;
}

function QueryToastItem({ notification, isCurrentTab, onDismiss, onViewTab }: QueryToastItemProps) {
  const duration = toastDurationMs(notification.status);
  const [paused, setPaused] = useState(false);
  const remainingRef = useRef(duration);
  const startedAtRef = useRef<number | null>(null);
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;

  useEffect(() => {
    if (paused) return;
    startedAtRef.current = Date.now();
    const timer = setTimeout(() => {
      onDismissRef.current(notification.id);
    }, remainingRef.current);
    return () => {
      clearTimeout(timer);
      if (startedAtRef.current !== null) {
        const spent = Date.now() - startedAtRef.current;
        remainingRef.current = Math.max(250, remainingRef.current - spent);
        startedAtRef.current = null;
      }
    };
  }, [notification.id, paused]);

  const title = formatQueryToastTitle(notification);
  const detail = formatQueryToastDetail(notification);
  const elapsed = formatElapsed(notification.elapsedMs);
  const isError = notification.status === "error";

  return (
    <div
      className="query-toast"
      data-status={notification.status}
      data-paused={paused}
      role={isError ? "alert" : "status"}
      aria-live={isError ? "assertive" : "polite"}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocusCapture={() => setPaused(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setPaused(false);
        }
      }}
    >
      <div className="query-toast-icon" aria-hidden="true">
        {isError ? <AlertCircle /> : <CheckCircle2 />}
      </div>
      <div className="query-toast-body">
        <div className="query-toast-header">
          <span className="query-toast-title">{title}</span>
          <span className="query-toast-elapsed">{elapsed}</span>
        </div>
        <div className="query-toast-context">
          <DatabaseIcon kind={notification.connectionKind} />
          <span className="query-toast-connection">{notification.tabLabel}</span>
          {notification.database && (
            <>
              <span className="query-toast-sep" aria-hidden="true">
                /
              </span>
              <span className="query-toast-database">{notification.database}</span>
            </>
          )}
          <span
            className="env-dot"
            data-env={notification.connectionEnv}
            data-color={notification.connectionColor ?? undefined}
            aria-hidden="true"
          />
        </div>
        <p className="query-toast-detail" title={detail}>
          {detail}
        </p>
        {!isCurrentTab && (
          <div className="query-toast-actions">
            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={() => {
                onViewTab(notification.tabId);
                onDismiss(notification.id);
              }}
            >
              View tab <ArrowUpRight />
            </Button>
          </div>
        )}
      </div>
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        className="query-toast-close"
        aria-label={`Dismiss ${title.toLowerCase()} notification`}
        onClick={() => onDismiss(notification.id)}
      >
        <X />
      </Button>
      <span className="query-toast-progress" aria-hidden="true" />
    </div>
  );
}

export interface QueryNotificationStackProps {
  notifications: QueryCompletion[];
  activeTabId?: string | null;
  notice?: string;
  onDismissNotice: () => void;
  onDismissNotification: (id: string) => void;
  onViewTab: (tabId: string) => void;
}

export function QueryNotificationStack({
  notifications,
  activeTabId,
  notice,
  onDismissNotice,
  onDismissNotification,
  onViewTab,
}: QueryNotificationStackProps) {
  if (!notice && notifications.length === 0) return null;

  return (
    <div className="notification-stack" aria-label="Notifications">
      {notice && (
        <div className="workspace-notice" role="alert">
          <span>{notice}</span>
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            aria-label="Dismiss notification"
            onClick={onDismissNotice}
          >
            <X />
          </Button>
        </div>
      )}
      {notifications.map((notification) => (
        <QueryToastItem
          key={notification.id}
          notification={notification}
          isCurrentTab={activeTabId === notification.tabId}
          onDismiss={onDismissNotification}
          onViewTab={onViewTab}
        />
      ))}
    </div>
  );
}
