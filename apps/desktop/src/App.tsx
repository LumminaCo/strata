import type { EditorState } from "@codemirror/state";
import {
  Cable,
  ChevronRight,
  Copy,
  Database,
  History,
  Command as CommandIcon,
  FileCode2,
  Layers3,
  Monitor,
  Moon,
  Play,
  Plus,
  Search,
  Settings2,
  Square,
  Sun,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { ResultGrid, type ResultSet } from "@/components/result-grid";
import { SqlEditor, type EditorHandle } from "@/components/sql-editor";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import {
  Confirmation,
  ConnectionDialog,
  PasswordDialog,
  emptyConnection,
} from "@/features/connections";
import { CatalogExplorer, type CatalogEntry } from "@/features/catalog-explorer";
import { CatalogPalette, DatabasePicker, QueryHistory } from "@/features/catalog-dialogs";
import { useCatalogSchema } from "@/features/use-catalog-schema";
import { shortcuts, workspaceKeydown } from "@/features/keymap";
import { useWorkspace } from "@/features/use-workspace";
import type { Connection, RunMode } from "@/ipc/bindings/protocol";
import { browserMode, dispatch, errorMessage } from "@/ipc/client";

const themes = ["system", "light", "dark"] as const;
const themeIcons = { system: Monitor, light: Sun, dark: Moon };
const environments = { dev: "Development", staging: "Staging", prod: "Production" };

function readTheme() {
  const saved = localStorage.getItem("strata.theme");
  return themes.find((theme) => theme === saved) ?? "system";
}

export function App() {
  const data = useWorkspace();
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
  const [entries, setEntries] = useState<CatalogEntry[]>([]);
  const defaultSchema = active.session?.schema ?? "public";
  const catalog = useCatalogSchema(profile, tab, data.catalogRevision, defaultSchema, data.scope);
  const editor = useRef<EditorHandle>(null);
  const editors = useRef(new Map<string, { current: EditorState | null }>());
  const filterInput = useRef<HTMLInputElement>(null);
  const ThemeIcon = themeIcons[theme];
  const dark = theme === "dark" || (theme === "system" && systemDark);
  const editorState = tab ? editors.current.get(tab.id) : undefined;
  const selected = active.selected ?? (active.messages.length ? "messages" : null);
  const result = active.results.find((entry) => entry.id === selected);
  const showFilter = !!result && filterResult?.cursor === result.id;

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

  function changeTheme() {
    const next = themes[(themes.indexOf(theme) + 1) % themes.length] ?? "system";
    localStorage.setItem("strata.theme", next);
    setTheme(next);
  }

  function run(mode: RunMode) {
    if (!editor.current || active.busy) return;
    void data.run({ text: editor.current.text(), target: editor.current.target(), mode });
  }

  function openTab(id: string, database?: string, text?: string) {
    const profile = data.profiles.find((entry) => entry.id === id);
    const existing = data.tabs.find(
      (item) =>
        item.connectionId === id &&
        (item.database ?? profile?.database) === (database ?? profile?.database),
    );
    if (existing && text === undefined) data.selectTab(existing.id);
    else data.addTab(id, database, text);
  }

  function openObject(entry: CatalogEntry) {
    const identifier = (name: string) => `"${name.replaceAll('"', '""')}"`;
    if (!entry.connection.id) return;
    openTab(
      entry.connection.id,
      entry.database,
      `SELECT * FROM ${identifier(entry.object.schema)}.${identifier(entry.object.name)};`,
    );
    setPalette(false);
  }

  function closeTab(id: string) {
    data.closeTab(id);
    editors.current.delete(id);
  }

  async function openCell(item: ResultSet, row: number, column: number) {
    const name = item.columns[column]?.name ?? "Value";
    try {
      const value = await data.getCell(item, row, column);
      let text = value === null ? "NULL" : String(value);
      if (item.columns[column]?.kind === "json" && typeof value === "string") {
        try {
          text = JSON.stringify(JSON.parse(value), null, 2);
        } catch {
          /* Render the original value. */
        }
      }
      setValueView({ name, text });
    } catch (error) {
      data.setNotice(errorMessage(error));
    }
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
          event.defaultPrevented
        )
          return;
        const handled = workspaceKeydown(
          event.nativeEvent,
          {
            run: () => run("statement"),
            script: () => run("script"),
            stop: () => void data.stop(),
            newTab: () => {
              if (profile?.id) data.addTab(profile.id);
            },
            closeTab: () => {
              if (tab) closeTab(tab.id);
            },
            nextTab: () => data.moveTab(1),
            previousTab: () => data.moveTab(-1),
            palette: () => setPalette(true),
            history: () => setHistory(true),
            explorer: () => setExplorerOpen((open) => !open),
          },
          browserMode,
        );
        if (handled) event.stopPropagation();
      }}
    >
      <header className="toolbar">
        <div className="brand">
          <Layers3 aria-hidden="true" />
          <span>Strata</span>
        </div>
        <div className="toolbar-actions">
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
            scope={data.scope}
            onSnapshot={catalog.capture}
            onEntries={setEntries}
            openSql={openTab}
            onRefresh={data.invalidateCatalog}
            onObject={openObject}
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
            <div className="query-tab-list" role="tablist" aria-label="SQL tabs">
              {data.tabs.map((item) => {
                const connection = data.profiles.find((value) => value.id === item.connectionId);
                const title = connection?.name ?? "Deleted connection";
                const number = data.tabs
                  .filter((value) => value.connectionId === item.connectionId)
                  .indexOf(item);
                return (
                  <div key={item.id} className="query-tab" data-active={tab?.id === item.id}>
                    <Button
                      variant="ghost"
                      role="tab"
                      aria-selected={tab?.id === item.id}
                      onClick={() => data.selectTab(item.id)}
                    >
                      <FileCode2 />
                      <span>
                        {title}
                        {number ? ` ${number + 1}` : ""}
                      </span>
                      <span
                        className="env-dot"
                        data-env={connection?.env}
                        data-color={connection?.color}
                      />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`Close ${title} tab ${number + 1}`}
                      title={`Close tab (${browserMode ? "Alt+W" : shortcuts.closeTab})`}
                      onClick={() => closeTab(item.id)}
                    >
                      <X />
                    </Button>
                  </div>
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

          {tab && state ? (
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
                <div className="query-actions-end">
                  {profile?.id && (
                    <DatabasePicker
                      key={profile.id}
                      selected={tab.database ?? profile.database}
                      disabled={!!active.busy}
                      load={async () =>
                        dispatch("list_databases", { scope: await data.scope(profile) })
                      }
                      onChange={(database) => data.setDatabase(tab.id, database)}
                    />
                  )}
                  <Button
                    variant="ghost"
                    disabled={!profile || !!active.busy}
                    onClick={active.session ? data.disconnect : data.connect}
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
                      savedState={state}
                      schema={catalog.completion}
                      defaultSchema={defaultSchema}
                      diagnostic={active.diagnostic}
                      onChange={(text) => data.editText(tab.id, text)}
                    />
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
                      <div className="result-tabs" role="tablist" aria-label="Result tabs">
                        {active.results.map((item) => (
                          <Button
                            key={item.id}
                            variant="ghost"
                            role="tab"
                            aria-selected={selected === item.id}
                            onClick={() => data.setPanel(tab.id, item.id)}
                          >
                            Result {item.index + 1}
                          </Button>
                        ))}
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
                    {result ? (
                      <ResultGrid
                        key={result.id}
                        result={result}
                        themeVersion={String(dark)}
                        canFetch={result.more && !active.busy}
                        filter={showFilter ? filterResult.text : ""}
                        onMore={() => void data.fetchRows(result)}
                        onCell={(row, column) => void openCell(result, row, column)}
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

      {data.notice && (
        <div className="workspace-notice" role="alert">
          {data.notice}
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Dismiss notification"
            onClick={() => data.setNotice("")}
          >
            <X />
          </Button>
        </div>
      )}
      <footer className="status-bar" role="status">
        <span
          className="status-dot"
          data-status={active.session ? "ready" : data.notice ? "unavailable" : "idle"}
        />
        <span>
          {active.busy ??
            (active.session ? "Connected" : data.workspace ? "Disconnected" : "Starting…")}
        </span>
        {profile && <span>{profile.name}</span>}
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
            {result.more ? " · more available" : result.capped ? " · row cap reached" : ""}
          </span>
        )}
        {active.elapsed !== undefined && <span>{active.elapsed} ms</span>}
        {profile?.readOnly && <span>Read-only</span>}
      </footer>

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
            if (profile?.id) data.addTab(profile.id, tab?.database, sql);
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
