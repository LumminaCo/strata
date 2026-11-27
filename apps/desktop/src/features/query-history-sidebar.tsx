import {
  Check,
  ChevronRight,
  Copy,
  Database,
  History,
  Pencil,
  Pin,
  PinOff,
  Play,
  Plus,
  Search,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { DatabaseIcon } from "@/components/database-icon";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { Connection, HistoryItem, SavedQueryItem } from "@/ipc/bindings/protocol";
import { dispatch, errorMessage } from "@/ipc/client";

export const HISTORY_PAGE_SIZE = 100;
const CREDENTIAL_OMITTED_MARKER = "-- Credential statement omitted";
const MAX_SUGGESTED_TITLE_LENGTH = 60;

export type HistorySidebarTab = "history" | "pinned";
export type HistoryScope = "all" | "connection";

export interface QueryHistorySidebarProps {
  profiles: Connection[];
  activeConnection?: Connection;
  canRun: boolean;
  busy: boolean;
  revision: number;
  focusToken?: number;
  currentEditorSql?: () => string;
  onRun: (sql: string, options?: { title?: string; connectionId?: string | null }) => void;
  onCopy: (sql: string, label: string) => Promise<void> | void;
  onNotify: (message: string) => void;
  onShowConnections: () => void;
  onCollapse: () => void;
}

export function isCredentialOmittedSql(sql: string): boolean {
  return sql.trim() === CREDENTIAL_OMITTED_MARKER;
}

export function suggestQueryTitle(sql: string): string {
  const lines = sql
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("--"));
  const candidate = (lines[0] ?? sql.trim()).replace(/\s+/g, " ").trim();
  if (!candidate) return "";
  if (candidate.length <= MAX_SUGGESTED_TITLE_LENGTH) return candidate;
  return `${candidate.slice(0, MAX_SUGGESTED_TITLE_LENGTH - 1).trimEnd()}…`;
}

export function formatHistoryTime(timestampMs: number, nowMs = Date.now()): string {
  const deltaSeconds = Math.floor((nowMs - timestampMs) / 1000);
  if (deltaSeconds < 45) return "Just now";
  const deltaMinutes = Math.floor(deltaSeconds / 60);
  if (deltaMinutes < 60) return `${deltaMinutes}m ago`;
  const deltaHours = Math.floor(deltaMinutes / 60);
  if (deltaHours < 24) return `${deltaHours}h ago`;
  const deltaDays = Math.floor(deltaHours / 24);
  if (deltaDays < 7) return `${deltaDays}d ago`;
  const date = new Date(timestampMs);
  const now = new Date(nowMs);
  const sameYear = date.getFullYear() === now.getFullYear();
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const seconds = ms / 1000;
  return `${seconds.toFixed(seconds >= 10 ? 1 : 2)} s`;
}

