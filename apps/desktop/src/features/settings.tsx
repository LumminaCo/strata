import {
  ArrowLeft,
  Check,
  Copy,
  Database,
  Download,
  FileCode2,
  Keyboard,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Terminal,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { DatabaseIcon } from "@/components/database-icon";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Switch } from "@/components/ui/switch";
import { ConnectionForm, emptyConnection } from "@/features/connections";
import { shortcuts } from "@/features/keymap";
import { playQuerySound, primeQuerySound } from "@/features/query-sound";
import type { UpdateCheckState } from "@/features/use-app-update";
import type { CliStatus, Connection, Settings } from "@/ipc/bindings/protocol";
import { browserMode, dispatch, errorMessage } from "@/ipc/client";

export const defaultSettings: Settings = {
  fetch_size: 500,
  row_cap: 200_000,
  theme: "system",
  blank_line_delimiter: true,
  editor_font_size: 13,
  show_system_objects: false,
  confirm_production: true,
  notify_on_query_complete: true,
  notify_sound: true,
  statement_timeout_ms: 0,
  agent_default_row_limit: 200,
  agent_max_row_limit: 10_000,
  agent_statement_timeout_s: 30,
};

type SectionId = "general" | "query" | "keybindings" | "agents" | "connections";

type NumericSettingKey =
  | "fetch_size"
  | "row_cap"
  | "editor_font_size"
  | "statement_timeout_ms"
  | "agent_default_row_limit"
  | "agent_max_row_limit"
  | "agent_statement_timeout_s";

type BooleanSettingKey =
  | "blank_line_delimiter"
  | "show_system_objects"
  | "confirm_production"
  | "notify_on_query_complete"
  | "notify_sound";

interface SettingMeta {
  key: keyof Settings;
  section: Exclude<SectionId, "keybindings" | "connections">;
  group: string;
  label: string;
  description: string;
  keywords: string[];
  kind: "select" | "switch" | "number";
  min?: number;
  max?: number;
  unit?: string;
}

const settingDefinitions: SettingMeta[] = [
  {
    key: "theme",
    section: "general",
    group: "Appearance",
    label: "Theme",
    description: "Color theme applied to the workspace, SQL editor, and result grids.",
    keywords: ["appearance", "dark", "light", "system", "color"],
    kind: "select",
  },
  {
    key: "show_system_objects",
    section: "general",
    group: "Explorer",
    label: "Show system objects",
    description: "Include internal catalogs and system schemas in the database explorer.",
    keywords: ["explorer", "sidebar", "catalog", "schema", "pg_catalog", "sys"],
    kind: "switch",
  },
  {
    key: "confirm_production",
    section: "general",
    group: "Confirmations",
    label: "Confirm production writes",
    description:
      "Ask for confirmation before running statements that may modify data on a Production connection.",
    keywords: ["safety", "prod", "production", "write", "warning", "guard"],
    kind: "switch",
  },
  {
    key: "notify_on_query_complete",
    section: "general",
    group: "Notifications",
    label: "Query completion toast",
    description:
      "Show a notification toast in the bottom-right corner when a query finishes running.",
    keywords: ["notification", "toast", "alert", "query", "finish", "complete", "done"],
    kind: "switch",
  },
  {
    key: "notify_sound",
    section: "general",
    group: "Notifications",
    label: "Query completion sound",
    description: "Play an audio chime when a query finishes running.",
    keywords: ["notification", "sound", "audio", "chime", "ding", "bell", "alert", "query"],
    kind: "switch",
  },
  {
    key: "editor_font_size",
    section: "query",
    group: "Editor",
    label: "Editor font size",
    description: "Font size in pixels used in the SQL editor.",
    keywords: ["sql", "font", "size", "text", "px", "codemirror"],
    kind: "number",
    min: 10,
    max: 32,
    unit: "px",
  },
  {
    key: "blank_line_delimiter",
    section: "query",
    group: "Editor",
    label: "Blank-line statement delimiter",
    description: "Use blank lines to separate and select SQL statements at the cursor.",
    keywords: ["sql", "delimiter", "statement", "cursor", "run"],
    kind: "switch",
  },
  {
    key: "fetch_size",
    section: "query",
    group: "Execution limits",
    label: "Initial fetch size",
    description:
      "Rows fetched immediately before pausing a result cursor. Applies to new sessions.",
    keywords: ["query", "rows", "cursor", "page", "batch", "limit"],
    kind: "number",
    min: 1,
    max: 200_000,
    unit: "rows",
  },
  {
    key: "row_cap",
    section: "query",
    group: "Execution limits",
    label: "Result row cap",
    description: "Maximum rows kept in memory per result set. Applies to new sessions.",
    keywords: ["query", "rows", "cap", "maximum", "memory", "limit"],
    kind: "number",
    min: 1,
    max: 200_000,
    unit: "rows",
  },
  {
    key: "statement_timeout_ms",
    section: "query",
    group: "Execution limits",
    label: "Statement timeout",
    description:
      "Cancel statements that exceed this duration in milliseconds. Use 0 for no timeout. Applies to new sessions.",
    keywords: ["query", "timeout", "cancel", "duration", "ms", "milliseconds"],
    kind: "number",
    min: 0,
    max: 4_294_967_295,
    unit: "ms",
  },
  {
    key: "agent_default_row_limit",
    section: "agents",
    group: "Agent query limits",
    label: "Agent default rows",
    description: "Default row limit applied to MCP agent queries when no limit is specified.",
    keywords: ["mcp", "agent", "rows", "default", "limit"],
    kind: "number",
    min: 1,
    max: 10_000,
    unit: "rows",
  },
  {
    key: "agent_max_row_limit",
    section: "agents",
    group: "Agent query limits",
    label: "Agent maximum rows",
    description: "Upper bound on rows an MCP agent query is allowed to return.",
    keywords: ["mcp", "agent", "rows", "max", "maximum", "limit"],
    kind: "number",
    min: 1,
    max: 10_000,
    unit: "rows",
  },
  {
    key: "agent_statement_timeout_s",
    section: "agents",
    group: "Agent query limits",
    label: "Agent statement timeout",
    description: "Maximum execution time in seconds for MCP agent statements.",
    keywords: ["mcp", "agent", "timeout", "seconds", "duration"],
    kind: "number",
    min: 1,
    max: 120,
    unit: "s",
  },
];

