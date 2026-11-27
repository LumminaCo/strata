import { getCurrentWindow, UserAttentionType } from "@tauri-apps/api/window";
import type { EditorState } from "@codemirror/state";
import {
  Activity,
  Cable,
  ChevronRight,
  Copy,
  Database,
  Download,
  Command as CommandIcon,
  FolderOpen,
  Save,
  Monitor,
  Moon,
  Play,
  Plus,
  RefreshCw,
  Settings2,
  Square,
  Sun,
  Trash2,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { DatabaseIcon } from "@/components/database-icon";
import { ResultGrid } from "@/components/load-result-grid";
import {
  readAggregateFunction,
  saveAggregateFunction,
  type AggregateFunction,
  type NumericAggregateSummary,
} from "@/components/numeric-aggregate";
import { NumericAggregateBar } from "@/components/numeric-aggregate-bar";
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
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
  usePanelRef,
} from "@/components/ui/resizable";
import {
  buildForeignKeyQuery,
  foreignKeyTabTitle,
  needsFullCellRead,
} from "@/features/foreign-key-query";
import { type FilterInputHandle } from "@/features/result-filter-input";
import { formatColumnIdentifier, type ResultFilter, type SortRule } from "@/features/result-query";
import { ResultToolbar } from "@/features/result-toolbar";
import {
  Confirmation,
  ConnectionDialog,
  PasswordDialog,
  emptyConnection,
} from "@/features/connections";
import { ActivitySidebar } from "@/features/activity-sidebar";
import { CatalogExplorer, type CatalogEntry } from "@/features/catalog-explorer";
import { CatalogPalette, DatabasePicker, SchemaPicker } from "@/features/catalog-dialogs";
import { SettingsDialog } from "@/features/settings";
import {
  QueryNotificationStack,
  appendQueryToast,
  type QueryCompletion,
} from "@/features/query-notifications";
import { playQuerySound, primeQuerySound } from "@/features/query-sound";
import {
  MAX_SQL_FILE_BYTES,
  canUseNativeOpenSqlPicker,
  isSqlTabUnsaved,
  openSqlFile as pickSqlFile,
  recordSavedSqlTab,
  removeSavedSqlTabs,
  saveSqlFile as persistSqlFile,
  seedSavedSqlTabs,
  selectUnsavedTabsToClose,
  type SavedSqlState,
} from "@/features/save-sql-file";
import {
  ACTIVITY_SIDEBAR_DEFAULT_WIDTH,
  ACTIVITY_SIDEBAR_MIN_WIDTH,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MIN_WIDTH,
  readActivitySidebarWidth,
  readSidebarWidth,
  writeActivitySidebarWidth,
  writeSidebarWidth,
} from "@/features/sidebar-layout";
import {
  MessagesTabItem,
  PinnedInspectionTabItem,
  ResultTabItem,
  SchemaTabItem,
  ScriptTabItem,
  UnsavedTabCloseDialog,
} from "@/features/tab-controls";
import {
  MESSAGES_TAB_ID,
  defaultResultTabLabel,
  defaultScriptTabLabel,
  moveItemByOffset,
  reorderById,
  reorderByOrder,
  resolveResultPanelOrder,
  resultTabLabel,
  scriptTabLabel,
} from "@/features/tab-order";
import {
  TableInspector,
  resolveNavigationTarget,
  type Inspection,
} from "@/features/table-inspector";
import { useCatalogSchema } from "@/features/use-catalog-schema";
import { shortcuts, workspaceKeydown } from "@/features/keymap";
import { useTabDrag } from "@/features/use-tab-drag";
import { useWorkspace } from "@/features/use-workspace";
import { useAppUpdate } from "@/features/use-app-update";
import type { Cell, Connection, ForeignKeyRef, RunMode, SavedTab } from "@/ipc/bindings/protocol";
import { browserMode, dispatch, errorMessage } from "@/ipc/client";
import strataLogo from "../../../dev/strata-logo.png";

const themes = ["system", "light", "dark"] as const;
const themeIcons = { system: Monitor, light: Sun, dark: Moon };
const environments = { dev: "Development", staging: "Staging", prod: "Production" };

interface ResultViewState {
  draftFilter: string;
  filters: ResultFilter[];
  sorts: SortRule[];
}

const emptyResultView: ResultViewState = {
  draftFilter: "",
  filters: [],
  sorts: [],
};

function readTheme() {
  const saved = localStorage.getItem("strata.theme");
  return themes.find((theme) => theme === saved) ?? "system";
}