export function QueryHistorySidebar({
  profiles,
  activeConnection,
  canRun,
  busy,
  revision,
  focusToken = 0,
  currentEditorSql,
  onRun,
  onCopy,
  onNotify,
  onShowConnections,
  onCollapse,
}: QueryHistorySidebarProps) {
  const [activeTab, setActiveTab] = useState<HistorySidebarTab>("history");
  const [scope, setScope] = useState<HistoryScope>("all");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");

  const [historyItems, setHistoryItems] = useState<HistoryItem[]>([]);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [historyHasMore, setHistoryHasMore] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyLoadingMore, setHistoryLoadingMore] = useState(false);
  const [historyError, setHistoryError] = useState("");

  const [savedItems, setSavedItems] = useState<SavedQueryItem[]>([]);
  const [savedLoading, setSavedLoading] = useState(false);
  const [savedError, setSavedError] = useState("");
  const [savedRevision, setSavedRevision] = useState(0);

  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(() => new Set());
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const [pinningHistoryId, setPinningHistoryId] = useState<number | null>(null);
  const [pinTitle, setPinTitle] = useState("");
  const [pinSaving, setPinSaving] = useState(false);
  const [pinError, setPinError] = useState("");

  const [creatingSaved, setCreatingSaved] = useState(false);
  const [newSavedTitle, setNewSavedTitle] = useState("");
  const [newSavedSql, setNewSavedSql] = useState("");
  const [newSavedSaving, setNewSavedSaving] = useState(false);
  const [newSavedError, setNewSavedError] = useState("");

  const [editingSavedId, setEditingSavedId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editSql, setEditSql] = useState("");
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState("");

  const searchInputRef = useRef<HTMLInputElement>(null);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const historyRequestId = useRef(0);
  const savedRequestId = useRef(0);

  const activeConnectionId = activeConnection?.id ?? null;
  const effectiveScope: HistoryScope = activeConnectionId ? scope : "all";
  const filterConnectionId = effectiveScope === "connection" ? activeConnectionId : null;

  const profileById = useMemo(() => {
    const map = new Map<string, Connection>();
    for (const profile of profiles) {
      if (profile.id) map.set(profile.id, profile);
    }
    return map;
  }, [profiles]);

  const pinnedSqlSet = useMemo(() => {
    const set = new Set<string>();
    for (const item of savedItems) {
      set.add(item.sql.trim());
    }
    return set;
  }, [savedItems]);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search.trim()), 150);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    return () => clearTimeout(copiedTimerRef.current);
  }, []);

  useEffect(() => {
    if (focusToken > 0) {
      searchInputRef.current?.focus();
    }
  }, [focusToken]);

  useEffect(() => {
    const request = ++historyRequestId.current;
    setHistoryLoading(true);
    setHistoryError("");
    void dispatch("history_list", {
      connectionId: filterConnectionId,
      search: debouncedSearch || undefined,
      offset: 0,
      limit: HISTORY_PAGE_SIZE,
    }).then(
      (page) => {
        if (historyRequestId.current !== request) return;
        setHistoryItems(page.items);
        setHistoryTotal(page.total);
        setHistoryHasMore(page.hasMore);
        setHistoryLoading(false);
      },
      (error: unknown) => {
        if (historyRequestId.current !== request) return;
        setHistoryError(errorMessage(error));
        setHistoryLoading(false);
      },
    );
  }, [filterConnectionId, debouncedSearch, revision]);

  useEffect(() => {
    const request = ++savedRequestId.current;
    setSavedLoading(true);
    setSavedError("");
    void dispatch("saved_query_list", {
      connectionId: filterConnectionId,
      search: debouncedSearch || undefined,
    }).then(
      (items) => {
        if (savedRequestId.current !== request) return;
        setSavedItems(items);
        setSavedLoading(false);
      },
      (error: unknown) => {
        if (savedRequestId.current !== request) return;
        setSavedError(errorMessage(error));
        setSavedLoading(false);
      },
    );
  }, [filterConnectionId, debouncedSearch, savedRevision]);

  const loadMoreHistory = useCallback(() => {
    if (historyLoadingMore || !historyHasMore) return;
    const request = historyRequestId.current;
    const offset = historyItems.length;
    setHistoryLoadingMore(true);
    void dispatch("history_list", {
      connectionId: filterConnectionId,
      search: debouncedSearch || undefined,
      offset,
      limit: HISTORY_PAGE_SIZE,
    }).then(
      (page) => {
        if (historyRequestId.current !== request) return;
        setHistoryItems((current) => [...current, ...page.items]);
        setHistoryTotal(page.total);
        setHistoryHasMore(page.hasMore);
        setHistoryLoadingMore(false);
      },
      (error: unknown) => {
        if (historyRequestId.current !== request) return;
        setHistoryError(errorMessage(error));
        setHistoryLoadingMore(false);
      },
    );
  }, [
    debouncedSearch,
    filterConnectionId,
    historyHasMore,
    historyItems.length,
    historyLoadingMore,
  ]);

  function toggleExpanded(key: string) {
    setExpandedKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function handleCopy(key: string, sql: string, label: string) {
    await onCopy(sql, label);
    setCopiedKey(key);
    clearTimeout(copiedTimerRef.current);
    copiedTimerRef.current = setTimeout(() => setCopiedKey(null), 1500);
  }

  function startPinFromHistory(item: HistoryItem) {
    setPinningHistoryId(item.id);
    setPinTitle(suggestQueryTitle(item.sql));
    setPinError("");
  }

  function cancelPinFromHistory() {
    setPinningHistoryId(null);
    setPinTitle("");
    setPinError("");
  }

  async function submitPinFromHistory(item: HistoryItem) {
    if (pinSaving) return;
    const trimmed = pinTitle.trim();
    if (!trimmed) {
      setPinError("Enter a title for this query.");
      return;
    }
    setPinSaving(true);
    setPinError("");
    try {
      await dispatch("saved_query_save", {
        connectionId: item.connectionId || activeConnectionId,
        title: trimmed,
        sql: item.sql,
      });
      setSavedRevision((value) => value + 1);
      setPinningHistoryId(null);
      setPinTitle("");
      onNotify(`Pinned "${trimmed}".`);
    } catch (error) {
      setPinError(errorMessage(error));
    } finally {
      setPinSaving(false);
    }
  }

  function startCreateSaved() {
    const editorText = currentEditorSql?.().trim() ?? "";
    setCreatingSaved(true);
    setNewSavedSql(editorText);
    setNewSavedTitle(editorText ? suggestQueryTitle(editorText) : "");
    setNewSavedError("");
  }

  function cancelCreateSaved() {
    setCreatingSaved(false);
    setNewSavedTitle("");
    setNewSavedSql("");
    setNewSavedError("");
  }

  async function submitCreateSaved() {
    if (newSavedSaving) return;
    const title = newSavedTitle.trim();
    const sql = newSavedSql;
    if (!title) {
      setNewSavedError("Enter a title for this query.");
      return;
    }
    if (!sql.trim()) {
      setNewSavedError("Enter SQL to save.");
      return;
    }
    setNewSavedSaving(true);
    setNewSavedError("");
    try {
      await dispatch("saved_query_save", {
        connectionId: activeConnectionId,
        title,
        sql,
      });
      setSavedRevision((value) => value + 1);
      cancelCreateSaved();
      onNotify(`Pinned "${title}".`);
    } catch (error) {
      setNewSavedError(errorMessage(error));
    } finally {
      setNewSavedSaving(false);
    }
  }

  function startEditSaved(item: SavedQueryItem) {
    setEditingSavedId(item.id);
    setEditTitle(item.title);
    setEditSql(item.sql);
    setEditError("");
  }

  function cancelEditSaved() {
    setEditingSavedId(null);
    setEditTitle("");
    setEditSql("");
    setEditError("");
  }

  async function submitEditSaved(item: SavedQueryItem) {
    if (editSaving) return;
    const title = editTitle.trim();
    if (!title) {
      setEditError("Enter a title for this query.");
      return;
    }
    if (!editSql.trim()) {
      setEditError("SQL cannot be empty.");
      return;
    }
    setEditSaving(true);
    setEditError("");
    try {
      await dispatch("saved_query_save", {
        id: item.id,
        connectionId: item.connectionId,
        title,
        sql: editSql,
      });
      setSavedRevision((value) => value + 1);
      cancelEditSaved();
      onNotify(`Updated "${title}".`);
    } catch (error) {
      setEditError(errorMessage(error));
    } finally {
      setEditSaving(false);
    }
  }

  async function deleteSaved(item: SavedQueryItem) {
    try {
      await dispatch("saved_query_delete", { id: item.id });
      if (editingSavedId === item.id) cancelEditSaved();
      setSavedRevision((value) => value + 1);
      onNotify(`Unpinned "${item.title}".`);
    } catch (error) {
      setSavedError(errorMessage(error));
    }
  }

  const showScopeToggle = Boolean(activeConnectionId && profiles.length > 1);

  return (
    <aside className="explorer history-sidebar" aria-label="Query history">
      <div className="sidebar-heading">
        <h2>Query history</h2>
        <div className="sidebar-heading-actions">
          <Button
            size="icon-xs"
            variant="ghost"
            title="Show connections"
            aria-label="Show connections"
            onClick={onShowConnections}
          >
            <Database />
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            title="Collapse query history"
            aria-label="Collapse query history"
            className="sidebar-collapse-button"
            onClick={onCollapse}
          >
            <ChevronRight />
          </Button>
        </div>
      </div>

      <div className="history-sidebar-controls">
        <div className="history-tabs" role="tablist" aria-label="Query history views">
          <button
            type="button"
            role="tab"
            className="history-tab"
            aria-selected={activeTab === "history"}
            onClick={() => setActiveTab("history")}
          >
            <History aria-hidden="true" />
            <span>History</span>
            {historyTotal > 0 && (
              <span className="history-tab-count">{historyTotal.toLocaleString()}</span>
            )}
          </button>
          <button
            type="button"
            role="tab"
            className="history-tab"
            aria-selected={activeTab === "pinned"}
            onClick={() => setActiveTab("pinned")}
          >
            <Pin aria-hidden="true" />
            <span>Pinned</span>
            {savedItems.length > 0 && (
              <span className="history-tab-count">{savedItems.length.toLocaleString()}</span>
            )}
          </button>
        </div>

        <div className="history-search-row">
          <Search className="history-search-icon" aria-hidden="true" />
          <Input
            ref={searchInputRef}
            className="history-search-input"
            aria-label={activeTab === "history" ? "Search query history" : "Search pinned queries"}
            placeholder={activeTab === "history" ? "Filter SQL…" : "Filter pinned…"}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && search) {
                event.stopPropagation();
                setSearch("");
              }
            }}
          />
          {search && (
            <button
              type="button"
              className="history-search-clear"
              aria-label="Clear filter"
              onClick={() => setSearch("")}
            >
              <X />
            </button>
          )}
        </div>

        {showScopeToggle && (
          <div className="history-scope-row" role="group" aria-label="Connection filter">
            <button
              type="button"
              className="history-scope-pill"
              aria-pressed={effectiveScope === "all"}
              onClick={() => setScope("all")}
            >
              All connections
            </button>
            <button
              type="button"
              className="history-scope-pill"
              aria-pressed={effectiveScope === "connection"}
              title={activeConnection?.name}
              onClick={() => setScope("connection")}
            >
              {activeConnection && <DatabaseIcon kind={activeConnection.kind} />}
              <span>{activeConnection?.name ?? "Current"}</span>
            </button>
          </div>
        )}

        {activeTab === "pinned" && !creatingSaved && (
          <Button
            type="button"
            variant="outline"
            size="xs"
            className="history-pin-new"
            onClick={startCreateSaved}
          >
            <Plus /> Pin query
          </Button>
        )}
      </div>

      <div
        className="history-list"
        role="tabpanel"
        aria-label={activeTab === "history" ? "History" : "Pinned"}
      >
        {activeTab === "history" ? (
          <>
            {historyError && (
              <p className="history-empty" role="alert">
                {historyError}
              </p>
            )}
            {!historyError && !historyLoading && historyItems.length === 0 && (
              <p className="history-empty">
                {debouncedSearch
                  ? "No matching queries in history."
                  : "Run a query to build your history."}
              </p>
            )}
            {historyItems.map((item) => {
              const key = `history-${item.id}`;
              const expanded = expandedKeys.has(key);
              const copied = copiedKey === key;
              const omitted = isCredentialOmittedSql(item.sql);
              const alreadyPinned = pinnedSqlSet.has(item.sql.trim());
              const isPinning = pinningHistoryId === item.id;
              const connection = profileById.get(item.connectionId);
              const runDisabled = busy || omitted || (!canRun && !connection);
              return (
                <article key={key} className="history-card">
                  <div className="history-card-header">
                    <span
                      className="history-status-dot"
                      data-status={item.status}
                      title={`Status: ${item.status}`}
                    />
                    <time
                      className="history-time"
                      title={new Date(item.startedAt).toLocaleString()}
                    >
                      {formatHistoryTime(item.startedAt)}
                    </time>
                    <div className="history-card-actions">
                      <Button
                        type="button"
                        size="icon-xs"
                        variant="ghost"
                        disabled={runDisabled}
                        title={
                          omitted
                            ? "Credential statements are not stored in history"
                            : busy
                              ? "Wait for the running query to finish"
                              : "Run in new result tab"
                        }
                        aria-label="Run query in new result tab"
                        onClick={() => onRun(item.sql, { connectionId: item.connectionId || null })}
                      >
                        <Play />
                      </Button>
                      <Button
                        type="button"
                        size="icon-xs"
                        variant="ghost"
                        disabled={omitted}
                        title={copied ? "Copied" : "Copy SQL"}
                        aria-label="Copy SQL"
                        onClick={() => void handleCopy(key, item.sql, "query SQL")}
                      >
                        {copied ? <Check /> : <Copy />}
                      </Button>
                      <Button
                        type="button"
                        size="icon-xs"
                        variant="ghost"
                        disabled={omitted}
                        data-pinned={alreadyPinned || isPinning}
                        title={alreadyPinned ? "Pinned (click to save another)" : "Pin query"}
                        aria-label="Pin query"
                        onClick={() =>
                          isPinning ? cancelPinFromHistory() : startPinFromHistory(item)
                        }
                      >
                        <Pin />
                      </Button>
                    </div>
                  </div>

                  <button
                    type="button"
                    className="history-sql-preview"
                    data-expanded={expanded}
                    title={expanded ? "Click to collapse" : "Click to expand full SQL"}
                    onClick={() => toggleExpanded(key)}
                  >
                    <code>{item.sql}</code>
                  </button>

                  <div className="history-card-meta">
                    <span>{formatDuration(item.durationMs)}</span>
                    <span>{item.rows.toLocaleString()} rows</span>
                    {effectiveScope === "all" && connection && (
                      <span className="history-card-conn" title={connection.name}>
                        <DatabaseIcon kind={connection.kind} />
                        <span>{connection.name}</span>
                      </span>
                    )}
                  </div>

                  {isPinning && (
                    <form
                      className="history-inline-form"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void submitPinFromHistory(item);
                      }}
                    >
                      <Input
                        autoFocus
                        aria-label="Pinned query title"
                        placeholder="Query title"
                        maxLength={120}
                        value={pinTitle}
                        onChange={(event) => {
                          setPinTitle(event.target.value);
                          if (pinError) setPinError("");
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Escape") {
                            event.stopPropagation();
                            cancelPinFromHistory();
                          }
                        }}
                      />
                      {pinError && (
                        <p className="history-form-error" role="alert">
                          {pinError}
                        </p>
                      )}
                      <div className="history-inline-form-actions">
                        <Button type="submit" size="xs" disabled={pinSaving}>
                          Save pin
                        </Button>
                        <Button
                          type="button"
                          size="xs"
                          variant="ghost"
                          disabled={pinSaving}
                          onClick={cancelPinFromHistory}
                        >
                          Cancel
                        </Button>
                      </div>
                    </form>
                  )}
                </article>
              );
            })}
            {historyHasMore && (
              <div className="history-load-more">
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  disabled={historyLoadingMore}
                  onClick={loadMoreHistory}
                >
                  {historyLoadingMore
                    ? "Loading…"
                    : `Load more (${historyItems.length.toLocaleString()} of ${historyTotal.toLocaleString()})`}
                </Button>
              </div>
            )}
          </>
        ) : (
          <>
            {creatingSaved && (
              <form
                className="history-card history-inline-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void submitCreateSaved();
                }}
              >
                <Input
                  autoFocus
                  aria-label="New pinned query title"
                  placeholder="Query title"
                  maxLength={120}
                  value={newSavedTitle}
                  onChange={(event) => {
                    setNewSavedTitle(event.target.value);
                    if (newSavedError) setNewSavedError("");
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.stopPropagation();
                      cancelCreateSaved();
                    }
                  }}
                />
                <textarea
                  className="history-sql-textarea"
                  aria-label="New pinned query SQL"
                  placeholder="SELECT * FROM …"
                  rows={4}
                  value={newSavedSql}
                  onChange={(event) => {
                    setNewSavedSql(event.target.value);
                    if (newSavedError) setNewSavedError("");
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.stopPropagation();
                      cancelCreateSaved();
                    }
                  }}
                />
                {newSavedError && (
                  <p className="history-form-error" role="alert">
                    {newSavedError}
                  </p>
                )}
                <div className="history-inline-form-actions">
                  <Button type="submit" size="xs" disabled={newSavedSaving}>
                    Save pin
                  </Button>
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    disabled={newSavedSaving}
                    onClick={cancelCreateSaved}
                  >
                    Cancel
                  </Button>
                </div>
              </form>
            )}
            {savedError && (
              <p className="history-empty" role="alert">
                {savedError}
              </p>
            )}
            {!savedError && !savedLoading && savedItems.length === 0 && !creatingSaved && (
              <p className="history-empty">
                {debouncedSearch
                  ? "No matching pinned queries."
                  : "Pin queries from History or save one here for quick reuse."}
              </p>
            )}
            {savedItems.map((item) => {
              const key = `saved-${item.id}`;
              const expanded = expandedKeys.has(key);
              const copied = copiedKey === key;
              const editing = editingSavedId === item.id;
              const connection = item.connectionId ? profileById.get(item.connectionId) : undefined;
              const runDisabled = busy || (!canRun && !connection);
              return (
                <article key={key} className="history-card">
                  {editing ? (
                    <form
                      className="history-inline-form"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void submitEditSaved(item);
                      }}
                    >
                      <Input
                        autoFocus
                        aria-label="Edit pinned query title"
                        placeholder="Query title"
                        maxLength={120}
                        value={editTitle}
                        onChange={(event) => {
                          setEditTitle(event.target.value);
                          if (editError) setEditError("");
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Escape") {
                            event.stopPropagation();
                            cancelEditSaved();
                          }
                        }}
                      />
                      <textarea
                        className="history-sql-textarea"
                        aria-label="Edit pinned query SQL"
                        rows={4}
                        value={editSql}
                        onChange={(event) => {
                          setEditSql(event.target.value);
                          if (editError) setEditError("");
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Escape") {
                            event.stopPropagation();
                            cancelEditSaved();
                          }
                        }}
                      />
                      {editError && (
                        <p className="history-form-error" role="alert">
                          {editError}
                        </p>
                      )}
                      <div className="history-inline-form-actions">
                        <Button type="submit" size="xs" disabled={editSaving}>
                          Save
                        </Button>
                        <Button
                          type="button"
                          size="xs"
                          variant="ghost"
                          disabled={editSaving}
                          onClick={cancelEditSaved}
                        >
                          Cancel
                        </Button>
                      </div>
                    </form>
                  ) : (
                    <>
                      <div className="history-card-header">
                        <strong className="history-pinned-title" title={item.title}>
                          {item.title}
                        </strong>
                        <div className="history-card-actions">
                          <Button
                            type="button"
                            size="icon-xs"
                            variant="ghost"
                            disabled={runDisabled}
                            title={
                              busy
                                ? "Wait for the running query to finish"
                                : "Run in new result tab"
                            }
                            aria-label={`Run ${item.title} in new result tab`}
                            onClick={() =>
                              onRun(item.sql, {
                                title: item.title,
                                connectionId: item.connectionId,
                              })
                            }
                          >
                            <Play />
                          </Button>
                          <Button
                            type="button"
                            size="icon-xs"
                            variant="ghost"
                            title={copied ? "Copied" : "Copy SQL"}
                            aria-label={`Copy ${item.title}`}
                            onClick={() => void handleCopy(key, item.sql, `"${item.title}"`)}
                          >
                            {copied ? <Check /> : <Copy />}
                          </Button>
                          <Button
                            type="button"
                            size="icon-xs"
                            variant="ghost"
                            title="Edit pinned query"
                            aria-label={`Edit ${item.title}`}
                            onClick={() => startEditSaved(item)}
                          >
                            <Pencil />
                          </Button>
                          <Button
                            type="button"
                            size="icon-xs"
                            variant="ghost"
                            title="Unpin query"
                            aria-label={`Unpin ${item.title}`}
                            onClick={() => void deleteSaved(item)}
                          >
                            <PinOff />
                          </Button>
                        </div>
                      </div>

                      <button
                        type="button"
                        className="history-sql-preview"
                        data-expanded={expanded}
                        title={expanded ? "Click to collapse" : "Click to expand full SQL"}
                        onClick={() => toggleExpanded(key)}
                      >
                        <code>{item.sql}</code>
                      </button>

                      <div className="history-card-meta">
                        <time
                          className="history-time"
                          title={new Date(item.updatedAt).toLocaleString()}
                        >
                          {formatHistoryTime(item.updatedAt)}
                        </time>
                        {effectiveScope === "all" && connection && (
                          <span className="history-card-conn" title={connection.name}>
                            <DatabaseIcon kind={connection.kind} />
                            <span>{connection.name}</span>
                          </span>
                        )}
                      </div>
                    </>
                  )}
                </article>
              );
            })}
          </>
        )}
      </div>
    </aside>
  );
}