interface KeybindingEntry {
  group: string;
  label: string;
  description: string;
  keys: string;
}

function keybindingEntries(): KeybindingEntry[] {
  return [
    {
      group: "Query execution",
      label: "Run statement",
      description: "Execute the selected SQL or statement at the cursor.",
      keys: shortcuts.run,
    },
    {
      group: "Query execution",
      label: "Run statement in new result tab",
      description: "Execute the current statement and open its results in a new result tab.",
      keys: shortcuts.runInNewTab,
    },
    {
      group: "Query execution",
      label: "Run script",
      description: "Execute the entire SQL script in the active tab.",
      keys: shortcuts.script,
    },
    {
      group: "Query execution",
      label: "Stop query",
      description: "Cancel the currently running query or pause fetching.",
      keys: shortcuts.stop,
    },
    {
      group: "Query execution",
      label: "Explain statement",
      description: "Run an execution plan for the current statement.",
      keys: shortcuts.explain,
    },
    {
      group: "Query execution",
      label: "Format SQL",
      description: "Format the selected SQL or entire editor buffer.",
      keys: shortcuts.format,
    },
    {
      group: "Navigation & workspace",
      label: "Quick open",
      description: "Search loaded database tables, views, and routines.",
      keys: shortcuts.palette,
    },
    {
      group: "Navigation & workspace",
      label: "Toggle activity",
      description: "Show or hide the right-side activity and pinned queries sidebar.",
      keys: shortcuts.activity,
    },
    {
      group: "Navigation & workspace",
      label: "Toggle explorer",
      description: "Show or hide the connections and catalog sidebar.",
      keys: shortcuts.explorer,
    },
    {
      group: "Navigation & workspace",
      label: "Inspect object at cursor",
      description: "Resolve and inspect the table or column under the cursor.",
      keys: shortcuts.navigate,
    },
    {
      group: "Tabs & files",
      label: "New SQL tab",
      description: "Open a new SQL editor tab for the active connection.",
      keys: browserMode ? "Alt+T" : shortcuts.newTab,
    },
    {
      group: "Tabs & files",
      label: "Close tab",
      description: "Close the active SQL or schema inspector tab.",
      keys: browserMode ? "Alt+W" : shortcuts.closeTab,
    },
    {
      group: "Tabs & files",
      label: "Open SQL file",
      description: "Load a local .sql file into a new tab.",
      keys: shortcuts.openSql,
    },
    {
      group: "Tabs & files",
      label: "Save SQL file",
      description: "Save the active editor contents to its linked file, or choose a new SQL file.",
      keys: shortcuts.saveSql,
    },
    {
      group: "Tabs & files",
      label: "Save SQL file as",
      description: "Save the active editor contents to a new SQL file.",
      keys: shortcuts.saveSqlAs,
    },
  ];
}

const navGroups: Array<{
  title?: string;
  items: Array<{ id: SectionId; label: string; icon: typeof SlidersHorizontal }>;
}> = [
  {
    items: [
      { id: "general", label: "General", icon: SlidersHorizontal },
      { id: "query", label: "Query & Editor", icon: FileCode2 },
      { id: "keybindings", label: "Keybindings", icon: Keyboard },
    ],
  },
  {
    title: "Agents",
    items: [{ id: "agents", label: "Agent & MCP", icon: ShieldCheck }],
  },
  {
    title: "Connections",
    items: [{ id: "connections", label: "Connections", icon: Database }],
  },
];

const sectionLabels: Record<SectionId, string> = {
  general: "General",
  query: "Query & Editor",
  keybindings: "Keybindings",
  agents: "Agent & MCP",
  connections: "Connections",
};

