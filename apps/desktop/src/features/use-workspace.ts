import { useCallback, useEffect, useRef, useState } from "react";

import { loadResultGrid } from "@/components/load-result-grid";
import type { ResultSet } from "@/components/result-grid";
import type { EditorDiagnostic } from "@/components/sql-editor";
import type {
  CatalogScope,
  Cell,
  Connection,
  RunEvent,
  RunMode,
  SavedTab,
  SessionInfo,
  Settings,
  TransactionState,
  Target,
  Workspace,
} from "@/ipc/bindings/protocol";
import { dispatch, errorMessage, runQuery } from "@/ipc/client";

interface Activity {
  session?: SessionInfo;
  busy?: "Connecting" | "Running" | "Stopping" | "Fetching";
  results: ResultSet[];
  selected: string | null;
  messages: { level: string; text: string }[];
  elapsed?: number;
  diagnostic?: EditorDiagnostic;
  dbmsOutput?: boolean;
  transaction?: TransactionState;
}

interface Job {
  stopped: boolean;
  sessionId?: string;
  runId?: string;
}

interface Query {
  text: string;
  target: Target;
  mode: RunMode;
}

type Modal =
  | { kind: "password"; name: string; submit: (password: string) => void; cancel?: () => void }
  | { kind: "query"; name: string; reason: string; sql: string; submit: () => void };

const idle: Activity = { results: [], selected: null, messages: [] };

