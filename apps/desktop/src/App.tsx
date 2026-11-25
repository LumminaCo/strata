import { getCurrentWindow, UserAttentionType } from "@tauri-apps/api/window";
import type { EditorState } from "@codemirror/state";
import {
  Cable,
  ChevronRight,
  Copy,
  Database,
  Download,
  ShieldCheck,
  History,
  Command as CommandIcon,
  FolderOpen,
  Save,
  Monitor,
  Moon,
  Play,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  Square,
  Sun,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { DatabaseIcon } from "@/components/database-icon";
import { ResultGrid } from "@/components/load-result-grid";
import type { ResultSet } from "@/components/result-grid";
import { SqlEditor, type EditorHandle } from "@/components/sql-editor";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import {
  Confirmation,
  ConnectionDialog,
  PasswordDialog,
  emptyConnection,
} from "@/features/connections";
import { AgentActivity } from "@/features/agent-activity";
import { CatalogExplorer, type CatalogEntry } from "@/features/catalog-explorer";
import {
  CatalogPalette,
  DatabasePicker,
  QueryHistory,
  SchemaPicker,
} from "@/features/catalog-dialogs";
import { SettingsDialog } from "@/features/settings";
import {
  QueryNotificationStack,
  appendQueryToast,
  type QueryCompletion,
} from "@/features/query-notifications";
import { playQuerySound, primeQuerySound } from "@/features/query-sound";
import {
  isSqlTabUnsaved,
  recordSavedSqlTab,
  removeSavedSqlTabs,
  saveSqlFile as persistSqlFile,
  type SavedSqlState,
} from "@/features/save-sql-file";
import {
  PinnedInspectionTabItem,
  ResultTabItem,
  SchemaTabItem,
  ScriptTabItem,
} from "@/features/tab-controls";
import {
  defaultResultTabLabel,
  defaultScriptTabLabel,
  moveItemByOffset,
  reorderById,
  resultTabLabel,
  scriptTabLabel,
} from "@/features/tab-order";
import { TableInspector, type Inspection } from "@/features/table-inspector";
import { useCatalogSchema } from "@/features/use-catalog-schema";
import { shortcuts, workspaceKeydown } from "@/features/keymap";
import { useTabDrag } from "@/features/use-tab-drag";
import { useWorkspace } from "@/features/use-workspace";
import { useAppUpdate } from "@/features/use-app-update";
import type { Cell, Connection, RunMode } from "@/ipc/bindings/protocol";
import { browserMode, dispatch, errorMessage } from "@/ipc/client";
import strataLogo from "../../../dev/strata-logo.png";

const themes = ["system", "light", "dark"] as const;
const themeIcons = { system: Monitor, light: Sun, dark: Moon };
const environments = { dev: "Development", staging: "Staging", prod: "Production" };

function readTheme() {
  const saved = localStorage.getItem("strata.theme");
  return themes.find((theme) => theme === saved) ?? "system";
}

export function App() {
  const [queryToasts, setQueryToasts] = useState<QueryCompletion[]>([]);
  const notificationPrefs = useRef({ toast: true, sound: true });
  const data = useWorkspace({
    onQueryComplete(completion) {
      const { toast, sound } = notificationPrefs.current;
      if (toast) {
        setQueryToasts((current) => appendQueryToast(current, completion));
      }
      if (sound) {
        playQuerySound(completion.status);
      }
      if ((toast || sound) && !browserMode && !document.hasFocus()) {
        void getCurrentWindow()
          .requestUserAttention(UserAttentionType.Informational)
          .catch(() => {});
      }
    },
  });
  notificationPrefs.current = {
    toast: data.settings?.notify_on_query_complete ?? true,
    sound: data.settings?.notify_sound ?? true,
  };
  const update = useAppUpdate(data.saveWorkspace, data.setNotice);
  const { tab, profile, active } = data;
  const [theme, setTheme] = useState(readTheme);
  const [systemDark, setSystemDark] = useState(
    () => matchMedia("(prefers-color-scheme: dark)").matches,
  );
  const [connectionEditor, editConnection] = useState<Connection>();
  const [deletion, setDeletion] = useState<Connection>();
  const [valueView, setValueView] = useState<{ name: string; text: string }>();
  const [filterResult, setFilterResult] = useState<{ cursor: string; text: string }>();
  const [explorerOpen, setExplorerOpen] = useState(true);
  const [palette, setPalette] = useState(false);
  const [history, setHistory] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [closeWarning, setCloseWarning] = useState<{ title: string; confirm: () => void }>();
  const windowState = useRef({
    dirty: data.hasOpenTransactions,
    close: data.closeWorkspace,
    notice: data.setNotice,
  });
  windowState.current = {
    dirty: data.hasOpenTransactions,
    close: data.closeWorkspace,
    notice: data.setNotice,
  };
  const [agentActivity, setAgentActivity] = useState(false);
  const [schemaTabs, setSchemaTabs] = useState<Inspection[]>([]);
  const [schemaSelected, setSchemaSelected] = useState<string>();
  const [pinnedByTab, setPinned] = useState<Record<string, Inspection[]>>({});
  const [renamingScriptTabId, setRenamingScriptTabId] = useState<string | null>(null);
  const [renamingResultTab, setRenamingResultTab] = useState<{
    tabId: string;
    resultId: string;
  } | null>(null);
  const [resolveTip, setResolveTip] = useState("");
  const resolution = useRef(0);
  const inspectionRequest = useRef(0);
  const schemaActive = schemaTabs.find((item) => inspectionKey(item) === schemaSelected);
  const pinned = tab ? (pinnedByTab[tab.id] ?? []) : [];
  const [entries, setEntries] = useState<CatalogEntry[]>([]);
  const defaultSchema =
    active.session?.schema ??
    tab?.schema ??
    (profile?.kind === "sqlserver"
      ? "dbo"
      : profile?.kind === "oracle"
        ? profile.user.toUpperCase()
        : "public");
  const catalog = useCatalogSchema(profile, tab, data.catalogRevision, defaultSchema, data.scope);
  const editor = useRef<EditorHandle>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const editors = useRef(new Map<string, { current: EditorState | null }>());
  const [savedSqlByTab, setSavedSqlByTab] = useState<Record<string, SavedSqlState>>({});
  const savingSql = useRef(false);
  const filterInput = useRef<HTMLInputElement>(null);
  const ThemeIcon = themeIcons[theme];
  const dark = theme === "dark" || (theme === "system" && systemDark);
  const editorState = tab ? editors.current.get(tab.id) : undefined;
  const selected = active.selected ?? (active.messages.length ? "messages" : null);
  const selectedInspection = pinned.find((item) => inspectionKey(item) === selected);
  const result = active.results.find((entry) => entry.id === selected);
  const fetchingResult = !!result && active.fetching === result.id;
  const showFilter = !!result && filterResult?.cursor === result.id;
  const scriptTabDrag = useTabDrag({
    disabled: renamingScriptTabId !== null,
    onReorder: (activeId, targetId, placement) => data.reorderTabs(activeId, targetId, placement),
  });
  const schemaTabDrag = useTabDrag({
    onReorder: (activeId, targetId, placement) =>
      setSchemaTabs((current) =>
        reorderById(current, activeId, targetId, placement, inspectionKey),
      ),
  });
  const resultTabDrag = useTabDrag({
    disabled: !tab || renamingResultTab !== null,
    onReorder: (activeId, targetId, placement) => {
      if (tab) data.reorderResults(tab.id, activeId, targetId, placement);
    },
  });
  const pinnedTabDrag = useTabDrag({
    disabled: !tab,
    onReorder: (activeId, targetId, placement) => {
      if (!tab) return;
      setPinned((current) => {
        const list = current[tab.id] ?? [];
        const next = reorderById(list, activeId, targetId, placement, inspectionKey);
        return next === list ? current : { ...current, [tab.id]: next };
      });
    },
  });

  useEffect(() => {
    const preference = matchMedia("(prefers-color-scheme: dark)");
    const apply = () => setSystemDark(preference.matches);
    preference.addEventListener("change", apply);
    return () => preference.removeEventListener("change", apply);
  }, []);
  useLayoutEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);
  useLayoutEffect(() => {
    if (showFilter) filterInput.current?.focus();
  }, [showFilter]);

  useEffect(() => {
    if (browserMode) {
      const beforeUnload = (event: BeforeUnloadEvent) => {
        if (!windowState.current.dirty) return;
        event.preventDefault();
        event.returnValue = "";
      };
      window.addEventListener("beforeunload", beforeUnload);
      return () => window.removeEventListener("beforeunload", beforeUnload);
    }
    const native = getCurrentWindow();
    const unlisten = native.onCloseRequested((event) => {
      event.preventDefault();
      if (update.installing.current) return;
      const close = () => {
        void windowState.current
          .close()
          .then(() => native.destroy())
          .catch((error: unknown) => windowState.current.notice(errorMessage(error)));
      };
      if (windowState.current.dirty) setCloseWarning({ title: "Close Strata?", confirm: close });
      else close();
    });
    void unlisten.catch((error: unknown) => windowState.current.notice(errorMessage(error)));
    return () => {
      void unlisten.then((dispose) => dispose()).catch(() => {});
    };
  }, [update.installing]);

  useLayoutEffect(() => {
    if (!data.settings) return;
    document.documentElement.style.setProperty(
      "--editor-font-size",
      `${data.settings.editor_font_size}px`,
    );
    if (!localStorage.getItem("strata.theme")) setTheme(data.settings.theme);
  }, [data.settings]);

  function changeTheme() {
    const next = themes[(themes.indexOf(theme) + 1) % themes.length] ?? "system";
    localStorage.setItem("strata.theme", next);
    setTheme(next);
  }

  function run(mode: RunMode, keepResults = false) {
    if (!editor.current || active.busy || schemaActive) return;
    if (notificationPrefs.current.sound) primeQuerySound();
    void data.run({
      text: editor.current.text(),
      target: editor.current.target(),
      mode,
      keepResults,
    });
  }

  function openTab(id: string, database?: string, text?: string, schema?: string): string | null {
    setSchemaSelected(undefined);
    const profile = data.profiles.find((entry) => entry.id === id);
    const existing = data.tabs.find(
      (item) =>
        item.connectionId === id &&
        (item.database ?? profile?.database) === (database ?? profile?.database),
    );
    if (existing && text === undefined) {
      data.selectTab(existing.id);
      return existing.id;
    }
    return data.addTab(id, database, text, schema);
  }

  function openObject(entry: Inspection) {
    const key = inspectionKey(entry);
    const hasExplicitTarget = entry.section !== undefined || entry.column !== undefined;
    setSchemaTabs((items) => {
      const exists = items.some((item) => inspectionKey(item) === key);
      if (!exists) {
        return [...items, { ...entry, requestId: ++inspectionRequest.current }];
      }
      if (!hasExplicitTarget) {
        return items.map((item) =>
          inspectionKey(item) === key
            ? { ...item, connection: entry.connection, object: entry.object }
            : item,
        );
      }
      const next: Inspection = { ...entry, requestId: ++inspectionRequest.current };
      return items.map((item) => (inspectionKey(item) === key ? next : item));
    });
    setSchemaSelected(key);
    setPalette(false);
  }

  function pinObject(entry: Inspection) {
    if (!tab) return;
    const next: Inspection = { ...entry, requestId: ++inspectionRequest.current };
    const key = inspectionKey(next);
    setSchemaSelected(undefined);
    setPinned((current) => ({
      ...current,
      [tab.id]: [...(current[tab.id] ?? []).filter((item) => inspectionKey(item) !== key), next],
    }));
    data.setPanel(tab.id, key);
  }

  async function copyText(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text);
      data.setNotice(`Copied ${label}.`);
    } catch (error) {
      data.setNotice(errorMessage(error));
    }
  }

  async function copyObjectDdl(entry: CatalogEntry) {
    const label = `${entry.object.schema}.${entry.object.name}`;
    try {
      const scope = await data.scope(entry.connection, entry.database, true);
      const details = await dispatch("object_details", { scope, object: entry.object });
      await navigator.clipboard.writeText(details.ddl);
      data.setNotice(`Copied DDL for ${label}.`);
    } catch (error) {
      data.setNotice(errorMessage(error));
    }
  }

  function closeManyTabs(ids: string[], approved = false) {
    if (ids.length === 0) return;
    if (!approved) {
      const atRisk = ids.filter((id) => data.transactionAtRisk(id));
      if (atRisk.length > 0) {
        setCloseWarning({
          title: atRisk.length === 1 ? "Close SQL tab?" : `Close ${atRisk.length} SQL tabs?`,
          confirm: () => closeManyTabs(ids, true),
        });
        return;
      }
    }
    const closing = new Set(ids);
    data.closeTabs(ids);
    for (const id of closing) {
      editors.current.delete(id);
    }
    setSavedSqlByTab((current) => removeSavedSqlTabs(current, closing));
    setRenamingScriptTabId((current) => (current && closing.has(current) ? null : current));
    setRenamingResultTab((current) => (current && closing.has(current.tabId) ? null : current));
    setQueryToasts((current) => current.filter((item) => !closing.has(item.tabId)));
    setPinned((current) => {
      let changed = false;
      const next = { ...current };
      for (const id of closing) {
        if (id in next) {
          delete next[id];
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }

  function closeTab(id: string, approved = false) {
    closeManyTabs([id], approved);
  }

  function closeResultTabs(tabId: string, resultIds: string[]) {
    if (resultIds.length === 0) return;
    const closing = new Set(resultIds);
    data.closeResults(tabId, resultIds);
    setFilterResult((current) => (current && closing.has(current.cursor) ? undefined : current));
    setRenamingResultTab((current) =>
      current && current.tabId === tabId && closing.has(current.resultId) ? null : current,
    );
  }

  function closePinnedInspection(tabId: string, key: string) {
    const remaining = (pinnedByTab[tabId] ?? []).filter((entry) => inspectionKey(entry) !== key);
    setPinned((current) => ({
      ...current,
      [tabId]: (current[tabId] ?? []).filter((entry) => inspectionKey(entry) !== key),
    }));
    if (selected === key) {
      const fallback =
        active.results[0]?.id ??
        (remaining[0] ? inspectionKey(remaining[0]) : null) ??
        (active.messages.length ? "messages" : null);
      data.setPanel(tabId, fallback);
    }
  }

  async function navigate(offset: number, full: boolean) {
    if (!tab || !profile || !editor.current || schemaActive) return;
    const request = ++resolution.current;
    const text = editor.current.text();
    setResolveTip("");
    try {
      const scope = await data.scope(profile, tab.database, true);
      const object = await dispatch("resolve_at", {
        scope,
        text,
        offset,
        sessionId: active.session?.id,
        schema: active.session ? undefined : defaultSchema,
      });
      if (resolution.current !== request) return;
      if (!object) {
        setResolveTip("No matching object in the search path.");
        setTimeout(() => {
          if (resolution.current === request) setResolveTip("");
        }, 3000);
        return;
      }
      const entry = {
        connection: profile,
        database: object.database,
        object: object.object,
        column: object.column ?? undefined,
      };
      if (full || ["function", "procedure"].includes(entry.object.kind)) {
        openObject(entry);
      } else {
        pinObject(entry);
      }
    } catch (error) {
      if (resolution.current !== request) return;
      setResolveTip(errorMessage(error));
      setTimeout(() => {
        if (resolution.current === request) setResolveTip("");
      }, 3000);
    }
  }

  async function formatSql() {
    const current = editor.current;
    if (!current || !profile || schemaActive) return;
    try {
      const { format } = await import("sql-formatter");
      if (editor.current !== current) return;
      const sql = current.text();
      const target = current.target();
      const range = "selection" in target ? target.selection : undefined;
      const language = {
        postgres: "postgresql",
        sqlserver: "transactsql",
        oracle: "plsql",
      } as const;
      const result = format(range ? sql.slice(...range) : sql, {
        language: language[profile.kind],
        keywordCase: "upper",
      });
      current.replace(result, range);
    } catch (error) {
      data.setNotice(errorMessage(error));
    }
  }

  async function openSqlFile(file: File) {
    if (!profile?.id) return;
    if (file.size > 8_000_000) {
      data.setNotice("The SQL file exceeds 8 MB.");
      return;
    }
    try {
      const content = await file.text();
      const tabId = openTab(profile.id, tab?.database, content, tab?.schema);
      if (tabId) {
        setSavedSqlByTab((current) => recordSavedSqlTab(current, tabId, content, file.name));
      }
    } catch (error) {
      data.setNotice(errorMessage(error));
    }
  }

  async function saveSqlFile() {
    if (!tab || !editor.current || schemaActive || savingSql.current) return;
    const tabId = tab.id;
    const content = editor.current.text();
    const suggestedPath = savedSqlByTab[tabId]?.path;
    savingSql.current = true;
    try {
      const savedPath = await persistSqlFile(content, suggestedPath);
      if (!savedPath) return;
      if (editors.current.has(tabId)) {
        setSavedSqlByTab((current) => recordSavedSqlTab(current, tabId, content, savedPath));
      }
      data.setNotice(`Saved SQL to ${savedPath}.`);
    } catch (error) {
      data.setNotice(errorMessage(error));
    } finally {
      savingSql.current = false;
    }
  }

  function showCell(name: string, value: Cell, kind?: string) {
    let text = value === null ? "NULL" : String(value);
    if (kind === "json" && typeof value === "string") {
      try {
        text = JSON.stringify(JSON.parse(value), null, 2);
      } catch {
        /* Render the original value. */
      }
    }
    setValueView({ name, text });
  }

  async function openCell(item: ResultSet, row: number, column: number) {
    try {
      const meta = item.columns[column];
      showCell(meta?.name ?? "Value", await data.getCell(item, row, column), meta?.kind);
    } catch (error) {
      data.setNotice(errorMessage(error));
    }
  }

  function inspectionCredentials(entry: CatalogEntry) {
    return data.scope(entry.connection, entry.database, true);
  }

  function installUpdate(): string | null {
    if (data.hasRunningJobs()) {
      const message = "A query is still running. Wait for it to finish, then click Update again.";
      data.setNotice(message);
      return message;
    }
    if (data.hasOpenTransactions) {
      const message = "Commit or roll back open transactions before updating Strata.";
      data.setNotice(message);
      return message;
    }
    setSettingsOpen(false);
    void update.install();
    return null;
  }

  // Keep CodeMirror's undo history and selection while switching between tabs.
  let state = editorState;
  if (tab && !state) {
    state = { current: null };
    editors.current.set(tab.id, state);
  }

  return (
    <div
      className="workspace"
      data-env={profile?.env}
      onKeyDownCapture={(event) => {
        if (
          connectionEditor ||
          deletion ||
          valueView ||
          data.modal ||
          palette ||
          history ||
          agentActivity ||
          settingsOpen ||
          closeWarning ||
          update.status ||
          renamingScriptTabId !== null ||
          renamingResultTab !== null ||
          event.defaultPrevented
        )
          return;
        const handled = workspaceKeydown(
          event.nativeEvent,
          {
            run: () => run("statement"),
            runInNewTab: () => run("statement", true),
            script: () => run("script"),
            stop: () => void data.stop(),
            newTab: () => {
              if (profile?.id) data.addTab(profile.id);
            },
            closeTab: () => {
              if (schemaSelected) {
                setSchemaTabs((tabs) =>
                  tabs.filter((item) => inspectionKey(item) !== schemaSelected),
                );
                setSchemaSelected(undefined);
              } else if (tab) closeTab(tab.id);
            },
            nextTab: () => {
              setSchemaSelected(undefined);
              data.moveTab(1);
            },
            previousTab: () => {
              setSchemaSelected(undefined);
              data.moveTab(-1);
            },
            palette: () => setPalette(true),
            history: () => setHistory(true),
            explorer: () => setExplorerOpen((open) => !open),
            navigate: () => {
              const target = editor.current?.target();
              if (target)
                void navigate("cursor" in target ? target.cursor : target.selection[0], false);
            },
            explain: () => run("explain"),
            format: () => void formatSql(),
            openSql: () => {
              if (profile) fileInput.current?.click();
            },
            saveSql: () => void saveSqlFile(),
          },
          browserMode,
        );
        if (handled) event.stopPropagation();
      }}
    >
      <input
        type="file"
        accept=".sql,text/plain"
        hidden
        ref={fileInput}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (file) void openSqlFile(file);
        }}
      />
      <header className="toolbar">
        <div className="brand">
          <img src={strataLogo} alt="" width={24} height={24} />
          <span>Strata</span>
        </div>
        <div className="toolbar-actions">
          {!browserMode &&
            (update.version ? (
              <Button
                variant="outline"
                disabled={!data.workspace || !!update.status}
                title={`Update to Strata ${update.version}`}
                onClick={installUpdate}
              >
                <Download /> Update
              </Button>
            ) : (
              <Button
                variant="ghost"
                size="icon-sm"
                title={update.checking ? "Checking for updates…" : "Check for updates"}
                aria-label={update.checking ? "Checking for updates" : "Check for updates"}
                disabled={update.checking || !!update.status}
                onClick={() => void update.check()}
              >
                <RefreshCw className={update.checking ? "update-check-spin" : undefined} />
              </Button>
            ))}
          <Button
            variant="ghost"
            size="icon-sm"
            title="Settings"
            aria-label="Settings"
            disabled={!data.settings}
            onClick={() => setSettingsOpen(true)}
          >
            <Settings2 />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            title="Agent activity"
            aria-label="Agent activity"
            onClick={() => setAgentActivity(true)}
          >
            <ShieldCheck />
          </Button>
          {!browserMode && (
            <Button
              variant="ghost"
              onClick={() =>
                void dispatch("mcp_config")
                  .then((config) => navigator.clipboard.writeText(JSON.stringify(config, null, 2)))
                  .then(() => data.setNotice("MCP configuration copied."))
                  .catch((error: unknown) => data.setNotice(errorMessage(error)))
              }
            >
              Copy MCP config
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon-sm"
            title="Quick open (Ctrl+K)"
            aria-label="Quick open"
            onClick={() => setPalette(true)}
          >
            <CommandIcon />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            title="Query history (Ctrl+H)"
            aria-label="Query history"
            onClick={() => setHistory(true)}
          >
            <History />
          </Button>
          <Button
            variant="ghost"
            onClick={changeTheme}
            aria-label={`Theme: ${theme}. Change theme.`}
            title="Change theme"
          >
            <ThemeIcon />{" "}
            <span>{theme === "system" ? "System" : theme === "light" ? "Light" : "Dark"}</span>
          </Button>
          <Button
            variant="outline"
            onClick={() => editConnection(emptyConnection)}
            disabled={!data.workspace}
          >
            <Plus /> New connection
          </Button>
        </div>
      </header>

      <div className="workspace-body" data-explorer-open={explorerOpen}>
        <aside className="explorer" aria-label="Connections">
          <div className="sidebar-heading">
            <h2>Connections</h2>
            <Button
              size="icon-xs"
              variant="ghost"
              title="Collapse connections"
              aria-label="Collapse connections"
              onClick={() => setExplorerOpen(false)}
            >
              <ChevronRight />
            </Button>
          </div>
          <CatalogExplorer
            profiles={data.profiles}
            active={profile?.id}
            revision={data.catalogRevision}
            canPin={!!tab}
            canInsertInEditor={Boolean(tab && !schemaActive)}
            scope={data.scope}
            onSnapshot={catalog.capture}
            onEntries={setEntries}
            openSql={openTab}
            onRefresh={data.invalidateCatalog}
            onObject={openObject}
            onPinObject={pinObject}
            onInsertText={(text) => editor.current?.insert(text)}
            onCopyText={(text, label) => void copyText(text, label)}
            onCopyDdl={(entry) => void copyObjectDdl(entry)}
            onEditConnection={(connection) => editConnection(connection)}
            onDuplicateConnection={(connection) =>
              editConnection({ ...connection, id: null, name: `${connection.name} copy` })
            }
            onDeleteConnection={(connection) => setDeletion(connection)}
          />
          {profile?.id && (
            <div className="profile-actions">
              <Button
                variant="ghost"
                size="icon-sm"
                title="Edit connection"
                aria-label="Edit connection"
                onClick={() => editConnection(profile)}
              >
                <Settings2 />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                title="Duplicate connection"
                aria-label="Duplicate connection"
                onClick={() =>
                  editConnection({ ...profile, id: null, name: `${profile.name} copy` })
                }
              >
                <Copy />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                title="Delete connection"
                aria-label="Delete connection"
                onClick={() => setDeletion(profile)}
              >
                <Trash2 />
              </Button>
            </div>
          )}
        </aside>

        <main className="query-workspace">
          <div className="query-tabs">
            {!explorerOpen && (
              <Button
                size="icon-sm"
                variant="ghost"
                title="Show connections"
                aria-label="Show connections"
                onClick={() => setExplorerOpen(true)}
              >
                <Database />
              </Button>
            )}
            <div
              className="query-tab-list"
              role="tablist"
              aria-label="SQL tabs"
              ref={(element) => {
                scriptTabDrag.listRef.current = element;
                schemaTabDrag.listRef.current = element;
              }}
            >
              {data.tabs.map((item, index) => {
                const connection = data.profiles.find((value) => value.id === item.connectionId);
                const defaultLabel = defaultScriptTabLabel(data.tabs, item, connection?.name);
                const label = scriptTabLabel(data.tabs, item, connection?.name);
                const unsaved = isSqlTabUnsaved(item.text, savedSqlByTab[item.id]);
                const closeShortcut = browserMode ? "Alt+W" : shortcuts.closeTab;
                return (
                  <ScriptTabItem
                    key={item.id}
                    tab={item}
                    connection={connection}
                    label={label}
                    defaultLabel={defaultLabel}
                    active={!schemaActive && tab?.id === item.id}
                    unsaved={unsaved}
                    renaming={renamingScriptTabId === item.id}
                    canMoveLeft={index > 0}
                    canMoveRight={index < data.tabs.length - 1}
                    canCloseOthers={data.tabs.length > 1}
                    canCloseRight={index < data.tabs.length - 1}
                    closeShortcut={closeShortcut}
                    dragProps={scriptTabDrag.getTabProps(item.id)}
                    onSelect={() => {
                      resolution.current++;
                      setResolveTip("");
                      setSchemaSelected(undefined);
                      data.selectTab(item.id);
                    }}
                    onStartRename={() => setRenamingScriptTabId(item.id)}
                    onCommitRename={(value) => {
                      data.renameTab(item.id, value);
                      setRenamingScriptTabId(null);
                    }}
                    onCancelRename={() => setRenamingScriptTabId(null)}
                    onResetName={() => data.renameTab(item.id, undefined)}
                    onMoveLeft={() => data.shiftTab(item.id, -1)}
                    onMoveRight={() => data.shiftTab(item.id, 1)}
                    onDuplicate={() => {
                      setSchemaSelected(undefined);
                      data.duplicateTab(item.id);
                    }}
                    onClose={() => closeTab(item.id)}
                    onCloseOthers={() =>
                      closeManyTabs(
                        data.tabs.filter((entry) => entry.id !== item.id).map((entry) => entry.id),
                      )
                    }
                    onCloseRight={() =>
                      closeManyTabs(data.tabs.slice(index + 1).map((entry) => entry.id))
                    }
                  />
                );
              })}
              {schemaTabs.map((item, index) => {
                const key = inspectionKey(item);
                return (
                  <SchemaTabItem
                    key={key}
                    item={item}
                    active={schemaSelected === key}
                    canMoveLeft={index > 0}
                    canMoveRight={index < schemaTabs.length - 1}
                    canCloseOthers={schemaTabs.length > 1}
                    dragProps={schemaTabDrag.getTabProps(key)}
                    onSelect={() => setSchemaSelected(key)}
                    onMoveLeft={() =>
                      setSchemaTabs((current) => moveItemByOffset(current, key, -1, inspectionKey))
                    }
                    onMoveRight={() =>
                      setSchemaTabs((current) => moveItemByOffset(current, key, 1, inspectionKey))
                    }
                    onClose={() => {
                      if (schemaSelected === key) setSchemaSelected(undefined);
                      setSchemaTabs((tabs) => tabs.filter((entry) => inspectionKey(entry) !== key));
                    }}
                    onCloseOthers={() => {
                      setSchemaSelected(key);
                      setSchemaTabs((tabs) => tabs.filter((entry) => inspectionKey(entry) === key));
                    }}
                  />
                );
              })}
            </div>
            <Button
              size="icon-sm"
              variant="ghost"
              title={`New SQL tab (${browserMode ? "Alt+T" : shortcuts.newTab})`}
              aria-label="New SQL tab"
              disabled={!profile?.id}
              onClick={() => {
                if (profile?.id) data.addTab(profile.id);
              }}
            >
              <Plus />
            </Button>
          </div>

          {schemaActive ? (
            <section className="schema-workspace" aria-label="Schema tab">
              <TableInspector
                key={inspectionKey(schemaActive)}
                subject={schemaActive}
                theme={String(dark)}
                full
                credentials={inspectionCredentials}
                onValue={showCell}
              />
            </section>
          ) : tab && state ? (
            <>
              <div className="query-actions">
                <Button
                  onClick={() => run("statement")}
                  title={shortcuts.run}
                  disabled={!profile || !!active.busy}
                >
                  <Play /> Run
                </Button>
                <Button
                  variant="outline"
                  onClick={() => run("script")}
                  title={shortcuts.script}
                  disabled={!profile || !!active.busy}
                >
                  Run script
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => void data.stop()}
                  title={shortcuts.stop}
                  disabled={
                    active.busy === "Stopping" ||
                    (!active.busy && !active.results.some((item) => item.more))
                  }
                >
                  <Square /> Stop
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => run("explain")}
                  title={shortcuts.explain}
                  disabled={!profile || !!active.busy}
                >
                  Explain
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => void formatSql()}
                  title={shortcuts.format}
                  disabled={!profile}
                >
                  Format
                </Button>
                {profile?.kind === "oracle" && (
                  <Button
                    variant="ghost"
                    aria-pressed={!!active.dbmsOutput}
                    onClick={() => void data.toggleDbmsOutput()}
                    disabled={!active.session || !!active.busy}
                  >
                    DBMS Output
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Open SQL file"
                  title="Open SQL file (Ctrl+O)"
                  disabled={!profile}
                  onClick={() => fileInput.current?.click()}
                >
                  <FolderOpen />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Save SQL file"
                  title="Save SQL file (Ctrl+S)"
                  onClick={() => void saveSqlFile()}
                >
                  <Save />
                </Button>
                <div className="query-actions-end">
                  {active.session && (
                    <div className="transaction-actions">
                      <NativeSelect
                        aria-label="Transaction mode"
                        size="sm"
                        value={active.transaction?.manual ? "manual" : "auto"}
                        disabled={!!active.busy || !!active.transaction?.open}
                        onChange={(event) =>
                          void data.transactionMode(event.target.value === "manual")
                        }
                      >
                        <NativeSelectOption value="auto">Auto</NativeSelectOption>
                        <NativeSelectOption value="manual">Manual</NativeSelectOption>
                      </NativeSelect>
                      {active.transaction?.open && (
                        <>
                          <Button
                            variant="outline"
                            size="xs"
                            disabled={!!active.busy}
                            onClick={() => void data.finishTransaction(true)}
                          >
                            Commit
                          </Button>
                          <Button
                            variant="outline"
                            size="xs"
                            disabled={!!active.busy}
                            onClick={() => void data.finishTransaction(false)}
                          >
                            Rollback
                          </Button>
                        </>
                      )}
                    </div>
                  )}
                  {profile?.id && (
                    <DatabasePicker
                      key={profile.id}
                      selected={tab.database ?? profile.database}
                      disabled={!!active.busy || !!active.transaction?.open}
                      load={async () =>
                        dispatch("list_databases", { scope: await data.scope(profile) })
                      }
                      onChange={(database) => data.setDatabase(tab.id, database)}
                    />
                  )}
                  {profile?.id && profile.kind !== "sqlserver" && (
                    <SchemaPicker
                      key={`${profile.id}:${tab.database ?? profile.database}:${data.catalogRevision}:${active.session ? 1 : 0}`}
                      selected={defaultSchema}
                      disabled={!!active.busy || !!active.transaction?.open}
                      load={async () =>
                        dispatch("list_schemas", {
                          scope: await data.scope(profile, tab.database),
                        })
                      }
                      onChange={(schema) => void data.setSchema(tab.id, schema)}
                    />
                  )}
                  <Button
                    variant="ghost"
                    disabled={!profile || !!active.busy}
                    onClick={() => {
                      if (!active.session) data.connect();
                      else if (tab && data.transactionAtRisk(tab.id))
                        setCloseWarning({
                          title: "Disconnect this tab?",
                          confirm: data.disconnect,
                        });
                      else data.disconnect();
                    }}
                  >
                    <Cable /> {active.session ? "Disconnect" : "Connect"}
                  </Button>
                  {profile && (
                    <Badge variant="outline" className="environment-badge" data-env={profile.env}>
                      {environments[profile.env]}
                    </Badge>
                  )}
                </div>
              </div>
              <ResizablePanelGroup orientation="vertical" className="editor-and-results">
                <ResizablePanel defaultSize="49%" minSize="100px">
                  <section className="editor" aria-label="Query text">
                    <SqlEditor
                      key={tab.id}
                      ref={editor}
                      text={tab.text}
                      dark={dark}
                      savedState={state}
                      schema={catalog.completion}
                      defaultSchema={defaultSchema}
                      kind={profile?.kind}
                      onNavigate={(offset, full) => void navigate(offset, full)}
                      diagnostic={active.diagnostic}
                      onChange={(text) => data.editText(tab.id, text)}
                    />
                    {resolveTip && (
                      <div className="resolve-tip" role="status">
                        {resolveTip}
                      </div>
                    )}
                  </section>
                </ResizablePanel>
                <ResizableHandle aria-label="Resize editor and results" />
                <ResizablePanel minSize="104px">
                  <section
                    className="results"
                    aria-label="Results"
                    onKeyDown={(event) => {
                      if (
                        !result ||
                        !(event.ctrlKey || event.metaKey) ||
                        event.key.toLowerCase() !== "f"
                      )
                        return;
                      event.preventDefault();
                      setFilterResult({ cursor: result.id, text: filterResult?.text ?? "" });
                      filterInput.current?.focus();
                    }}
                  >
                    <div className="panel-heading">
                      <div
                        className="result-tabs"
                        role="tablist"
                        aria-label="Result tabs"
                        ref={(element) => {
                          resultTabDrag.listRef.current = element;
                          pinnedTabDrag.listRef.current = element;
                        }}
                      >
                        {active.results.map((item, index) => {
                          const defaultLabel = defaultResultTabLabel(item);
                          const label = resultTabLabel(item);
                          const otherClosableIds = active.results
                            .filter((entry) => entry.id !== item.id && entry.id !== active.fetching)
                            .map((entry) => entry.id);
                          return (
                            <ResultTabItem
                              key={item.id}
                              result={item}
                              label={label}
                              defaultLabel={defaultLabel}
                              active={selected === item.id}
                              renaming={
                                renamingResultTab?.tabId === tab.id &&
                                renamingResultTab.resultId === item.id
                              }
                              fetching={active.fetching === item.id}
                              canMoveLeft={index > 0}
                              canMoveRight={index < active.results.length - 1}
                              canCloseOthers={otherClosableIds.length > 0}
                              dragProps={resultTabDrag.getTabProps(item.id)}
                              onSelect={() => data.setPanel(tab.id, item.id)}
                              onStartRename={() =>
                                setRenamingResultTab({ tabId: tab.id, resultId: item.id })
                              }
                              onCommitRename={(value) => {
                                data.renameResult(tab.id, item.id, value);
                                setRenamingResultTab(null);
                              }}
                              onCancelRename={() => setRenamingResultTab(null)}
                              onResetName={() => data.renameResult(tab.id, item.id, undefined)}
                              onMoveLeft={() => data.shiftResult(tab.id, item.id, -1)}
                              onMoveRight={() => data.shiftResult(tab.id, item.id, 1)}
                              onClose={() => closeResultTabs(tab.id, [item.id])}
                              onCloseOthers={() => closeResultTabs(tab.id, otherClosableIds)}
                            />
                          );
                        })}
                        {pinned.map((item, index) => {
                          const key = inspectionKey(item);
                          return (
                            <PinnedInspectionTabItem
                              key={key}
                              item={item}
                              active={selected === key}
                              canMoveLeft={index > 0}
                              canMoveRight={index < pinned.length - 1}
                              dragProps={pinnedTabDrag.getTabProps(key)}
                              onSelect={() => data.setPanel(tab.id, key)}
                              onPromote={() => openObject(item)}
                              onMoveLeft={() =>
                                setPinned((current) => ({
                                  ...current,
                                  [tab.id]: moveItemByOffset(
                                    current[tab.id] ?? [],
                                    key,
                                    -1,
                                    inspectionKey,
                                  ),
                                }))
                              }
                              onMoveRight={() =>
                                setPinned((current) => ({
                                  ...current,
                                  [tab.id]: moveItemByOffset(
                                    current[tab.id] ?? [],
                                    key,
                                    1,
                                    inspectionKey,
                                  ),
                                }))
                              }
                              onClose={() => closePinnedInspection(tab.id, key)}
                            />
                          );
                        })}
                        <Button
                          variant="ghost"
                          role="tab"
                          aria-selected={selected === "messages" || !selected}
                          onClick={() => data.setPanel(tab.id, "messages")}
                        >
                          Messages
                        </Button>
                      </div>
                      {result && (
                        <div className="result-actions">
                          {showFilter ? (
                            <>
                              <Input
                                ref={filterInput}
                                aria-label="Filter fetched rows"
                                placeholder="Filter fetched rows"
                                value={filterResult.text}
                                onChange={(event) =>
                                  setFilterResult({ cursor: result.id, text: event.target.value })
                                }
                                onKeyDown={(event) => {
                                  if (event.key === "Escape") setFilterResult(undefined);
                                }}
                              />
                              <Button
                                variant="ghost"
                                size="icon-xs"
                                aria-label="Clear filter"
                                title="Clear filter"
                                onClick={() => setFilterResult(undefined)}
                              >
                                <X />
                              </Button>
                            </>
                          ) : (
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              aria-label="Filter fetched rows"
                              title="Filter fetched rows (Ctrl+F)"
                              onClick={() => setFilterResult({ cursor: result.id, text: "" })}
                            >
                              <Search />
                            </Button>
                          )}
                          <Button
                            variant="outline"
                            size="xs"
                            disabled={!result.more || !!active.busy}
                            onClick={() => void data.fetchRows(result)}
                          >
                            Fetch more
                          </Button>
                          <Button
                            variant="outline"
                            size="xs"
                            disabled={!result.more || !!active.busy}
                            onClick={() => void data.fetchRows(result, true)}
                          >
                            Fetch all
                          </Button>
                        </div>
                      )}
                    </div>
                    {selectedInspection ? (
                      <TableInspector
                        key={inspectionKey(selectedInspection) + (selectedInspection.column ?? "")}
                        subject={selectedInspection}
                        theme={String(dark)}
                        credentials={inspectionCredentials}
                        promote={openObject}
                        onValue={showCell}
                      />
                    ) : result ? (
                      <ResultGrid
                        key={result.id}
                        result={result}
                        themeVersion={String(dark)}
                        canFetch={result.more && !active.busy}
                        fetching={fetchingResult}
                        filter={showFilter ? filterResult.text : ""}
                        onMore={() => void data.fetchRows(result)}
                        onCell={(row, column) => void openCell(result, row, column)}
                        readCell={(row, column) => data.getCell(result, row, column)}
                      />
                    ) : active.messages.length ? (
                      <div className="query-messages" role="log" aria-label="Query messages">
                        {active.messages.map((message, index) => (
                          <div key={index} data-level={message.level}>
                            <span>{message.level}</span>
                            <span>{message.text}</span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="results-empty">
                        {active.busy === "Running"
                          ? "Waiting for results…"
                          : "Run a statement to see results here."}
                      </div>
                    )}
                  </section>
                </ResizablePanel>
              </ResizablePanelGroup>
            </>
          ) : (
            <section className="workspace-empty">
              <div className="empty-state">
                <div className="empty-state-icon">
                  <Database />
                </div>
                <h1>{data.profiles.length ? "Select a connection" : "Connect to PostgreSQL"}</h1>
                {!data.profiles.length && data.workspace && (
                  <Button onClick={() => editConnection(emptyConnection)}>
                    <Plus /> New connection
                  </Button>
                )}
                {!data.workspace && data.notice && <Button onClick={data.retry}>Retry</Button>}
              </div>
            </section>
          )}
        </main>
      </div>

      <QueryNotificationStack
        notifications={queryToasts}
        activeTabId={schemaActive ? null : tab?.id}
        notice={data.notice}
        onDismissNotice={() => data.setNotice("")}
        onDismissNotification={(id) =>
          setQueryToasts((current) => current.filter((item) => item.id !== id))
        }
        onViewTab={(tabId) => {
          resolution.current++;
          setResolveTip("");
          setSchemaSelected(undefined);
          data.selectTab(tabId);
        }}
      />
      <footer className="status-bar" role="status">
        <span
          className="status-dot"
          data-status={active.session ? "ready" : data.notice ? "unavailable" : "idle"}
        />
        <span>
          {active.busy ??
            (active.session ? "Connected" : data.workspace ? "Disconnected" : "Starting…")}
        </span>
        {profile && (
          <span className="status-connection">
            <DatabaseIcon kind={profile.kind} />
            {profile.name}
          </span>
        )}
        {active.session && (
          <>
            <span>{active.session.version.split(" ").slice(0, 2).join(" ")}</span>
            <span>
              {active.session.database}
              {active.session.schema ? ` / ${active.session.schema}` : ""}
            </span>
          </>
        )}
        {result && (
          <span data-testid="result-count">
            {result.rows.length.toLocaleString()} rows
            {fetchingResult
              ? " · fetching rows…"
              : result.more
                ? " · more available"
                : result.capped
                  ? " · row cap reached"
                  : ""}
          </span>
        )}
        {active.elapsed !== undefined && <span>{active.elapsed} ms</span>}
        {profile?.readOnly && <span>Read-only</span>}
        {active.transaction?.open && <span className="transaction-open">Transaction open</span>}
      </footer>

      {update.status && (
        <Dialog open>
          <DialogContent showCloseButton={false}>
            <DialogHeader>
              <DialogTitle>Updating Strata</DialogTitle>
              <DialogDescription role="status">{update.status}</DialogDescription>
            </DialogHeader>
          </DialogContent>
        </Dialog>
      )}
      {settingsOpen && data.settings && (
        <SettingsDialog
          initial={{ ...data.settings, theme }}
          profiles={data.profiles}
          activeConnectionId={profile?.id}
          onClose={() => setSettingsOpen(false)}
          onSave={(settings) => {
            data.applySettings(settings);
            localStorage.setItem("strata.theme", settings.theme);
            setTheme(settings.theme);
          }}
          onSaveConnection={(saved, password) => {
            data.saveProfile(saved, password);
          }}
          onDeleteConnection={(id) => data.deleteProfile(id)}
          onOpenConnection={(id) => openTab(id)}
          onNotify={data.setNotice}
          update={
            browserMode
              ? undefined
              : {
                  version: update.version,
                  checking: update.checking,
                  checkState: update.checkState,
                  checkError: update.checkError,
                  status: update.status,
                  canInstall: !!data.workspace,
                  onCheck: update.check,
                  onInstall: installUpdate,
                }
          }
        />
      )}
      {closeWarning && (
        <Confirmation
          title={closeWarning.title}
          description="Closing rolls back the open transaction."
          action="Roll back and close"
          onCancel={() => setCloseWarning(undefined)}
          onConfirm={() => {
            closeWarning.confirm();
            setCloseWarning(undefined);
          }}
        />
      )}
      {agentActivity && (
        <AgentActivity
          profiles={data.profiles}
          onClose={() => setAgentActivity(false)}
          onOpen={(id, database, sql) => {
            openTab(id, database, sql);
            setAgentActivity(false);
          }}
        />
      )}
      {palette && (
        <CatalogPalette
          entries={entries}
          onClose={() => setPalette(false)}
          onOpen={openObject}
          onHistory={() => {
            setPalette(false);
            setHistory(true);
          }}
        />
      )}
      {history && (
        <QueryHistory
          connection={profile}
          revision={data.historyRevision}
          onClose={() => setHistory(false)}
          onOpen={(sql) => {
            if (profile?.id) data.addTab(profile.id, tab?.database, sql, tab?.schema);
            setHistory(false);
          }}
        />
      )}
      {connectionEditor && (
        <ConnectionDialog
          initial={connectionEditor}
          onClose={() => editConnection(undefined)}
          onSave={(saved, password) => {
            data.saveProfile(saved, password);
            editConnection(undefined);
          }}
        />
      )}
      {deletion && (
        <Confirmation
          title={`Delete ${deletion.name}?`}
          description="This closes its sessions and removes the saved connection."
          action="Delete connection"
          onCancel={() => setDeletion(undefined)}
          onConfirm={() => {
            if (deletion.id) void data.deleteProfile(deletion.id);
            setDeletion(undefined);
          }}
        />
      )}
      {data.modal?.kind === "password" && (
        <PasswordDialog
          name={data.modal.name}
          onClose={data.dismissModal}
          onSubmit={data.modal.submit}
        />
      )}
      {data.modal?.kind === "query" && (
        <Confirmation
          title={`Run SQL on ${data.modal.name}?`}
          description={data.modal.reason}
          sql={data.modal.sql}
          action="Run SQL"
          onCancel={() => data.setModal(undefined)}
          onConfirm={data.modal.submit}
        />
      )}
      {valueView && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setValueView(undefined);
          }}
        >
          <DialogContent className="value-dialog">
            <DialogHeader>
              <DialogTitle>{valueView.name}</DialogTitle>
            </DialogHeader>
            <pre className="cell-value" tabIndex={0}>
              {valueView.text}
            </pre>
            <Button
              variant="outline"
              onClick={() =>
                void navigator.clipboard
                  .writeText(valueView.text)
                  .catch((error: unknown) => data.setNotice(errorMessage(error)))
              }
            >
              <Copy /> Copy value
            </Button>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

function inspectionKey(item: Inspection) {
  return JSON.stringify([
    item.connection.id,
    item.database,
    item.object.schema,
    item.object.oid,
    item.object.name,
  ]);
}