const driverLabels: Record<Connection["kind"], string> = {
  postgres: "PostgreSQL",
  sqlserver: "SQL Server",
  oracle: "Oracle",
};

const envLabels: Record<Connection["env"], string> = {
  dev: "Development",
  staging: "Staging",
  prod: "Production",
};

const agentAccessLabels: Record<Connection["agentAccess"], string> = {
  none: "No agent",
  read: "Agent: Read",
  write: "Agent: Read & write",
};

export function isDefaultSettings(settings: Settings): boolean {
  return (Object.keys(defaultSettings) as Array<keyof Settings>).every(
    (key) => settings[key] === defaultSettings[key],
  );
}

export function parseSettingNumber(
  raw: string,
  min: number,
  max: number,
): { value: number } | { error: string } {
  const trimmed = raw.trim();
  if (!trimmed || !/^-?\d+$/.test(trimmed)) {
    return {
      error: `Enter a whole number between ${min.toLocaleString()} and ${max.toLocaleString()}.`,
    };
  }
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    return {
      error: `Enter a value between ${min.toLocaleString()} and ${max.toLocaleString()}.`,
    };
  }
  return { value };
}

export function matchesQuery(query: string, ...fields: Array<string | null | undefined>): boolean {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return true;
  const haystack = fields
    .filter((value): value is string => Boolean(value))
    .join(" ")
    .toLowerCase();
  return tokens.every((token) => haystack.includes(token));
}

export function groupConnections(
  profiles: Connection[],
): Array<{ folder: string | null; items: Connection[] }> {
  const ungrouped: Connection[] = [];
  const folders = new Map<string, Connection[]>();
  for (const profile of profiles) {
    const folder = profile.folder?.trim() || null;
    if (!folder) {
      ungrouped.push(profile);
    } else {
      const list = folders.get(folder) ?? [];
      list.push(profile);
      folders.set(folder, list);
    }
  }
  const result: Array<{ folder: string | null; items: Connection[] }> = [];
  if (ungrouped.length) result.push({ folder: null, items: ungrouped });
  for (const [folder, items] of folders) {
    result.push({ folder, items });
  }
  return result;
}

export function formatEndpoint(connection: Connection): string {
  const authPrefix = connection.user ? `${connection.user}@` : "";
  return `${authPrefix}${connection.host}:${connection.port}/${connection.database}`;
}

export interface SettingsUpdateProps {
  version: string | null;
  checking: boolean;
  checkState: UpdateCheckState;
  checkError: string;
  status: string;
  canInstall: boolean;
  onCheck: () => Promise<void>;
  onInstall: () => string | null;
}

export function describeCliStatus(status: CliStatus | null, loading: boolean): string {
  if (loading) return "Checking Strata CLI installation…";
  if (!status) {
    return "Install the standalone strata CLI so MCP clients can use saved connections without keeping Strata open.";
  }
  if (status.installed && status.needsUpdate) {
    return `Installed at ${status.path ?? "user bin"}, but an updated version is ready.`;
  }
  if (status.installed && status.onPath) {
    return `Installed on PATH at ${status.path}.`;
  }
  if (status.installed) {
    return status.installDir
      ? `Installed at ${status.path}. Add ${status.installDir} to PATH to run strata from any shell.`
      : `Installed at ${status.path}.`;
  }
  if (status.ephemeral) {
    return status.installDir
      ? `Install the strata CLI into ${status.installDir} so MCP configs stay valid after closing the AppImage.`
      : "Install the strata CLI to a permanent folder so MCP configs stay valid after closing the AppImage.";
  }
  return status.installDir
    ? `Install the standalone strata CLI into ${status.installDir} for terminal and MCP access.`
    : "Install the standalone strata CLI for terminal and MCP access.";
}

export function describeUpdateStatus(
  update: Pick<SettingsUpdateProps, "version" | "checking" | "checkState" | "status">,
): string {
  if (update.status) return update.status;
  if (update.version) return `Strata ${update.version} is ready to install.`;
  if (update.checking) return "Checking for a newer version of Strata…";
  if (update.checkState === "up-to-date") return "Strata is up to date.";
  return "Check for newer signed releases of Strata.";
}

export function matchesUpdateQuery(query: string): boolean {
  return matchesQuery(
    query,
    "Updates",
    "Application updates",
    "Check for updates",
    "Check for newer signed releases of Strata",
    "version",
    "release",
    "upgrade",
    "install",
  );
}

export interface SettingsDialogProps {
  initial: Settings;
  profiles: Connection[];
  activeConnectionId?: string | null;
  onClose: () => void;
  onSave: (value: Settings) => void;
  onSaveConnection: (profile: Connection, enteredPassword?: string) => void;
  onDeleteConnection: (id: string) => Promise<void>;
  onOpenConnection: (id: string) => void;
  onNotify?: (message: string) => void;
  update?: SettingsUpdateProps;
}