export function useWorkspace() {
  const [profiles, setProfiles] = useState<Connection[]>([]);
  const [workspace, setWorkspace] = useState<Workspace>();
  const [activities, setActivities] = useState<Record<string, Activity>>({});
  const [modal, setModal] = useState<Modal>();
  const [catalogRevision, setCatalogRevision] = useState(0);
  const [historyRevision, setHistoryRevision] = useState(0);
  const [settings, setSettings] = useState<Settings>();
  const [notice, setNotice] = useState("");
  const [loadAttempt, setLoadAttempt] = useState(0);
  const jobs = useRef(new Map<string, Job>());
  const stopping = useRef(new Set<string>());
  const sessions = useRef(new Map<string, SessionInfo>());
  const passwords = useRef(new Map<string, string>());
  const saved = useRef<Workspace | undefined>(undefined);
  const saves = useRef<Promise<unknown>>(Promise.resolve());
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const queueSave = useCallback((snapshot: Workspace) => {
    const save = saves.current
      .catch(() => {})
      .then(async () => {
        if (snapshot === saved.current) return;
        await dispatch("workspace_save", { workspace: snapshot });
        saved.current = snapshot;
      });
    saves.current = save;
    return save;
  }, []);

  useEffect(() => {
    let current = true;
    void dispatch("workspace_bootstrap").then(
      ({ connections, workspace: restored, settings }) => {
        if (!current) return;
        const activeTab = restored.tabs.some((tab) => tab.id === restored.activeTab)
          ? restored.activeTab
          : (restored.tabs[0]?.id ?? null);
        const loaded = { ...restored, activeTab };
        saved.current = loaded;
        setProfiles(connections);
        setSettings(settings);
        setWorkspace(loaded);
        setNotice("");
      },
      (error: unknown) => {
        if (current) setNotice(errorMessage(error));
      },
    );
    return () => {
      current = false;
    };
  }, [loadAttempt]);

  useEffect(() => {
    if (!workspace || workspace === saved.current) return;
    const timer = setTimeout(() => {
      void queueSave(workspace).catch((error: unknown) => setNotice(errorMessage(error)));
    }, 2_000);
    saveTimer.current = timer;
    return () => clearTimeout(timer);
  }, [queueSave, workspace]);

  const tabs = workspace?.tabs ?? [];
  const tab = tabs.find((value) => value.id === workspace?.activeTab);
  const profile = profiles.find((value) => value.id === tab?.connectionId);
  const active = tab ? (activities[tab.id] ?? idle) : idle;

  function selectTab(id: string) {
    setWorkspace((current) => current && { ...current, activeTab: id });
  }

  function addTab(connectionId: string, database?: string, text = "") {
    if (!workspace || workspace.tabs.length >= 100) {
      setNotice("Close a tab before opening another.");
      return;
    }
    const newTab = { id: crypto.randomUUID(), connectionId, database, text };
    setWorkspace((current) => current && { tabs: [...current.tabs, newTab], activeTab: newTab.id });
  }

  function moveTab(direction: number) {
    if (!tab || tabs.length < 2) return;
    const index = tabs.indexOf(tab);
    const next = tabs[(index + direction + tabs.length) % tabs.length];
    if (next) selectTab(next.id);
  }

  function closeSession(id: string) {
    const job = jobs.current.get(id);
    if (job) job.stopped = true;
    const session = sessions.current.get(id);
    sessions.current.delete(id);
    if (session) void dispatch("close_session", { sessionId: session.id }).catch(() => {});
  }

  function closeTab(id: string) {
    closeSession(id);
    jobs.current.delete(id);
    setActivities((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
    setWorkspace((current) => {
      if (!current) return current;
      const remaining = current.tabs.filter((item) => item.id !== id);
      const index = current.tabs.findIndex((item) => item.id === id);
      const activeTab =
        current.activeTab === id
          ? ((remaining[index] ?? remaining[index - 1])?.id ?? null)
          : current.activeTab;
      return { tabs: remaining, activeTab };
    });
  }

  function editText(id: string, text: string) {
    setWorkspace(
      (current) =>
        current && {
          ...current,
          tabs: current.tabs.map((item) => (item.id === id ? { ...item, text } : item)),
        },
    );
  }

  function update(id: string, change: (value: Activity) => Activity) {
    setActivities((current) => ({ ...current, [id]: change(current[id] ?? idle) }));
  }

  function setPanel(id: string, selected: string | null) {
    update(id, (current) => ({ ...current, selected }));
  }

  function saveProfile(value: Connection, password?: string) {
    if (!value.id) return;
    const id = value.id;
    const alreadyExists = profiles.some((existing) => existing.id === id);
    passwords.current.delete(id);
    setCatalogRevision((value) => value + 1);
    if (password !== undefined) passwords.current.set(id, password);
    setProfiles((current) =>
      alreadyExists
        ? current.map((existing) => (existing.id === id ? value : existing))
        : [...current, value],
    );
    if (alreadyExists) {
      for (const item of tabs.filter((item) => item.connectionId === id)) {
        closeSession(item.id);
        jobs.current.delete(item.id);
        update(item.id, () => idle);
      }
    } else {
      addTab(id);
    }
  }

  async function deleteProfile(id: string) {
    try {
      await dispatch("delete_connection", { id });
      passwords.current.delete(id);
      setCatalogRevision((value) => value + 1);
      setProfiles((current) => current.filter((value) => value.id !== id));
      for (const item of tabs.filter((item) => item.connectionId === id)) {
        closeSession(item.id);
        jobs.current.delete(item.id);
        update(item.id, () => idle);
      }
    } catch (error) {
      setNotice(errorMessage(error));
    }
  }

  function receive(
    id: string,
    query: Query,
    event: RunEvent,
    spans: Map<number, [number, number]>,
  ) {
    switch (event.type) {
      case "statementStart":
        spans.set(event.index, event.span);
        break;
      case "resultStart":
        update(id, (current) => ({
          ...current,
          selected: current.selected ?? event.cursorId,
          results: [
            ...current.results,
            {
              id: event.cursorId,
              columns: event.columns,
              index: event.resultIndex,
              rows: event.rows,
              more: false,
              capped: false,
            },
          ],
        }));
        break;
      case "rows":
        update(id, (current) =>
          withResult(current, event.cursorId, (result) => ({
            ...result,
            rows: [...result.rows, ...event.rows],
          })),
        );
        break;
      case "resultPaused":
      case "resultEnd":
        update(id, (current) =>
          withResult(current, event.cursorId, (result) => ({
            ...result,
            more: event.type === "resultPaused",
            capped: event.type === "resultEnd" && event.capped,
          })),
        );
        break;
      case "affected":
        appendMessage(
          id,
          "info",
          `Statement ${event.statementIndex + 1} · ${event.rows.toLocaleString()} rows affected`,
        );
        break;
      case "message":
        appendMessage(id, event.level, event.text);
        break;
      case "error": {
        const span = spans.get(event.statementIndex);
        const error = event.error;
        if (error.kind === "bridge") closeSession(id);
        update(id, (current) => ({
          ...current,
          selected: error.kind === "cancelled" ? current.selected : "messages",
          messages: [
            ...current.messages,
            { level: error.kind === "cancelled" ? "info" : "error", text: error.message },
          ],
          session: error.kind === "bridge" ? undefined : current.session,
          diagnostic: span && error.kind === "db" ? { text: query.text, span, error } : undefined,
        }));
        break;
      }
      case "transactionState":
        update(id, (current) => ({
          ...current,
          transaction: { manual: event.manual, open: event.open },
        }));
        break;
      case "catalogChanged":
        setCatalogRevision((value) => value + 1);
        break;
      case "done":
        setHistoryRevision((value) => value + 1);
        update(id, (current) => ({
          ...current,
          elapsed: event.elapsedMs,
          messages: [
            ...current.messages,
            {
              level: "info",
              text: `${event.statements} statements completed · ${event.elapsedMs} ms`,
            },
          ],
        }));
    }
  }

  function appendMessage(id: string, level: string, text: string, show = false) {
    update(id, (current) => ({
      ...current,
      selected: show ? "messages" : current.selected,
      messages: [...current.messages, { level, text }],
    }));
  }

  async function execute(
    item: SavedTab,
    connection: Connection,
    query?: Query,
    confirmed = false,
    password?: string,
  ) {
    if (!connection.id || jobs.current.has(item.id) || stopping.current.has(item.id)) return;
    const existing = sessions.current.get(item.id);
    const credential = password ?? passwords.current.get(connection.id);
    if (
      !existing &&
      connection.secret === "prompt" &&
      connection.options?.auth !== "windows" &&
      credential === undefined
    ) {
      setModal({
        kind: "password",
        name: connection.name,
        submit: (value) => {
          setModal(undefined);
          void execute(item, connection, query, confirmed, value);
        },
      });
      return;
    }
    const job: Job = {
      stopped: false,
      sessionId: existing?.id,
      runId: query ? crypto.randomUUID() : undefined,
    };
    jobs.current.set(item.id, job);
    update(item.id, (current) => ({ ...current, busy: existing ? "Running" : "Connecting" }));
    try {
      const session =
        existing ??
        (await dispatch("open_session", {
          connectionId: connection.id,
          database: item.database,
          password: credential,
        }));
      if (job.stopped) {
        if (!existing) await dispatch("close_session", { sessionId: session.id });
        return;
      }
      job.sessionId = session.id;
      sessions.current.set(item.id, session);
      if (connection.secret === "prompt" && credential !== undefined)
        passwords.current.set(connection.id, credential);
      update(item.id, (current) =>
        query
          ? {
              ...idle,
              session,
              busy: "Running",
              dbmsOutput: current.dbmsOutput,
              transaction: current.transaction,
            }
          : { ...current, session },
      );
      if (query && job.runId) {
        await loadResultGrid();
        if (job.stopped || jobs.current.get(item.id) !== job) return;
        const spans = new Map<number, [number, number]>();
        await runQuery(
          { ...query, runId: job.runId, sessionId: session.id, confirmed },
          (event) => {
            if (jobs.current.get(item.id) === job) receive(item.id, query, event, spans);
          },
        );
      }
    } catch (error) {
      if (jobs.current.get(item.id) !== job || job.stopped) return;
      const message = errorMessage(error);
      if (!job.sessionId && connection.secret === "prompt") passwords.current.delete(connection.id);
      if (
        message.includes("Session does not exist") ||
        message.includes("disconnected") ||
        message.includes("Oracle bridge") ||
        message.includes("connection closed")
      ) {
        closeSession(item.id);
        update(item.id, (current) => ({ ...current, session: undefined }));
      }
      appendMessage(item.id, "error", message, true);
    } finally {
      if (jobs.current.get(item.id) === job) {
        jobs.current.delete(item.id);
        update(item.id, (current) => ({
          ...current,
          busy: stopping.current.has(item.id) ? "Stopping" : undefined,
        }));
      }
    }
  }

  async function run(query: Query) {
    if (!tab || !profile || jobs.current.has(tab.id) || stopping.current.has(tab.id)) return;
    const job = { stopped: false };
    jobs.current.set(tab.id, job);
    try {
      const plan = await dispatch("plan_query", { ...query, production: profile.env === "prod" });
      if (job.stopped) return;
      if (plan.statements.length === 0) {
        appendMessage(tab.id, "info", "No SQL statement selected.", true);
      } else if (plan.confirmation) {
        const sql = plan.statements
          .map(([start, end]) => query.text.slice(start, end))
          .join("\n\n");
        setModal({
          kind: "query",
          name: profile.name,
          reason: plan.confirmation,
          sql,
          submit: () => {
            setModal(undefined);
            void execute(tab, profile, query, true);
          },
        });
      } else {
        jobs.current.delete(tab.id);
        void execute(tab, profile, query);
      }
    } catch (error) {
      if (!job.stopped) appendMessage(tab.id, "error", errorMessage(error), true);
    } finally {
      if (jobs.current.get(tab.id) === job) jobs.current.delete(tab.id);
    }
  }

  async function stop() {
    if (!tab || stopping.current.has(tab.id)) return;
    const job = jobs.current.get(tab.id);
    if (job) job.stopped = true;
    const sessionId = job?.sessionId ?? sessions.current.get(tab.id)?.id;
    if (!sessionId) return;
    stopping.current.add(tab.id);
    update(tab.id, (current) => ({ ...current, busy: "Stopping" }));
    try {
      await dispatch("stop", { sessionId, runId: job?.runId });
    } catch (error) {
      appendMessage(tab.id, "error", errorMessage(error), true);
    } finally {
      stopping.current.delete(tab.id);
      update(tab.id, (current) => ({
        ...current,
        busy: jobs.current.has(tab.id) ? "Stopping" : undefined,
        results: current.results.map((result) => ({ ...result, more: false })),
      }));
    }
  }

  async function fetchRows(result: ResultSet, all = false) {
    if (
      !tab ||
      !active.session ||
      !result.more ||
      jobs.current.has(tab.id) ||
      stopping.current.has(tab.id)
    )
      return;
    const sessionId = active.session.id;
    const job: Job = { sessionId, stopped: false };
    jobs.current.set(tab.id, job);
    update(tab.id, (current) => ({ ...current, busy: "Fetching" }));
    try {
      do {
        const page = await dispatch("fetch_more", { sessionId, cursorId: result.id, count: 500 });
        if (job.stopped) break;
        update(tab.id, (current) => {
          const next = withResult(current, result.id, (prior) => ({
            ...prior,
            rows: [...prior.rows, ...page.rows],
            more: !page.exhausted,
            capped: page.capped,
          }));
          return {
            ...next,
            messages: [
              ...next.messages,
              ...page.messages.map(([level, text]) => ({ level, text })),
            ],
          };
        });
        let nextCursor = page.nextResult ? result.id : undefined;
        while (nextCursor && !job.stopped) {
          const next = await dispatch("next_result", {
            sessionId,
            cursorId: nextCursor,
            count: 500,
          });
          if (job.stopped) break;
          update(tab.id, (current) => ({
            ...current,
            results: [
              ...current.results,
              {
                id: next.cursorId,
                index: (current.results.at(-1)?.index ?? -1) + 1,
                columns: next.columns,
                rows: next.page.rows,
                more: !next.page.exhausted,
                capped: next.page.capped,
              },
            ],
            messages: [
              ...current.messages,
              ...next.page.messages.map(([level, text]) => ({ level, text })),
            ],
          }));
          nextCursor = next.page.nextResult ? next.cursorId : undefined;
        }
        if (page.exhausted) break;
      } while (all && !job.stopped);
    } catch (error) {
      if (!job.stopped) {
        update(tab.id, (current) =>
          withResult(current, result.id, (prior) => ({ ...prior, more: false })),
        );
        appendMessage(tab.id, "error", errorMessage(error), true);
      }
    } finally {
      if (jobs.current.get(tab.id) === job) {
        jobs.current.delete(tab.id);
        update(tab.id, (current) => ({
          ...current,
          busy: stopping.current.has(tab.id) ? "Stopping" : undefined,
        }));
      }
    }
  }

  function getCell(result: ResultSet, row: number, column: number): Promise<Cell> {
    if (!active.session) return Promise.reject(new Error("This result's session has closed."));
    return dispatch("get_cell", { sessionId: active.session.id, cursorId: result.id, row, column });
  }

  function transactionAtRisk(id: string) {
    const value = activities[id];
    return !!value?.transaction?.open || (!!value?.transaction?.manual && !!value.busy);
  }

  async function transactionMode(manual: boolean) {
    if (!tab || !active.session || active.busy) return;
    try {
      const transaction = await dispatch("set_transaction_mode", {
        sessionId: active.session.id,
        manual,
      });
      update(tab.id, (current) => ({ ...current, transaction }));
    } catch (error) {
      setNotice(errorMessage(error));
    }
  }

  async function finishTransaction(commit: boolean) {
    if (!tab || !active.session || active.busy) return;
    try {
      const transaction = await dispatch("finish_transaction", {
        sessionId: active.session.id,
        commit,
      });
      update(tab.id, (current) => ({
        ...current,
        transaction,
        results: current.results.map((result) => ({ ...result, more: false })),
      }));
    } catch (error) {
      setNotice(errorMessage(error));
    }
  }

  async function saveWorkspace() {
    clearTimeout(saveTimer.current);
    if (workspace) await queueSave(workspace);
  }

  async function closeWorkspace() {
    const open = Array.from(sessions.current.values(), ({ id }) =>
      dispatch("close_session", { sessionId: id }),
    );
    await Promise.all(open);
    await saveWorkspace();
  }

  async function toggleDbmsOutput() {
    if (!tab || !active.session || active.busy) return;
    const enabled = !active.dbmsOutput;
    try {
      await dispatch("set_dbms_output", { sessionId: active.session.id, enabled });
      update(tab.id, (current) => ({ ...current, dbmsOutput: enabled }));
    } catch (error) {
      setNotice(errorMessage(error));
    }
  }

  function scope(connection: Connection, database?: string, prompt = false): Promise<CatalogScope> {
    const connectionId = connection.id;
    if (!connectionId) return Promise.reject(new Error("Save the connection first."));
    const credentials = passwords.current.get(connectionId);
    if (
      connection.secret !== "prompt" ||
      connection.options?.auth === "windows" ||
      credentials !== undefined ||
      !prompt
    ) {
      return Promise.resolve({
        connectionId,
        database: database ?? null,
        password: credentials ?? null,
      });
    }
    return new Promise((resolve, reject) => {
      setModal({
        kind: "password",
        name: connection.name,
        cancel: () => reject(new Error("Enter a password to browse this connection.")),
        submit(value) {
          setModal(undefined);
          passwords.current.set(connectionId, value);
          resolve({ connectionId, database: database ?? null, password: value });
        },
      });
    });
  }

  function dismissModal() {
    if (modal?.kind === "password") modal.cancel?.();
    setModal(undefined);
  }

  function setDatabase(id: string, database: string) {
    closeSession(id);
    jobs.current.delete(id);
    update(id, () => idle);
    setWorkspace(
      (current) =>
        current && {
          ...current,
          tabs: current.tabs.map((item) => (item.id === id ? { ...item, database } : item)),
        },
    );
    setCatalogRevision((value) => value + 1);
  }

  return {
    profiles,
    toggleDbmsOutput,
    transactionAtRisk,
    transactionMode,
    finishTransaction,
    closeWorkspace,
    saveWorkspace,
    hasRunningJobs: () => jobs.current.size > 0 || stopping.current.size > 0,
    settings,
    applySettings: (settings: Settings) => {
      setSettings(settings);
      setCatalogRevision((value) => value + 1);
    },
    hasOpenTransactions: tabs.some((tab) => transactionAtRisk(tab.id)),
    catalogRevision,
    historyRevision,
    scope,
    dismissModal,
    setDatabase,
    invalidateCatalog: () => setCatalogRevision((value) => value + 1),
    workspace,
    tabs,
    tab,
    profile,
    active,
    notice,
    modal,
    setModal,
    setNotice,
    retry: () => setLoadAttempt((value) => value + 1),
    selectTab,
    addTab,
    moveTab,
    closeTab,
    editText,
    setPanel,
    saveProfile,
    deleteProfile,
    connect: () => {
      if (tab && profile) void execute(tab, profile);
    },
    disconnect: () => {
      if (tab) {
        closeSession(tab.id);
        jobs.current.delete(tab.id);
        update(tab.id, () => idle);
      }
    },
    run,
    stop,
    fetchRows,
    getCell,
  };
}

function withResult(current: Activity, id: string, change: (result: ResultSet) => ResultSet) {
  return {
    ...current,
    results: current.results.map((result) => (result.id === id ? change(result) : result)),
  };
}