export function App() {
  const [queryToasts, setQueryToasts] = useState<QueryCompletion[]>([]);
  const [savedSqlByTab, setSavedSqlByTab] = useState<Record<string, SavedSqlState>>({});
  const savedSqlRef = useRef(savedSqlByTab);
  savedSqlRef.current = savedSqlByTab;
  const notificationPrefs = useRef({ toast: true, sound: true });
  const data = useWorkspace({
    onWorkspaceLoad(workspace) {
      const seeded = seedSavedSqlTabs(workspace.tabs);
      savedSqlRef.current = seeded;
      setSavedSqlByTab(seeded);
    },
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
  const [resultViews, setResultViews] = useState<Record<string, ResultViewState>>({});
  const [visibleRowCounts, setVisibleRowCounts] = useState<Record<string, number>>({});
  const [initialSidebarWidth] = useState(() => readSidebarWidth());
  const [initialActivityWidth] = useState(() => readActivitySidebarWidth());
  const activityWidthRef = useRef(initialActivityWidth);
  const [gridAggregate, setGridAggregate] = useState<NumericAggregateSummary | null>(null);
  const [aggregateFn, setAggregateFn] = useState<AggregateFunction>(readAggregateFunction);
  const [explorerOpen, setExplorerOpen] = useState(true);
  const [activityOpen, setActivityOpen] = useState(false);
  const [activityFocusToken, setActivityFocusToken] = useState(0);
  const explorerPanelRef = usePanelRef();
  const activityPanelRef = usePanelRef();
  const resultsPanelRef = usePanelRef();
  const [palette, setPalette] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [closeWarning, setCloseWarning] = useState<{ title: string; confirm: () => void }>();
  const [unsavedClosePrompt, setUnsavedClosePrompt] = useState<{
    ids: string[];
    unsavedIds: string[];
    labels: string[];
  }>();
  const [savingUnsavedClose, setSavingUnsavedClose] = useState(false);
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
  const [schemaTabs, setSchemaTabs] = useState<Inspection[]>([]);
  const [schemaSelected, setSchemaSelected] = useState<string>();
  const [pinnedByTab, setPinned] = useState<Record<string, Inspection[]>>({});
  const [resultTabOrderByTab, setResultTabOrderByTab] = useState<Record<string, string[]>>({});
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
    active.session?.schema ||
    tab?.schema ||
    (profile?.kind === "sqlserver"
      ? "dbo"
      : profile?.kind === "oracle"
        ? profile.user.toUpperCase()
        : "public");
  const catalog = useCatalogSchema(
    profile,
    tab,
    data.catalogRevision,
    defaultSchema,
    data.scope,
    active.session?.id,
  );
  const editor = useRef<EditorHandle>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const editors = useRef(new Map<string, { current: EditorState | null }>());
  const tabsRef = useRef(data.tabs);
  tabsRef.current = data.tabs;
  const savingSql = useRef(false);
  const filterInput = useRef<FilterInputHandle>(null);
  const ThemeIcon = themeIcons[theme];
  const dark = theme === "dark" || (theme === "system" && systemDark);
  const editorState = tab ? editors.current.get(tab.id) : undefined;
  const selected = active.selected ?? (active.messages.length ? "messages" : null);
  const selectedInspection = pinned.find((item) => inspectionKey(item) === selected);
  const result = active.results.find((entry) => entry.id === selected);
  const fetchingResult = !!result && active.fetching === result.id;
  const resultView = result ? (resultViews[result.id] ?? emptyResultView) : emptyResultView;
  const visibleRows = result ? (visibleRowCounts[result.id] ?? result.rows.length) : 0;

  function updateResultView(
    resultId: string,
    change: (current: ResultViewState) => ResultViewState,
  ) {
    setResultViews((current) => ({
      ...current,
      [resultId]: change(current[resultId] ?? emptyResultView),
    }));
  }
  const renamingScriptActive =
    renamingScriptTabId !== null && data.tabs.some((entry) => entry.id === renamingScriptTabId);
  const renamingResultActive =
    renamingResultTab !== null &&
    tab !== undefined &&
    renamingResultTab.tabId === tab.id &&
    active.results.some((entry) => entry.id === renamingResultTab.resultId);
  const resultPanelIds = resolveResultPanelOrder(
    tab ? resultTabOrderByTab[tab.id] : undefined,
    active.results.map((entry) => entry.id),
    pinned.map(inspectionKey),
  );

  function applyResultPanelOrder(tabId: string, nextOrder: string[]) {
    setResultTabOrderByTab((current) => ({ ...current, [tabId]: nextOrder }));
    data.syncResultOrder(tabId, nextOrder);
    setPinned((current) => {
      const list = current[tabId] ?? [];
      const next = reorderByOrder(list, nextOrder, inspectionKey);
      return next === list ? current : { ...current, [tabId]: next };
    });
  }

  const scriptTabDrag = useTabDrag({
    disabled: renamingScriptActive,
    onReorder: (activeId, targetId, placement) => data.reorderTabs(activeId, targetId, placement),
  });
  const schemaTabDrag = useTabDrag({
    onReorder: (activeId, targetId, placement) =>
      setSchemaTabs((current) =>
        reorderById(current, activeId, targetId, placement, inspectionKey),
      ),
  });
  const resultPanelDrag = useTabDrag({
    disabled: !tab || renamingResultActive,
    onReorder: (activeId, targetId, placement) => {
      if (!tab) return;
      const nextOrder = reorderById(resultPanelIds, activeId, targetId, placement, (id) => id);
      if (nextOrder === resultPanelIds) return;
      applyResultPanelOrder(tab.id, nextOrder);
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

  function collapseExplorer() {
    if (explorerPanelRef.current) explorerPanelRef.current.collapse();
    else setExplorerOpen(false);
  }

  function expandExplorer() {
    if (explorerPanelRef.current) explorerPanelRef.current.expand();
    else setExplorerOpen(true);
  }

  function toggleExplorer() {
    const panel = explorerPanelRef.current;
    if (!panel) {
      setExplorerOpen((open) => !open);
      return;
    }
    if (panel.isCollapsed()) panel.expand();
    else panel.collapse();
  }

  function toggleResults() {
    const panel = resultsPanelRef.current;
    if (panel?.isCollapsed()) panel.expand();
    else panel?.collapse();
  }

  const running = active.busy === "Running";
  useEffect(() => {
    // Reveal hidden results whenever a query starts, whatever path started it.
    if (running) resultsPanelRef.current?.expand();
  }, [running, resultsPanelRef]);

  function openConnectionsSidebar() {
    expandExplorer();
  }

  function collapseActivity() {
    if (activityPanelRef.current) activityPanelRef.current.collapse();
    else setActivityOpen(false);
  }

  function openActivitySidebar() {
    const panel = activityPanelRef.current;
    if (panel) {
      if (panel.isCollapsed()) {
        panel.resize(`${activityWidthRef.current}px`);
      }
    } else {
      setActivityOpen(true);
    }
    setActivityFocusToken((value) => value + 1);
  }

  function toggleActivitySidebar() {
    const panel = activityPanelRef.current;
    if (!panel) {
      setActivityOpen((open) => {
        const next = !open;
        if (next) setActivityFocusToken((value) => value + 1);
        return next;
      });
      return;
    }
    if (panel.isCollapsed()) {
      panel.resize(`${activityWidthRef.current}px`);
      setActivityFocusToken((value) => value + 1);
    } else {
      panel.collapse();
    }
  }

  function resetSidebarWidth() {
    explorerPanelRef.current?.resize(`${SIDEBAR_DEFAULT_WIDTH}px`);
    writeSidebarWidth(SIDEBAR_DEFAULT_WIDTH);
  }

  function resetActivitySidebarWidth() {
    activityWidthRef.current = ACTIVITY_SIDEBAR_DEFAULT_WIDTH;
    activityPanelRef.current?.resize(`${ACTIVITY_SIDEBAR_DEFAULT_WIDTH}px`);
    writeActivitySidebarWidth(ACTIVITY_SIDEBAR_DEFAULT_WIDTH);
  }

  function runHistoryQuery(
    sql: string,
    options?: { title?: string; connectionId?: string | null },
  ) {
    if (active.busy) {
      data.setNotice("Wait for the running query to finish.");
      return;
    }
    if (tab && profile) {
      setSchemaSelected(undefined);
      if (notificationPrefs.current.sound) primeQuerySound();
      void data.run({
        text: sql,
        target: { cursor: 0 },
        mode: "script",
        keepResults: true,
        resultTitle: options?.title,
      });
      return;
    }
    const targetConnection =
      (options?.connectionId
        ? data.profiles.find((entry) => entry.id === options.connectionId)
        : undefined) ?? data.profiles[0];
    if (!targetConnection?.id) {
      data.setNotice("Select or add a connection to run this query.");
      return;
    }
    setSchemaSelected(undefined);
    if (notificationPrefs.current.sound) primeQuerySound();
    data.openAndRunTab({
      connectionId: targetConnection.id,
      database: targetConnection.database,
      text: sql,
      title: options?.title,
      mode: "script",
    });
  }

  function changeTheme() {
    const next = themes[(themes.indexOf(theme) + 1) % themes.length] ?? "system";
    localStorage.setItem("strata.theme", next);
    setTheme(next);
  }

  function changeAggregateFn(next: AggregateFunction) {
    saveAggregateFunction(next);
    setAggregateFn(next);
  }

  function run(mode: RunMode, keepResults = false) {
    if (!editor.current || active.busy || schemaActive) return;
    if (!keepResults && tab) {
      setRenamingResultTab((current) => (current?.tabId === tab.id ? null : current));
    }
    if (notificationPrefs.current.sound) primeQuerySound();
    void data.run({
      text: editor.current.text(),
      target: editor.current.target(),
      mode,
      keepResults,
    });
  }

  function openTab(
    id: string,
    database?: string,
    text?: string,
    schema?: string,
    filePath?: string,
  ): string | null {
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
    return data.addTab(id, database, text, schema, filePath);
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

  function currentTabText(targetTab: SavedTab): string {
    if (!schemaActive && tab?.id === targetTab.id && editor.current) {
      return editor.current.text();
    }
    return targetTab.text;
  }

  function closeManyTabs(
    ids: string[],
    options?: { skipUnsavedCheck?: boolean; skipTransactionCheck?: boolean },
  ) {
    if (ids.length === 0 || savingSql.current) return;
    if (!options?.skipUnsavedCheck) {
      const currentTabs = tabsRef.current;
      const unsaved = selectUnsavedTabsToClose(
        ids,
        currentTabs,
        savedSqlRef.current,
        currentTabText,
        (entry) => {
          const connection = data.profiles.find((value) => value.id === entry.connectionId);
          return scriptTabLabel(currentTabs, entry, connection?.name);
        },
      );
      if (unsaved) {
        setUnsavedClosePrompt({ ids, ...unsaved });
        return;
      }
    }
    if (!options?.skipTransactionCheck) {
      const atRisk = ids.filter((id) => data.transactionAtRisk(id));
      if (atRisk.length > 0) {
        setCloseWarning({
          title: atRisk.length === 1 ? "Close SQL tab?" : `Close ${atRisk.length} SQL tabs?`,
          confirm: () => closeManyTabs(ids, { skipUnsavedCheck: true, skipTransactionCheck: true }),
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
    setResultTabOrderByTab((current) => {
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

  function closeTab(id: string) {
    closeManyTabs([id]);
  }

  function closeResultTabs(tabId: string, resultIds: string[]) {
    if (resultIds.length === 0) return;
    const closing = new Set(resultIds);
    data.closeResults(tabId, resultIds);
    setResultViews((current) => {
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
    setVisibleRowCounts((current) => {
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
      if (resolveNavigationTarget(entry.object.kind, full) === "tab") {
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
    if (file.size > MAX_SQL_FILE_BYTES) {
      data.setNotice("The SQL file exceeds 8 MB.");
      return;
    }
    try {
      const content = await file.text();
      const tabId = openTab(profile.id, tab?.database, content, tab?.schema, file.name);
      if (tabId) {
        setSavedSqlByTab((current) => recordSavedSqlTab(current, tabId, content, file.name));
      }
    } catch (error) {
      data.setNotice(errorMessage(error));
    }
  }

  async function requestOpenSqlFile() {
    if (!profile?.id) return;
    if (!canUseNativeOpenSqlPicker()) {
      fileInput.current?.click();
      return;
    }
    try {
      const suggestedPath = tab ? (savedSqlByTab[tab.id]?.path ?? tab.filePath) : undefined;
      const opened = await pickSqlFile(suggestedPath);
      if (!opened) return;
      const tabId = openTab(profile.id, tab?.database, opened.content, tab?.schema, opened.path);
      if (tabId) {
        setSavedSqlByTab((current) =>
          recordSavedSqlTab(current, tabId, opened.content, opened.path, opened.handle),
        );
      }
    } catch (error) {
      data.setNotice(errorMessage(error));
    }
  }

  async function saveSqlTab(targetTab: SavedTab, saveAs = false): Promise<boolean> {
    if (savingSql.current) return false;
    const tabId = targetTab.id;
    const content = currentTabText(targetTab);
    const existing = savedSqlRef.current[tabId];
    const suggestedPath = existing?.path ?? targetTab.filePath;
    savingSql.current = true;
    try {
      const saved = await persistSqlFile(content, {
        suggestedPath,
        handle: existing?.handle,
        saveAs,
      });
      if (!saved) return false;
      if (tabsRef.current.some((entry) => entry.id === tabId)) {
        savedSqlRef.current = recordSavedSqlTab(
          savedSqlRef.current,
          tabId,
          content,
          saved.path,
          saved.handle,
        );
        setSavedSqlByTab((current) =>
          recordSavedSqlTab(current, tabId, content, saved.path, saved.handle),
        );
        data.setTabFilePath(tabId, saved.path);
      }
      data.setNotice(`Saved SQL to ${saved.path}.`);
      return true;
    } catch (error) {
      data.setNotice(errorMessage(error));
      return false;
    } finally {
      savingSql.current = false;
    }
  }

  async function saveSqlFile(saveAs = false) {
    if (!tab || !editor.current || schemaActive) return;
    await saveSqlTab(tab, saveAs);
  }

  async function saveUnsavedTabsAndClose() {
    if (!unsavedClosePrompt || savingUnsavedClose) return;
    const { ids, unsavedIds } = unsavedClosePrompt;
    setSavingUnsavedClose(true);
    let allSaved = true;
    try {
      for (const id of unsavedIds) {
        const targetTab = tabsRef.current.find((entry) => entry.id === id);
        if (!targetTab) continue;
        if (!isSqlTabUnsaved(currentTabText(targetTab), savedSqlRef.current[id])) continue;
        const saved = await saveSqlTab(targetTab, false);
        if (!saved) {
          allSaved = false;
          break;
        }
      }
    } finally {
      setSavingUnsavedClose(false);
      setUnsavedClosePrompt(undefined);
    }
    if (allSaved) {
      closeManyTabs(ids, { skipUnsavedCheck: true });
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

  function openForeignKeyQuery(options: {
    connection: Connection;
    database?: string;
    schema?: string;
    target: ForeignKeyRef;
    value: Cell;
    columnKind?: string;
  }) {
    if (options.value === null || !options.connection.id) return;
    const text = buildForeignKeyQuery(
      options.target,
      options.value,
      options.columnKind,
      options.connection.kind,
    );
    const title = foreignKeyTabTitle(options.target, options.value);
    setSchemaSelected(undefined);
    data.openAndRunTab({
      connectionId: options.connection.id,
      database: options.database ?? options.connection.database,
      schema: options.schema,
      text,
      title,
    });
  }

  async function followResultForeignKey(item: ResultSet, row: number, column: number) {
    if (!profile) return;
    const meta = item.columns[column];
    const target = meta?.foreign_key;
    if (!meta || !target) return;
    let value = item.rows[row]?.[column] ?? null;
    if (value === null) return;
    if (needsFullCellRead(value, meta.kind)) {
      try {
        value = await data.getCell(item, row, column);
      } catch (error) {
        data.setNotice(errorMessage(error));
        return;
      }
    }
    openForeignKeyQuery({
      connection: profile,
      database: active.session?.database ?? tab?.database ?? profile.database,
      schema: active.session?.schema ?? tab?.schema,
      target,
      value,
      columnKind: meta.kind,
    });
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
          settingsOpen ||
          closeWarning ||
          unsavedClosePrompt ||
          update.status ||
          renamingScriptActive ||
          renamingResultActive ||
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
            activity: toggleActivitySidebar,
            explorer: toggleExplorer,
            results: toggleResults,
            navigate: () => {
              const target = editor.current?.target();
              if (target)
                void navigate("cursor" in target ? target.cursor : target.selection[0], true);
            },
            explain: () => run("explain"),
            format: () => void formatSql(),
            openSql: () => void requestOpenSqlFile(),
            saveSql: () => void saveSqlFile(false),
            saveSqlAs: () => void saveSqlFile(true),
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

      <ResizablePanelGroup
        orientation="horizontal"
        className="workspace-body"
        data-explorer-open={explorerOpen}
        data-activity-open={activityOpen}
        onLayoutChanged={(_layout, meta) => {
          if (!meta.isUserInteraction) return;
          const panel = explorerPanelRef.current;
          if (panel && !panel.isCollapsed()) {
            const { inPixels } = panel.getSize();
            if (inPixels >= SIDEBAR_MIN_WIDTH) writeSidebarWidth(inPixels);
          }
          const activityPanel = activityPanelRef.current;
          if (activityPanel && !activityPanel.isCollapsed()) {
            const { inPixels } = activityPanel.getSize();
            if (inPixels >= ACTIVITY_SIDEBAR_MIN_WIDTH) {
              activityWidthRef.current = inPixels;
              writeActivitySidebarWidth(inPixels);
            }
          }
        }}
      >
        <ResizablePanel
          id="explorer"
          panelRef={explorerPanelRef}
          defaultSize={`${initialSidebarWidth}px`}
          minSize={`${SIDEBAR_MIN_WIDTH}px`}
          maxSize="40%"
          collapsible
          collapsedSize={0}
          groupResizeBehavior="preserve-pixel-size"
          style={{ overflow: "hidden" }}
          onResize={(panelSize) => {
            const open = panelSize.asPercentage > 0;
            setExplorerOpen((current) => (current === open ? current : open));
          }}
        >
          <aside className="explorer connections-sidebar" aria-label="Connections">
            <div className="sidebar-heading">
              <h2>Connections</h2>
              <Button
                size="icon-xs"
                variant="ghost"
                title={`Collapse connections (${shortcuts.explorer})`}
                aria-label="Collapse connections"
                onClick={collapseExplorer}
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
              onObjects={catalog.captureObjects}
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
        </ResizablePanel>

        <ResizableHandle
          className="sidebar-resize-handle"
          aria-label="Resize connections sidebar"
          disableDoubleClick
          onDoubleClick={resetSidebarWidth}
        />

        <ResizablePanel id="workspace" minSize="30%" style={{ overflow: "hidden" }}>
          <main className="query-workspace">
            <div className="query-tabs">
              {!explorerOpen && (
                <Button
                  size="icon-sm"
                  variant="ghost"
                  title={`Show connections (${shortcuts.explorer})`}
                  aria-label="Show connections"
                  onClick={openConnectionsSidebar}
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
                          data.tabs
                            .filter((entry) => entry.id !== item.id)
                            .map((entry) => entry.id),
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
                        setSchemaTabs((current) =>
                          moveItemByOffset(current, key, -1, inspectionKey),
                        )
                      }
                      onMoveRight={() =>
                        setSchemaTabs((current) => moveItemByOffset(current, key, 1, inspectionKey))
                      }
                      onClose={() => {
                        if (schemaSelected === key) setSchemaSelected(undefined);
                        setSchemaTabs((tabs) =>
                          tabs.filter((entry) => inspectionKey(entry) !== key),
                        );
                      }}
                      onCloseOthers={() => {
                        setSchemaSelected(key);
                        setSchemaTabs((tabs) =>
                          tabs.filter((entry) => inspectionKey(entry) === key),
                        );
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
              {(!tab || schemaActive) && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="query-tabs-activity"
                  aria-pressed={activityOpen}
                  title={`Activity (${shortcuts.activity})`}
                  onClick={toggleActivitySidebar}
                >
                  <Activity /> Activity
                </Button>
              )}
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
                  onFollowForeignKey={({ entry, target, value, columnKind }) =>
                    openForeignKeyQuery({
                      connection: entry.connection,
                      database: entry.database,
                      target,
                      value,
                      columnKind,
                    })
                  }
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
                    title={`Open SQL file (${shortcuts.openSql})`}
                    disabled={!profile}
                    onClick={() => void requestOpenSqlFile()}
                  >
                    <FolderOpen />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Save SQL file"
                    title={(() => {
                      const linkedPath = savedSqlByTab[tab.id]?.path ?? tab.filePath;
                      const base = `Save SQL file (${shortcuts.saveSql}, Save as: ${shortcuts.saveSqlAs})`;
                      return linkedPath ? `${base} · ${linkedPath}` : base;
                    })()}
                    onClick={() => void saveSqlFile(false)}
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
                    <Button
                      variant="ghost"
                      aria-pressed={activityOpen}
                      title={`Activity (${shortcuts.activity})`}
                      onClick={toggleActivitySidebar}
                    >
                      <Activity /> Activity
                    </Button>
                  </div>
                </div>
                <ResizablePanelGroup
                  orientation="vertical"
                  className="editor-and-results"
                  resizeTargetMinimumSize={{ fine: 6, coarse: 12 }}
                >
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
                  <ResizablePanel
                    panelRef={resultsPanelRef}
                    minSize="104px"
                    collapsible
                    collapsedSize={0}
                  >
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
                        filterInput.current?.focus({ openSuggestions: true, selectAll: true });
                      }}
                    >
                      <div className="panel-heading">
                        <div
                          className="result-tabs"
                          role="tablist"
                          aria-label="Result tabs"
                          ref={resultPanelDrag.listRef}
                        >
                          {resultPanelIds.map((panelId, index) => {
                            const canMoveLeft = index > 0;
                            const canMoveRight = index < resultPanelIds.length - 1;
                            const shiftPanel = (delta: -1 | 1) => {
                              const nextOrder = moveItemByOffset(
                                resultPanelIds,
                                panelId,
                                delta,
                                (id) => id,
                              );
                              if (nextOrder !== resultPanelIds) {
                                applyResultPanelOrder(tab.id, nextOrder);
                              }
                            };

                            if (panelId === MESSAGES_TAB_ID) {
                              return (
                                <MessagesTabItem
                                  key={MESSAGES_TAB_ID}
                                  active={selected === MESSAGES_TAB_ID || !selected}
                                  canMoveLeft={canMoveLeft}
                                  canMoveRight={canMoveRight}
                                  dragProps={resultPanelDrag.getTabProps(MESSAGES_TAB_ID)}
                                  onSelect={() => data.setPanel(tab.id, MESSAGES_TAB_ID)}
                                  onMoveLeft={() => shiftPanel(-1)}
                                  onMoveRight={() => shiftPanel(1)}
                                />
                              );
                            }

                            const resultItem = active.results.find((entry) => entry.id === panelId);
                            if (resultItem) {
                              const defaultLabel = defaultResultTabLabel(resultItem);
                              const label = resultTabLabel(resultItem);
                              const otherClosableIds = active.results
                                .filter(
                                  (entry) =>
                                    entry.id !== resultItem.id && entry.id !== active.fetching,
                                )
                                .map((entry) => entry.id);
                              return (
                                <ResultTabItem
                                  key={resultItem.id}
                                  result={resultItem}
                                  label={label}
                                  defaultLabel={defaultLabel}
                                  active={selected === resultItem.id}
                                  renaming={
                                    renamingResultTab?.tabId === tab.id &&
                                    renamingResultTab.resultId === resultItem.id
                                  }
                                  fetching={active.fetching === resultItem.id}
                                  canMoveLeft={canMoveLeft}
                                  canMoveRight={canMoveRight}
                                  canCloseOthers={otherClosableIds.length > 0}
                                  dragProps={resultPanelDrag.getTabProps(resultItem.id)}
                                  onSelect={() => data.setPanel(tab.id, resultItem.id)}
                                  onStartRename={() =>
                                    setRenamingResultTab({ tabId: tab.id, resultId: resultItem.id })
                                  }
                                  onCommitRename={(value) => {
                                    data.renameResult(tab.id, resultItem.id, value);
                                    setRenamingResultTab(null);
                                  }}
                                  onCancelRename={() => setRenamingResultTab(null)}
                                  onResetName={() =>
                                    data.renameResult(tab.id, resultItem.id, undefined)
                                  }
                                  onMoveLeft={() => shiftPanel(-1)}
                                  onMoveRight={() => shiftPanel(1)}
                                  onClose={() => closeResultTabs(tab.id, [resultItem.id])}
                                  onCloseOthers={() => closeResultTabs(tab.id, otherClosableIds)}
                                />
                              );
                            }

                            const pinnedItem = pinned.find(
                              (entry) => inspectionKey(entry) === panelId,
                            );
                            if (pinnedItem) {
                              return (
                                <PinnedInspectionTabItem
                                  key={panelId}
                                  item={pinnedItem}
                                  active={selected === panelId}
                                  canMoveLeft={canMoveLeft}
                                  canMoveRight={canMoveRight}
                                  dragProps={resultPanelDrag.getTabProps(panelId)}
                                  onSelect={() => data.setPanel(tab.id, panelId)}
                                  onPromote={() => openObject(pinnedItem)}
                                  onMoveLeft={() => shiftPanel(-1)}
                                  onMoveRight={() => shiftPanel(1)}
                                  onClose={() => closePinnedInspection(tab.id, panelId)}
                                />
                              );
                            }

                            return null;
                          })}
                        </div>
                        {result && (
                          <div className="result-actions">
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
                          key={
                            inspectionKey(selectedInspection) + (selectedInspection.column ?? "")
                          }
                          subject={selectedInspection}
                          theme={String(dark)}
                          credentials={inspectionCredentials}
                          promote={openObject}
                          onValue={showCell}
                          onFollowForeignKey={({ entry, target, value, columnKind }) =>
                            openForeignKeyQuery({
                              connection: entry.connection,
                              database: entry.database,
                              target,
                              value,
                              columnKind,
                            })
                          }
                        />
                      ) : result ? (
                        <div className="result-view">
                          <ResultToolbar
                            key={`toolbar-${result.id}`}
                            inputRef={filterInput}
                            columns={result.columns}
                            rows={result.rows}
                            visibleRows={visibleRows}
                            draftFilter={resultView.draftFilter}
                            filters={resultView.filters}
                            sorts={resultView.sorts}
                            onDraftFilterChange={(draftFilter) =>
                              updateResultView(result.id, (current) => ({
                                ...current,
                                draftFilter,
                              }))
                            }
                            onAddFilter={(expression) =>
                              updateResultView(result.id, (current) => ({
                                ...current,
                                draftFilter: "",
                                filters: [
                                  ...current.filters,
                                  { id: crypto.randomUUID(), expression },
                                ],
                              }))
                            }
                            onRemoveFilter={(id) =>
                              updateResultView(result.id, (current) => ({
                                ...current,
                                filters: current.filters.filter((item) => item.id !== id),
                              }))
                            }
                            onEditFilter={(item) => {
                              updateResultView(result.id, (current) => ({
                                ...current,
                                draftFilter: item.expression,
                                filters: current.filters.filter((entry) => entry.id !== item.id),
                              }));
                              requestAnimationFrame(() =>
                                filterInput.current?.focus({ openSuggestions: true }),
                              );
                            }}
                            onClearFilters={() =>
                              updateResultView(result.id, (current) => ({
                                ...current,
                                draftFilter: "",
                                filters: [],
                              }))
                            }
                            onSortsChange={(sorts) =>
                              updateResultView(result.id, (current) => ({ ...current, sorts }))
                            }
                          />
                          <ResultGrid
                            key={result.id}
                            result={result}
                            themeVersion={String(dark)}
                            canFetch={result.more && !active.busy}
                            fetching={fetchingResult}
                            filter={resultView.draftFilter}
                            onAggregateChange={setGridAggregate}
                            filters={resultView.filters}
                            sorts={resultView.sorts}
                            onSortsChange={(sorts) =>
                              updateResultView(result.id, (current) => ({ ...current, sorts }))
                            }
                            onFilterByColumn={(columnName) => {
                              const prefix = `${formatColumnIdentifier(columnName)} = `;
                              updateResultView(result.id, (current) => ({
                                ...current,
                                draftFilter: prefix,
                              }));
                              requestAnimationFrame(() =>
                                filterInput.current?.focus({ openSuggestions: true }),
                              );
                            }}
                            onRowCountChange={(count) =>
                              setVisibleRowCounts((current) =>
                                current[result.id] === count
                                  ? current
                                  : { ...current, [result.id]: count },
                              )
                            }
                            onMore={() => void data.fetchRows(result)}
                            onCell={(row, column) => void openCell(result, row, column)}
                            onFollowForeignKey={(row, column) =>
                              void followResultForeignKey(result, row, column)
                            }
                            readCell={(row, column) => data.getCell(result, row, column)}
                          />
                        </div>
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
        </ResizablePanel>

        <ResizableHandle
          className="activity-resize-handle"
          aria-label="Resize activity sidebar"
          disableDoubleClick
          onDoubleClick={resetActivitySidebarWidth}
        />

        <ResizablePanel
          id="activity"
          panelRef={activityPanelRef}
          defaultSize={0}
          minSize={`${ACTIVITY_SIDEBAR_MIN_WIDTH}px`}
          maxSize="45%"
          collapsible
          collapsedSize={0}
          groupResizeBehavior="preserve-pixel-size"
          style={{ overflow: "hidden" }}
          onResize={(panelSize) => {
            const open = panelSize.asPercentage > 0;
            setActivityOpen((current) => (current === open ? current : open));
          }}
        >
          <ActivitySidebar
            open={activityOpen}
            profiles={data.profiles}
            activeConnection={profile}
            canRun={Boolean(tab && profile)}
            busy={Boolean(active.busy)}
            revision={data.historyRevision}
            focusToken={activityFocusToken}
            currentEditorSql={() => editor.current?.text() ?? tab?.text ?? ""}
            onRun={runHistoryQuery}
            onOpenSql={(id, database, sql) => openTab(id, database, sql)}
            onCopy={(sql, label) => copyText(sql, label)}
            onNotify={data.setNotice}
            onCollapse={collapseActivity}
          />
        </ResizablePanel>
      </ResizablePanelGroup>

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
        {!schemaActive && !selectedInspection && result && gridAggregate && (
          <NumericAggregateBar
            summary={gridAggregate}
            fn={aggregateFn}
            onChangeFn={changeAggregateFn}
          />
        )}
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
      {unsavedClosePrompt && (
        <UnsavedTabCloseDialog
          labels={unsavedClosePrompt.labels}
          saving={savingUnsavedClose}
          onCancel={() => {
            if (!savingUnsavedClose) setUnsavedClosePrompt(undefined);
          }}
          onDiscard={() => {
            const ids = unsavedClosePrompt.ids;
            setUnsavedClosePrompt(undefined);
            closeManyTabs(ids, { skipUnsavedCheck: true });
          }}
          onSave={() => void saveUnsavedTabsAndClose()}
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
      {palette && (
        <CatalogPalette
          entries={entries}
          onClose={() => setPalette(false)}
          onOpen={openObject}
          onActivity={() => {
            setPalette(false);
            openActivitySidebar();
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