export function SettingsDialog({
  initial,
  profiles,
  activeConnectionId,
  onClose,
  onSave,
  onSaveConnection,
  onDeleteConnection,
  onOpenConnection,
  onNotify,
  update,
}: SettingsDialogProps) {
  const [section, setSection] = useState<SectionId>("general");
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState<Settings>(initial);
  const [pendingSaves, setPendingSaves] = useState(0);
  const [savedIndicator, setSavedIndicator] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [editingConnection, setEditingConnection] = useState<Connection>();
  const [connectionBusy, setConnectionBusy] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [mcpCopied, setMcpCopied] = useState(false);
  const [cliStatus, setCliStatus] = useState<CliStatus | null>(null);
  const [cliLoading, setCliLoading] = useState(false);
  const [cliInstalling, setCliInstalling] = useState(false);

  const searchInput = useRef<HTMLInputElement>(null);
  const saveChain = useRef<Promise<void>>(Promise.resolve());
  const savedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mcpTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const isSearching = query.trim().length > 0;
  const editingFormOpen =
    !isSearching && section === "connections" && editingConnection !== undefined;
  const connectionLocked = editingFormOpen && connectionBusy;
  const saving = pendingSaves > 0;
  const busy = saving || connectionLocked || deletingId !== null;
  const shortcutsList = useMemo(() => keybindingEntries(), []);

  useEffect(() => {
    return () => {
      clearTimeout(savedTimer.current);
      clearTimeout(mcpTimer.current);
    };
  }, []);

  useEffect(() => {
    if (browserMode || section !== "agents") return;
    let active = true;
    setCliLoading(true);
    void dispatch("cli_status")
      .then((status) => {
        if (active) setCliStatus(status);
      })
      .catch(() => {
        if (active) setCliStatus(null);
      })
      .finally(() => {
        if (active) setCliLoading(false);
      });
    return () => {
      active = false;
    };
  }, [section]);

  function persistSettings(next: Settings) {
    setDraft(next);
    setSaveError("");
    setPendingSaves((count) => count + 1);
    saveChain.current = saveChain.current
      .catch(() => {})
      .then(async () => {
        try {
          await dispatch("settings_save", { settings: next });
          onSave(next);
          setSavedIndicator(true);
          clearTimeout(savedTimer.current);
          savedTimer.current = setTimeout(() => setSavedIndicator(false), 1800);
        } catch (error) {
          setSaveError(errorMessage(error));
        } finally {
          setPendingSaves((count) => Math.max(0, count - 1));
        }
      });
  }

  function updateSetting<K extends keyof Settings>(key: K, value: Settings[K]) {
    if (draft[key] === value) return;
    persistSettings({ ...draft, [key]: value });
  }

  function restoreDefaults() {
    if (busy || isDefaultSettings(draft)) return;
    persistSettings({ ...defaultSettings });
  }

  async function installCli() {
    setCliInstalling(true);
    setSaveError("");
    try {
      const status = await dispatch("install_cli");
      setCliStatus(status);
      onNotify?.(status.path ? `Strata CLI installed at ${status.path}.` : "Strata CLI installed.");
    } catch (error) {
      setSaveError(errorMessage(error));
    } finally {
      setCliInstalling(false);
    }
  }

  async function copyMcpConfig() {
    try {
      const config = await dispatch("mcp_config");
      await navigator.clipboard.writeText(JSON.stringify(config, null, 2));
      setMcpCopied(true);
      onNotify?.("MCP configuration copied.");
      clearTimeout(mcpTimer.current);
      mcpTimer.current = setTimeout(() => setMcpCopied(false), 2000);
      if (!browserMode) {
        void dispatch("cli_status")
          .then((status) => setCliStatus(status))
          .catch(() => {});
      }
    } catch (error) {
      setSaveError(errorMessage(error));
    }
  }

  async function confirmDelete(id: string) {
    setDeletingId(id);
    setSaveError("");
    try {
      await onDeleteConnection(id);
      setConfirmDeleteId(null);
    } catch (error) {
      setSaveError(errorMessage(error));
    } finally {
      setDeletingId(null);
    }
  }

  function closeConnectionEditor() {
    setConnectionBusy(false);
    setEditingConnection(undefined);
  }

  function selectSection(next: SectionId) {
    if (connectionLocked) return;
    setQuery("");
    setSection(next);
    closeConnectionEditor();
    setConfirmDeleteId(null);
  }

  function startAddConnection() {
    setQuery("");
    setSection("connections");
    setConfirmDeleteId(null);
    setConnectionBusy(false);
    setEditingConnection(emptyConnection);
  }

  function startEditConnection(connection: Connection) {
    setQuery("");
    setSection("connections");
    setConfirmDeleteId(null);
    setConnectionBusy(false);
    setEditingConnection(connection);
  }

  function startDuplicateConnection(connection: Connection) {
    setQuery("");
    setSection("connections");
    setConfirmDeleteId(null);
    setConnectionBusy(false);
    setEditingConnection({ ...connection, id: null, name: `${connection.name} copy` });
  }

  const matchingSettings = useMemo(
    () =>
      isSearching
        ? settingDefinitions.filter((item) =>
            matchesQuery(query, item.label, item.description, item.group, ...item.keywords),
          )
        : [],
    [isSearching, query],
  );

  const matchingConnections = useMemo(
    () =>
      isSearching
        ? profiles.filter((connection) =>
            matchesQuery(
              query,
              connection.name,
              connection.host,
              connection.database,
              connection.user,
              connection.folder,
              driverLabels[connection.kind],
              envLabels[connection.env],
            ),
          )
        : [],
    [isSearching, profiles, query],
  );

  const matchingKeybindings = useMemo(
    () =>
      isSearching
        ? shortcutsList.filter((item) =>
            matchesQuery(query, item.label, item.description, item.group, item.keys),
          )
        : [],
    [isSearching, query, shortcutsList],
  );

  const groupedProfiles = useMemo(() => groupConnections(profiles), [profiles]);
  const hasNamedFolders = groupedProfiles.some((group) => group.folder !== null);

  function renderSettingRow(meta: SettingMeta) {
    if (meta.kind === "select" && meta.key === "theme") {
      return (
        <div className="settings-row" key={meta.key}>
          <div className="settings-row-info">
            <label htmlFor="settings-theme" className="settings-row-title">
              {meta.label}
            </label>
            <p className="settings-row-desc">{meta.description}</p>
          </div>
          <div className="settings-row-control">
            <NativeSelect
              id="settings-theme"
              value={draft.theme}
              onChange={(event) => updateSetting("theme", event.target.value as Settings["theme"])}
            >
              <NativeSelectOption value="system">System</NativeSelectOption>
              <NativeSelectOption value="light">Light</NativeSelectOption>
              <NativeSelectOption value="dark">Dark</NativeSelectOption>
            </NativeSelect>
          </div>
        </div>
      );
    }

    if (meta.kind === "switch") {
      const key = meta.key as BooleanSettingKey;
      const inputId = `settings-${key}`;
      return (
        <div className="settings-row" key={key}>
          <div className="settings-row-info">
            <label htmlFor={inputId} className="settings-row-title">
              {meta.label}
            </label>
            <p className="settings-row-desc">{meta.description}</p>
          </div>
          <div className="settings-row-control">
            {key === "notify_sound" && (
              <Button
                type="button"
                variant="outline"
                size="xs"
                onClick={() => {
                  primeQuerySound();
                  playQuerySound("success");
                }}
              >
                Test sound
              </Button>
            )}
            <Switch
              id={inputId}
              checked={draft[key]}
              onCheckedChange={(checked) => updateSetting(key, checked)}
            />
          </div>
        </div>
      );
    }

    const key = meta.key as NumericSettingKey;
    return (
      <NumberSettingRow
        key={key}
        id={`settings-${key}`}
        label={meta.label}
        description={meta.description}
        value={draft[key]}
        min={meta.min ?? 0}
        max={meta.max ?? Number.MAX_SAFE_INTEGER}
        unit={meta.unit}
        onCommit={(value) => updateSetting(key, value)}
      />
    );
  }

  function renderSettingsGroups(items: SettingMeta[]) {
    const groups = new Map<string, SettingMeta[]>();
    for (const item of items) {
      const list = groups.get(item.group) ?? [];
      list.push(item);
      groups.set(item.group, list);
    }
    return Array.from(groups.entries()).map(([groupTitle, rows]) => (
      <section className="settings-section" key={groupTitle}>
        <h3>{groupTitle}</h3>
        <div className="settings-card">{rows.map(renderSettingRow)}</div>
      </section>
    ));
  }

  function renderConnectionRow(connection: Connection) {
    const id = connection.id;
    const confirming = id !== null && confirmDeleteId === id;
    const isDeleting = id !== null && deletingId === id;
    const isActive = id !== null && activeConnectionId === id;

    return (
      <div className="settings-connection-row" key={id ?? connection.name}>
        <div className="settings-connection-info">
          <div className="settings-connection-title-row">
            <DatabaseIcon kind={connection.kind} />
            <span className="settings-connection-name">{connection.name}</span>
            <span
              className="env-dot"
              data-env={connection.env}
              data-color={connection.color}
              aria-hidden="true"
            />
            <Badge variant="outline" className="environment-badge" data-env={connection.env}>
              {envLabels[connection.env]}
            </Badge>
            <Badge variant="secondary">{driverLabels[connection.kind]}</Badge>
            {connection.readOnly && <Badge variant="outline">Read-only</Badge>}
            {connection.agentAccess !== "none" && (
              <Badge variant="outline">{agentAccessLabels[connection.agentAccess]}</Badge>
            )}
            {isActive && <Badge variant="outline">Active</Badge>}
          </div>
          <p className="settings-connection-meta">{formatEndpoint(connection)}</p>
        </div>
        <div className="settings-connection-actions">
          {confirming && id ? (
            <>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                disabled={isDeleting}
                onClick={() => setConfirmDeleteId(null)}
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant="destructive"
                size="xs"
                disabled={isDeleting}
                onClick={() => void confirmDelete(id)}
              >
                {isDeleting ? "Deleting…" : "Delete"}
              </Button>
            </>
          ) : (
            <>
              {id && (
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  onClick={() => {
                    onOpenConnection(id);
                    onClose();
                  }}
                >
                  Open
                </Button>
              )}
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                title={`Edit ${connection.name}`}
                aria-label={`Edit ${connection.name}`}
                onClick={() => startEditConnection(connection)}
              >
                <Pencil />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                title={`Duplicate ${connection.name}`}
                aria-label={`Duplicate ${connection.name}`}
                onClick={() => startDuplicateConnection(connection)}
              >
                <Copy />
              </Button>
              {id && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  title={`Delete ${connection.name}`}
                  aria-label={`Delete ${connection.name}`}
                  onClick={() => setConfirmDeleteId(id)}
                >
                  <Trash2 />
                </Button>
              )}
            </>
          )}
        </div>
      </div>
    );
  }

  function renderConnectionsSection() {
    if (editingConnection) {
      return (
        <section className="settings-section">
          <div className="settings-section-heading">
            <div className="settings-subview-heading">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={connectionLocked}
                onClick={closeConnectionEditor}
              >
                <ArrowLeft /> Back
              </Button>
              <h3>{editingConnection.id ? `Edit ${editingConnection.name}` : "New connection"}</h3>
            </div>
          </div>
          <div className="settings-connection-editor">
            <ConnectionForm
              key={editingConnection.id ?? `new-${editingConnection.name}`}
              initial={editingConnection}
              footer="inline"
              onBusyChange={setConnectionBusy}
              onCancel={closeConnectionEditor}
              onSave={(saved, password) => {
                onSaveConnection(saved, password);
                closeConnectionEditor();
              }}
            />
          </div>
        </section>
      );
    }

    return (
      <>
        <section className="settings-section">
          <div className="settings-section-heading">
            <div>
              <h3>Connections</h3>
              <p className="settings-section-note">
                {profiles.length === 0
                  ? "Add a PostgreSQL, SQL Server, or Oracle connection to get started."
                  : `${profiles.length} saved ${profiles.length === 1 ? "connection" : "connections"}.`}
              </p>
            </div>
            <Button type="button" onClick={startAddConnection}>
              <Plus /> Add connection
            </Button>
          </div>

          {profiles.length === 0 ? (
            <div className="settings-card settings-empty-card">
              <div className="empty-state-icon">
                <Database />
              </div>
              <p className="settings-row-title">No saved connections yet</p>
              <p className="settings-row-desc">
                Configure connection profiles, environments, TLS, and MCP agent permissions.
              </p>
              <Button type="button" variant="outline" onClick={startAddConnection}>
                <Plus /> Add your first connection
              </Button>
            </div>
          ) : !hasNamedFolders ? (
            <div className="settings-card">{profiles.map(renderConnectionRow)}</div>
          ) : null}
        </section>

        {profiles.length > 0 &&
          hasNamedFolders &&
          groupedProfiles.map((group) => (
            <section className="settings-section" key={group.folder ?? "__ungrouped"}>
              <h3>{group.folder ?? "Ungrouped"}</h3>
              <div className="settings-card">{group.items.map(renderConnectionRow)}</div>
            </section>
          ))}
      </>
    );
  }

  function renderKeybindingsSection(entries: KeybindingEntry[]) {
    const groups = new Map<string, KeybindingEntry[]>();
    for (const entry of entries) {
      const list = groups.get(entry.group) ?? [];
      list.push(entry);
      groups.set(entry.group, list);
    }
    return Array.from(groups.entries()).map(([groupTitle, rows]) => (
      <section className="settings-section" key={groupTitle}>
        <h3>{groupTitle}</h3>
        <div className="settings-card">
          {rows.map((entry) => (
            <div className="settings-row" key={`${entry.group}-${entry.label}`}>
              <div className="settings-row-info">
                <span className="settings-row-title">{entry.label}</span>
                <p className="settings-row-desc">{entry.description}</p>
              </div>
              <div className="settings-row-control">
                <kbd className="settings-kbd">{entry.keys}</kbd>
              </div>
            </div>
          ))}
        </div>
      </section>
    ));
  }

  function renderUpdatesSection() {
    if (browserMode || !update) return null;
    return (
      <section className="settings-section">
        <h3>Updates</h3>
        <div className="settings-card">
          <div className="settings-row">
            <div className="settings-row-info">
              <span className="settings-row-title">Application updates</span>
              <p className="settings-row-desc" role="status" aria-live="polite">
                {describeUpdateStatus(update)}
              </p>
              {update.checkState === "error" && update.checkError && (
                <p className="settings-row-error" role="alert">
                  {update.checkError}
                </p>
              )}
            </div>
            <div className="settings-row-control">
              {update.version ? (
                <Button
                  type="button"
                  variant="outline"
                  disabled={!update.canInstall || !!update.status}
                  onClick={() => {
                    const blocked = update.onInstall();
                    if (blocked) setSaveError(blocked);
                  }}
                >
                  <Download /> Update to {update.version}
                </Button>
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  disabled={update.checking || !!update.status}
                  onClick={() => {
                    setSaveError("");
                    void update.onCheck();
                  }}
                >
                  <RefreshCw className={update.checking ? "update-check-spin" : undefined} />
                  {update.checking ? "Checking…" : "Check for updates"}
                </Button>
              )}
            </div>
          </div>
        </div>
      </section>
    );
  }

  function renderSearchResults() {
    const updateMatches = !browserMode && Boolean(update) && matchesUpdateQuery(query);
    const hasAny =
      matchingSettings.length > 0 ||
      updateMatches ||
      matchingConnections.length > 0 ||
      matchingKeybindings.length > 0;

    if (!hasAny) {
      return (
        <section className="settings-section">
          <div className="settings-card settings-empty-card">
            <p className="settings-row-title">No settings matched &ldquo;{query.trim()}&rdquo;</p>
            <p className="settings-row-desc">
              Try searching for theme, font size, timeout, rows, agent, or a connection name.
            </p>
            <Button type="button" variant="outline" onClick={() => setQuery("")}>
              Clear search
            </Button>
          </div>
        </section>
      );
    }

    return (
      <>
        {matchingSettings.length > 0 && renderSettingsGroups(matchingSettings)}
        {updateMatches && renderUpdatesSection()}
        {matchingConnections.length > 0 && (
          <section className="settings-section">
            <div className="settings-section-heading">
              <h3>Connections</h3>
              <Button type="button" variant="outline" size="xs" onClick={startAddConnection}>
                <Plus /> Add connection
              </Button>
            </div>
            <div className="settings-card">{matchingConnections.map(renderConnectionRow)}</div>
          </section>
        )}
        {matchingKeybindings.length > 0 && renderKeybindingsSection(matchingKeybindings)}
      </>
    );
  }

  const showRestoreDefaults =
    !isSearching && (section === "general" || section === "query" || section === "agents");

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent
        className="settings-modal"
        showCloseButton={false}
        onKeyDown={(event) => {
          const target = event.target as HTMLElement | null;
          const isField =
            target?.tagName === "INPUT" ||
            target?.tagName === "TEXTAREA" ||
            target?.tagName === "SELECT" ||
            target?.isContentEditable;
          if (event.key === "/" && !isField && !event.ctrlKey && !event.metaKey && !event.altKey) {
            event.preventDefault();
            searchInput.current?.focus();
          }
        }}
      >
        <DialogDescription className="sr-only">
          Configure Strata preferences, query limits, agent limits, and saved database connections.
        </DialogDescription>

        <aside className="settings-sidebar" aria-label="Settings sections">
          <div className="settings-search">
            <Search className="settings-search-icon" aria-hidden="true" />
            <input
              ref={searchInput}
              type="text"
              className="settings-search-input"
              aria-label="Search settings"
              placeholder="Search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape" && query) {
                  event.stopPropagation();
                  setQuery("");
                }
              }}
            />
            {query ? (
              <button
                type="button"
                className="settings-search-clear"
                aria-label="Clear search"
                onClick={() => setQuery("")}
              >
                <X />
              </button>
            ) : (
              <kbd className="settings-search-hint" aria-hidden="true">
                /
              </kbd>
            )}
          </div>

          <nav className="settings-nav">
            {navGroups.map((group, groupIndex) => (
              <div className="settings-nav-section" key={group.title ?? groupIndex}>
                {group.title && <div className="settings-nav-group">{group.title}</div>}
                {group.items.map(({ id, label, icon: Icon }) => {
                  const active = !isSearching && section === id;
                  return (
                    <button
                      key={id}
                      type="button"
                      className="settings-nav-item"
                      data-active={active}
                      aria-current={active ? "page" : undefined}
                      onClick={() => selectSection(id)}
                    >
                      <Icon aria-hidden="true" />
                      <span>{label}</span>
                      {id === "connections" && (
                        <span className="settings-nav-count">{profiles.length}</span>
                      )}
                    </button>
                  );
                })}
              </div>
            ))}
          </nav>
        </aside>

        <div className="settings-main">
          <header className="settings-header">
            <div className="settings-breadcrumb">
              <DialogTitle className="settings-breadcrumb-root">Settings</DialogTitle>
              <span className="settings-breadcrumb-sep" aria-hidden="true">
                /
              </span>
              {isSearching ? (
                <span className="settings-breadcrumb-current">Search</span>
              ) : section === "connections" && editingConnection ? (
                <>
                  <button
                    type="button"
                    className="settings-breadcrumb-link"
                    disabled={connectionLocked}
                    onClick={closeConnectionEditor}
                  >
                    Connections
                  </button>
                  <span className="settings-breadcrumb-sep" aria-hidden="true">
                    /
                  </span>
                  <span className="settings-breadcrumb-current">
                    {editingConnection.id ? editingConnection.name : "New connection"}
                  </span>
                </>
              ) : (
                <span className="settings-breadcrumb-current">{sectionLabels[section]}</span>
              )}
            </div>

            <div className="settings-header-actions">
              {(saving || savedIndicator) && (
                <span className="settings-save-status" role="status" aria-live="polite">
                  {saving ? "Saving…" : "Saved"}
                </span>
              )}
              {showRestoreDefaults && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={busy || isDefaultSettings(draft)}
                  onClick={restoreDefaults}
                >
                  <RotateCcw /> Restore defaults
                </Button>
              )}
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Close settings"
                disabled={busy}
                onClick={onClose}
              >
                <X />
              </Button>
            </div>
          </header>

          <div className="settings-scroll">
            <div className="settings-container">
              {saveError && (
                <p className="settings-error-banner" role="alert">
                  {saveError}
                </p>
              )}

              {isSearching ? (
                renderSearchResults()
              ) : section === "general" ? (
                <>
                  {renderSettingsGroups(
                    settingDefinitions.filter((item) => item.section === "general"),
                  )}
                  {renderUpdatesSection()}
                </>
              ) : section === "query" ? (
                renderSettingsGroups(settingDefinitions.filter((item) => item.section === "query"))
              ) : section === "agents" ? (
                <>
                  {renderSettingsGroups(
                    settingDefinitions.filter((item) => item.section === "agents"),
                  )}
                  {!browserMode && (
                    <section className="settings-section">
                      <h3>CLI &amp; MCP server</h3>
                      <div className="settings-card">
                        <div className="settings-row">
                          <div className="settings-row-info">
                            <span className="settings-row-title">Strata CLI</span>
                            <p className="settings-row-desc" role="status" aria-live="polite">
                              {describeCliStatus(cliStatus, cliLoading)}
                            </p>
                          </div>
                          <div className="settings-row-control">
                            {cliStatus?.installed && !cliStatus.needsUpdate && (
                              <Badge variant="outline">Installed</Badge>
                            )}
                            <Button
                              type="button"
                              variant="outline"
                              disabled={
                                cliInstalling ||
                                cliLoading ||
                                (cliStatus !== null && !cliStatus.bundledAvailable)
                              }
                              onClick={() => void installCli()}
                            >
                              <Terminal />
                              {cliInstalling
                                ? "Installing…"
                                : cliStatus?.needsUpdate
                                  ? "Update CLI"
                                  : cliStatus?.installed
                                    ? "Reinstall CLI"
                                    : "Install CLI"}
                            </Button>
                          </div>
                        </div>
                        <div className="settings-row">
                          <div className="settings-row-info">
                            <span className="settings-row-title">MCP client configuration</span>
                            <p className="settings-row-desc">
                              Copy the JSON server configuration pointing to the standalone strata
                              CLI so AI agents can query saved connections without keeping the app
                              open.
                            </p>
                          </div>
                          <div className="settings-row-control">
                            <Button
                              type="button"
                              variant="outline"
                              onClick={() => void copyMcpConfig()}
                            >
                              {mcpCopied ? <Check /> : <Copy />}
                              {mcpCopied ? "Copied" : "Copy config"}
                            </Button>
                          </div>
                        </div>
                      </div>
                    </section>
                  )}
                </>
              ) : section === "keybindings" ? (
                renderKeybindingsSection(shortcutsList)
              ) : (
                renderConnectionsSection()
              )}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function NumberSettingRow({
  id,
  label,
  description,
  value,
  min,
  max,
  unit,
  onCommit,
}: {
  id: string;
  label: string;
  description: string;
  value: number;
  min: number;
  max: number;
  unit?: string;
  onCommit: (value: number) => void;
}) {
  const [raw, setRaw] = useState(String(value));
  const [error, setError] = useState("");

  useEffect(() => {
    setRaw(String(value));
    setError("");
  }, [value]);

  function commit() {
    const parsed = parseSettingNumber(raw, min, max);
    if ("error" in parsed) {
      setError(parsed.error);
      return;
    }
    setError("");
    if (parsed.value !== value) {
      onCommit(parsed.value);
    }
  }

  return (
    <div className="settings-row">
      <div className="settings-row-info">
        <label htmlFor={id} className="settings-row-title">
          {label}
        </label>
        <p className="settings-row-desc">{description}</p>
        {error && (
          <p className="settings-row-error" role="alert">
            {error}
          </p>
        )}
      </div>
      <div className="settings-row-control">
        <div className="settings-number-field">
          <Input
            id={id}
            type="number"
            min={min}
            max={max}
            aria-invalid={error ? true : undefined}
            value={raw}
            onChange={(event) => {
              setRaw(event.target.value);
              if (error) {
                const parsed = parseSettingNumber(event.target.value, min, max);
                if (!("error" in parsed)) setError("");
              }
            }}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commit();
              } else if (event.key === "Escape") {
                setRaw(String(value));
                setError("");
              }
            }}
          />
          {unit && <span className="settings-unit">{unit}</span>}
        </div>
      </div>
    </div>
  );
}
