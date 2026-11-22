# Strata — V1 Build Prompt (Minimal DB Client)

Nov 21, 2026 · @Daniel

## How to use this prompt

Export this doc as Markdown, save it as `docs/SPEC.md` in an empty repo, and start a new Claude Code session with: "Read docs/SPEC.md and start Milestone M0." "Strata" is a codename; rename it before M0 if you want. Your machine only needs Docker and git.

---

## 1. Role and working agreement

You are a senior Rust + TypeScript engineer building **Strata**: a personal, minimalist, fast desktop database client (a lean DBeaver) for PostgreSQL, SQL Server and Oracle, plus a CLI and an MCP server so AI agents can use the same saved connections. The owner is a developer with 5+ years in backend, databases and frontend who will use it daily at work. Reliability and speed beat feature count.

How you work:

- Build milestone by milestone (section 16). After each one, run all checks, show the acceptance checklist with pass/fail, then continue.
- Keep `docs/PROGRESS.md` current: done, in progress, decisions taken, known issues.
- Any deviation from this spec goes in `docs/adr/NNNN-title.md`. If it touches a hard requirement (section 3), stop and ask first.
- Verify every crate and npm package version and API before using it (`cargo add`, docs.rs, the package README). Never invent APIs. If the real API differs from this spec, follow the real API and note it.
- Prefer boring, maintained, widely used libraries. Every new dependency gets a one-line justification in the commit message.
- No `unwrap()`/`expect()` on paths that touch user input, I/O or the network. Errors are typed and reach the user as readable messages.
- The host has only Docker and git. Run every command through `./x` (section 4.4); a missing tool goes into `dev/Dockerfile`, never onto the host.
- Each milestone ends green with `./x check`: `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test`, `vp check` (Oxfmt + Oxlint + types), `vp test`.
- UI work follows the design system (section 11.10); no one-off styles.
- Small commits, conventional messages (`feat(core): …`).
- Unclear UX → copy DBeaver/DataGrip behavior and note the choice.

## 2. Product summary, goals and non-goals

Strata does five things well: connect, write SQL, run it, browse results fast, and jump from a table name to its data and structure. Agents get the same connections through a CLI and an MCP server, read-only by default.

V1 goals:

- Saved connections for PostgreSQL, SQL Server and Oracle, secrets in the OS keychain.
- Tabbed SQL editor (CodeMirror 6) on top, results grid below, resizable split.
- Run statement at cursor, selection, or whole script; cancel; multiple result sets; messages panel.
- Schema explorer tree with lazy loading and schema-aware autocomplete.
- **Ctrl+Click** a table name → table view (data + columns, indexes, FKs, DDL) in the *same* tab's lower panel. **Ctrl+Shift+Click** → a new *Schema* tab focused on that table.
- Query history, environment tags (dev/staging/prod) with write confirmations on prod.
- `strata` CLI and `strata mcp` (stdio MCP server) sharing the same core, config and keychain.

Non-goals for V1 (V2 list in section 18): data export, ER diagrams, inline cell editing, visual query builder. Also out: user management, backups, migrations tooling, plugins, cloud sync, auto-update, multi-user.

## 3. Hard requirements

One installer, zero prerequisites: no Oracle Instant Client, no ODBC, no FreeTDS, no OpenSSL, no Java, no Node runtime on the user's machine. Everything the app needs ships inside the bundle.

- **Platforms:** Windows 10/11 x64 (primary), macOS arm64, Linux x64. Build and test on all three in CI.
- **TLS:** rustls everywhere. No `native-tls`/OpenSSL in the dependency tree (`cargo tree -i openssl` must be empty).
- **Bundled helper:** the only extra binary is `oracle-bridge` (section 8.3), shipped via Tauri `externalBin`, spawned lazily on the first Oracle connection, and killed with the app.
- **Secrets:** never written in plain text to disk or logs. Never returned to agents.
- **Offline:** works with no internet. No telemetry, no update checks.
- **Development:** the host needs only Docker (with Compose v2) and git. A fresh clone must run `./x up`, `./x check`, `./x test-int` and `./x bundle-windows` with nothing else installed (section 4.4).

Performance budgets (measure and report at M8):

| Metric | Budget |
| --- | --- |
| Cold start to usable editor | < 1.0 s |
| Idle memory, app + webview, 1 connection | < 200 MB on Windows, < 150 MB on macOS |
| Installer size (incl. oracle-bridge) | < 35 MB |
| First rows on screen after the server returns them | < 100 ms |
| Grid scrolling with 100k fetched rows | 60 fps, no jank |
| Rows held in memory per result before "fetch more" | 500 by default (configurable) |
| Hard cap of rows kept per result in memory | 200k, then stop fetching and say so |

## 4. Tech stack

Rust core + Tauri 2 shell + React/CodeMirror 6 frontend, with one small Go helper for Oracle. Use the latest stable version of each, pinned in `Cargo.lock` / `bun.lock`; verify feature names before use.

### 4.1 Rust crates (workspace dependencies)

| Area | Crate | Notes |
| --- | --- | --- |
| Desktop shell | `tauri` 2 | Plus `tauri-plugin-dialog`, `-window-state`, `-single-instance`, `-log`. No shell plugin needed: core spawns the bridge itself. |
| Async | `tokio`, `tokio-util`, `futures`, `async-trait` | `tokio-util` compat layer for tiberius. `async-trait` keeps `dyn Driver` usable. |
| PostgreSQL | `tokio-postgres`, `tokio-postgres-rustls`, `rustls`, `rustls-native-certs`, `deadpool-postgres` | Native certs so corporate CAs work. Pool only for metadata. |
| SQL Server | `tiberius = { package = "tiberius-ng", version = "0.13" }` | Maintained drop-in fork of tiberius. Features: rustls TLS, chrono, `sql-browser-tokio` (named instances), Windows auth. No OpenSSL feature. |
| Oracle | none in Rust | Handled by `oracle-bridge` (Go, section 8.3). |
| Config/serde | `serde`, `serde_json`, `toml`, `toml_edit`, `notify` | `notify` lets the app reload when the CLI edits config; `toml_edit` keeps comments when writing. |
| Storage | `rusqlite` (feature `bundled`), `directories` | History + audit in SQLite, WAL mode. |
| Secrets | `keyring` 3, `zeroize` | Native backends: Windows Credential Manager, macOS Keychain, Linux Secret Service (pure-Rust crypto, vendored). `zeroize` wipes secrets from memory. |
| SQL analysis | `sqlparser` | Read-only classification only. Splitting is our own lexer. |
| Errors/logs | `thiserror` (libs), `anyhow` (bins), `tracing`, `tracing-subscriber`, `tracing-appender` | Rolling log files, secrets redacted. |
| Types to TS | `ts-rs` | Generates `apps/desktop/src/ipc/bindings/*.ts` from DTOs. |
| CLI | `clap` 4 (derive), `comfy-table`, `csv`, `rpassword` |  |
| MCP | `rmcp` 3 (features `server`, `macros`, `schemars`, `transport-io`), `schemars` | Official Rust MCP SDK, stdio transport. |
| Dev server (dev only) | `axum` (feature `ws`), `tower-http` (CORS) | Only in `strata-devserver` for browser mode; never in release bundles. |
| Misc | `uuid` (v7), `chrono`, `parking_lot` |  |
| Tests | `insta`, `pretty_assertions` | Snapshot tests for splitter and introspection. |

### 4.2 Oracle bridge (Go)

| Item | Choice |
| --- | --- |
| Language | Go, latest stable |
| Driver | `github.com/sijms/go-ora` (pure Go, thin protocol, Oracle 10.2+ incl. 11g/12c/19c/21c/23ai). Use the latest stable major version after checking its README. |
| Other deps | Standard library only (`encoding/json`, `bufio`, `context`, `database/sql`). |
| Build | `CGO_ENABLED=0 go build -trimpath -ldflags "-s -w"`, one binary per target triple. |

### 4.3 Frontend (`apps/desktop`)

| Area | Package | Notes |
| --- | --- | --- |
| Toolchain | `vite-plus` (the `vp` CLI) | One CLI for dev server, build, Vitest, Oxlint, Oxfmt and tasks; their config lives in `vite.config.ts`. `vp check` = format + lint + types, `vp test` = Vitest. Scaffold with `vp create` (or `vp migrate`), which also sets the `vite`/`vitest` overrides plugins need. No ESLint, Prettier or Biome. |
| Package manager | Bun, pinned with `vp env pin bun@<version>` (`devEngines`), `bun.lock` committed | Always through `vp install` / `vp add`; never npm or pnpm. |
| Framework | `react` 19, `typescript` (strict), `@tauri-apps/api` 2 | Tauri runs `vp dev` / `vp build` as its before-commands. |
| Editor | `@codemirror/state`, `view`, `commands`, `language`, `lang-sql`, `autocomplete`, `search`, `lint`, `@lezer/highlight`, `sql-formatter` | No React wrapper; mount `EditorView` in a ref. `lang-sql` ships `PostgreSQL`, `MSSQL` and `PLSQL` dialects. |
| UI components | shadcn/ui (CLI v4 via `bunx --bun shadcn@latest`), `tailwindcss` 4 + `@tailwindcss/vite`, `lucide-react`, `sonner` | Components live in `src/components/ui/` and are ours. One primitive library for all of them (the CLI default, Base UI or Radix), never mixed. Rules in section 11.10. |
| Layout and palette | shadcn `Resizable` (`react-resizable-panels`) and `Command` (`cmdk`) | Editor/results split, sidebar, Ctrl+K palette. |
| Results grid | `@glideapps/glide-data-grid` 6 (+ peers `lodash`, `marked`, `react-responsive-carousel`) | Canvas grid, millions of rows, built-in selection/copy; editing ready for V2. Themed from the same tokens as shadcn. |
| State | `zustand` | One store per domain. |
| Tree | `@tanstack/react-virtual` | Virtualized schema explorer. |
| Shortcuts | `tinykeys` | Global shortcuts outside the editor. |
| Tests | `@testing-library/react` under `vp test` |  |

### 4.4 Development environment (Docker only)

The host needs only Docker (with Compose v2) and git. Every toolchain, database and build runs in containers; `./x <task>` (bash) and `x.ps1` (PowerShell) are the only entry points and just run `docker compose run --rm dev just <task>`.

**Dev image** (`dev/Dockerfile`, official Rust Debian base, every version pinned as a build arg):

- Rust stable with `rustfmt`, `clippy` and the `x86_64-pc-windows-msvc` target; `cargo-tauri`, `cargo-xwin`, `cargo-nextest`, `cargo-watch`, `just`.
- Go (for the bridge), `go-sqlcmd` (SQL Server seeding), Vite+ (`vp`), which manages Node and the pinned Bun.
- Tauri Linux libraries (webkit2gtk-4.1, librsvg, libayatana-appindicator, patchelf) plus NSIS, clang, lld and llvm for Windows cross-builds.
- A non-root user with the host's UID/GID (build args) so files in the bind mount stay yours.

**Services** (one root `docker-compose.yml`, all host ports bound to `127.0.0.1`):

| Service | Image | Purpose |
| --- | --- | --- |
| `dev` | `dev/Dockerfile` | Toolchain; target of `./x` |
| `devserver` | same image | `cargo watch` running `strata-devserver` (browser-mode backend), port 7420 |
| `web` | same image | `vp dev` with HMR, port 5173 |
| `postgres` | `postgres:17` | Seeded test database |
| `mssql` | `mcr.microsoft.com/mssql/server:2022-latest` | Seeded test database (amd64; emulated on Apple Silicon) |
| `oracle` | `gvenzl/oracle-free:23-slim` | Seeded test database |
| `oracle11` | `gvenzl/oracle-xe:11-slim` | Profile `legacy`, for 11g tests |

- Named volumes for the cargo registry, `target/`, the Bun cache, `node_modules` and database data, so builds stay fast on Docker Desktop.
- On Windows, keep the repo inside the WSL2 filesystem; otherwise turn on polling (`server.watch.usePolling`, `CARGO_WATCH_POLL`).
- Dev connection passwords live in a gitignored `.env` and reach Strata as `secret = "env:…"`.
- Healthchecks gate `devserver` and the test runs; PostgreSQL and Oracle seed from their init directories, SQL Server through `just seed`.

**Running the UI while developing:**

- **Browser mode (default, any OS):** `./x up` starts the databases, `devserver` and `web`; open `http://localhost:5173`. The frontend talks to `strata-devserver` over HTTP/WebSocket instead of Tauri IPC, with the same Rust code behind it (section 12).
- **Native window (optional):** `./x gui` runs `cargo tauri dev` with X11/Wayland forwarding on Linux hosts or WSLg on Windows 11. Not available on macOS hosts; use browser mode there.
- **Real installers:** `./x bundle-linux` (AppImage + deb) and `./x bundle-windows` (NSIS through `cargo-xwin`, Tauri's cross-compile path) run in Docker; install the output on the host to test the native app. macOS bundles build on a macOS CI runner, since Apple's tooling cannot run in Docker.

**CI:** GitHub Actions builds the dev image once (cached) and runs `just ci` inside it; integration jobs use the same compose file; only the macOS bundle job runs outside Docker.

`justfile` recipes (inside the container): `up`, `down`, `gui`, `check`, `test-int`, `seed`, `bridge`, `bindings`, `bundle-linux`, `bundle-windows`, `ci`.

## 5. Architecture

`strata-core` is a library used in-process by both the desktop app and the CLI; there is no daemon in V1. The two processes share state only through files: the config, the OS keychain and one SQLite database.

```text
+--------------------------- Strata desktop (Tauri) ----------------------------+
|  WebView (React + CodeMirror + Glide grid)                                     |
|        | invoke() commands            ^ Channel<T> streams / events           |
|        v                              |                                        |
|  src-tauri: thin command layer, AppState { core: Arc<Core> }                   |
|        |                                                                       |
|  strata-core: ConnectionManager, Sessions, ResultCursors, Metadata cache      |
|     |                 |                    |                                   |
|  pg driver        mssql driver        oracle driver --JSON lines/stdio--> oracle-bridge (Go)
|  tokio-postgres   tiberius-ng         (bridge client)                          |
+--------------------------------------------------------------------------------+

+---------------- strata CLI (separate binary, same crates) ---------------------+
|  strata conn | ls | describe | query        <- humans, scripts                 |
|  strata mcp  -> rmcp stdio server -> core   <- AI agents spawn this            |
+--------------------------------------------------------------------------------+

Shared on disk:  config.toml (connections, no secrets) | OS keychain (secrets)
                 strata.db (SQLite WAL: history, audit log, metadata cache)
```

Rules of the process model:

- **Sessions:** every editor tab owns one dedicated connection, opened on first run, so `SET`, temp tables and transactions behave like a real console. Closing the tab closes it.
- **Metadata pool:** each connection profile has a small pool (max 2) for explorer, autocomplete, Ctrl+Click lookups and table-data views, so they never block an editor session.
- **Bridge:** at most one `oracle-bridge` process per host process (app or CLI), spawned on the first Oracle connect, hosting many connections. If it dies, Oracle sessions show "disconnected" and reconnect on next run.
- **Agents:** the MCP server opens its own connections from the shared config; it never touches the app's sessions. The app shows agent activity by reading the audit log.
- **Command layer:** every UI command lives in `strata-app` (`AppService`). `src-tauri` and the dev-only `strata-devserver` are thin wrappers over it, so browser mode runs exactly the same code (section 12).
- **Why no daemon:** fewer moving parts and no local auth problem. A local socket that lets agents reuse app sessions is a V2+ option (section 19).

## 6. Repository structure

One monorepo: a Cargo workspace for Rust, a Bun workspace (driven by Vite+) for the frontend, a Go module for the bridge. Drivers are separate crates so a driver can be swapped (for example a future pure-Rust Oracle driver) without touching the rest.

```text
strata/
├── Cargo.toml                 # [workspace], [workspace.dependencies], [workspace.lints]
├── rust-toolchain.toml        # stable, pinned
├── docker-compose.yml         # dev, devserver, web, postgres, mssql, oracle (+ oracle11 profile)
├── x  x.ps1                   # wrappers: docker compose run --rm dev just <task>
├── justfile                   # recipes run inside the dev container
├── package.json  bun.lock     # Bun workspace; devEngines pins Bun (via vp env pin)
├── .env.example               # dev DB passwords, devserver token
├── .github/workflows/{ci.yml, release.yml}
├── docs/{SPEC.md, PROGRESS.md, DESIGN.md, SMOKE.md, adr/0001-oracle-bridge.md}
├── dev/
│   ├── Dockerfile             # the toolchain image (section 4.4)
│   └── seed/{postgres,mssql,oracle}/*.sql   # tricky types, FKs, 1M-row table
├── crates/
│   ├── strata-core/src/       # lib.rs core.rs driver.rs session.rs cursor.rs
│   │                          # metadata_cache.rs safety.rs error.rs
│   │                          # model/{value,column,result,metadata,profile}.rs
│   ├── strata-sql/src/        # pure, no I/O: lexer.rs splitter.rs stmt_at_cursor.rs
│   │                          # classify.rs ident.rs dialect.rs
│   ├── strata-store/src/      # paths.rs config.rs secrets.rs history.rs audit.rs migrations/
│   ├── strata-driver-postgres/src/  # connect.rs exec.rs values.rs introspect.rs queries/*.sql
│   ├── strata-driver-mssql/src/     # same layout
│   ├── strata-driver-oracle/src/    # bridge.rs (locate/spawn/supervise) protocol.rs
│   │                                # introspect.rs queries/*.sql
│   ├── strata-app/src/        # AppService: one async method per UI command (DTO in/out)
│   ├── strata-devserver/src/  # dev only: axum HTTP + WebSocket over AppService
│   ├── strata-mcp/src/        # server.rs tools.rs guard.rs
│   └── strata-cli/src/        # main.rs output.rs cmd/{conn,ls,describe,query,mcp}.rs
├── bridge/oracle/             # Go: go.mod main.go protocol.go session.go values.go
└── apps/desktop/
    ├── package.json  vite.config.ts  components.json  tsconfig.json
    │                          # vite.config.ts holds Vite+ lint, fmt, test and task config
    ├── src-tauri/
    │   ├── tauri.conf.json    # beforeDevCommand "vp dev", beforeBuildCommand "vp build"
    │   ├── capabilities/default.json  build.rs
    │   ├── binaries/          # oracle-bridge-<triple>, strata-<triple> (built by `just`)
    │   └── src/{main.rs, state.rs, events.rs, commands.rs}   # thin wrappers over strata-app
    └── src/
        ├── main.tsx  App.tsx
        ├── ipc/{client.ts, transport-tauri.ts, transport-dev.ts, bindings/}
        ├── components/ui/     # shadcn components (owned; only place primitives are imported)
        ├── components/        # composed: Toolbar, Panel, EmptyState, EnvBadge, KbdHint
        ├── theme/{glide.ts, codemirror.ts}   # both built from the CSS tokens
        ├── lib/utils.ts       # cn()
        ├── stores/{connections,tabs,results,settings,agentActivity}.ts
        ├── features/
        │   ├── connections/   # ConnectionDialog, ConnectionList
        │   ├── explorer/      # SchemaTree (virtualized), context menus
        │   ├── editor/        # SqlEditor.tsx + extensions/{ctrlClick,completion,
        │   │                  #   keymap,statementHighlight}.ts
        │   ├── results/       # ResultPanel, ResultGrid, MessagesView, StatusBar
        │   ├── table-view/    # Data | Columns | Keys & Indexes | References | DDL | Info
        │   ├── schema-tab/
        │   ├── history/
        │   ├── agent-activity/
        │   └── settings/
        └── styles/globals.css # Tailwind + shadcn tokens + Strata tokens (section 11.10)
```

The `strata` CLI ships inside the installer as a second `externalBin`, so one install gives app + CLI + MCP. Settings has an **Install CLI to PATH** action (symlink into `~/.local/bin` on macOS/Linux, a user-PATH entry on Windows).

The `justfile` recipes are listed in section 4.4; all of them run inside the dev container.

## 7. Core engine design

Everything dialect-specific hides behind three traits; everything the UI, CLI and MCP need goes through one `Core` facade. Treat the sketch below as the contract and refine signatures as needed.

```rust
pub enum DbKind { Postgres, SqlServer, Oracle }

#[async_trait]
pub trait Driver: Send + Sync {
    fn kind(&self) -> DbKind;
    async fn connect(&self, p: &Profile, s: Secret) -> Result<Box<dyn DbConnection>>;
}

#[async_trait]
pub trait DbConnection: Send {
    /// One statement. Returns a pull-based stream of events.
    async fn execute(&mut self, sql: &str, opts: ExecOptions) -> Result<ExecStream>;
    fn cancel_handle(&self) -> CancelHandle;          // usable while execute runs
    async fn set_read_only(&mut self, on: bool) -> Result<()>;
    async fn begin(&mut self) -> Result<()>;
    async fn commit(&mut self) -> Result<()>;
    async fn rollback(&mut self) -> Result<()>;
    async fn server_info(&mut self) -> Result<ServerInfo>; // version, current db/schema, user
    async fn ping(&mut self) -> Result<()>;
}

#[async_trait]
pub trait Introspector: Send + Sync {
    async fn databases(&self) -> Result<Vec<String>>;
    async fn schemas(&self, db: Option<&str>) -> Result<Vec<SchemaInfo>>;
    async fn objects(&self, schema: &str, kinds: &[ObjKind]) -> Result<Vec<ObjInfo>>;
    async fn table_detail(&self, t: &ObjRef) -> Result<TableDetail>; // cols, pk, fks, idx, checks, stats
    async fn ddl(&self, o: &ObjRef) -> Result<String>;
    async fn resolve(&self, ident: &IdentPath, ctx: &ResolveCtx) -> Result<Option<ObjRef>>;
}

pub enum ExecEvent {
    ResultStart { index: u32, columns: Vec<ColumnMeta> },
    Rows(Vec<Vec<Cell>>),
    ResultEnd { index: u32, exhausted: bool },
    Affected { rows: u64 },
    Message { level: MsgLevel, text: String },
}
```

### 7.1 Sessions and result cursors

- `Core` owns `profiles`, `sessions: HashMap<SessionId, Session>` (one per editor tab) and `cursors: HashMap<CursorId, ResultCursor>`.
- A run creates a cursor that polls the `ExecStream` until it has `fetch_size` rows (default 500), then **stops polling**; TCP backpressure pauses the server. `fetch_more(cursor, n)` resumes. This is how 10M-row queries stay cheap.
- Closing a non-exhausted cursor (new run in the same tab, tab close, Stop) = send cancel, then drain. Never let a driver silently read millions of discarded rows.
- The cursor keeps the canonical rows in Rust (cap 200k rows, configurable), so the value viewer, copy and V2 export read from Rust, not the webview.
- A session runs one statement at a time; scripts run statements sequentially and stop at the first error (setting: stop/continue).

### 7.2 Value model

- `Cell` = `Null | Bool | Int(i64) | Float(f64) | Text(String)`. Each `ColumnMeta` carries `name`, `db_type` (native name, e.g. `numeric(18,2)`, `NVARCHAR(50)`, `NUMBER(10)`), `kind`, `nullable`, and table/column origin when the driver knows it.
- `kind` ∈ `bool, int, float, decimal, text, date, time, timestamp, timestamptz, interval, uuid, json, xml, binary, array, other`. The grid uses it for alignment and icons.
- Precision rules: decimals and `NUMBER` always travel as exact text; integers outside ±2^53 become text; floats keep Rust's shortest round-trip format.
- Dates/times: ISO-style `YYYY-MM-DD HH:MM:SS[.fff][±HH:MM]`, no locale formatting.
- Binary: hex `0x…` preview of the first 64 bytes plus the total length.
- Big values: the grid receives a preview (first 2,000 chars); the full value (up to 16 MB) is fetched on demand with `get_cell`. LOBs larger than that show `[CLOB 42 MB]`.

### 7.3 Errors, cancel, timeouts

- One `CoreError` enum with `thiserror`: `Connect`, `Auth`, `Tls`, `Timeout`, `Cancelled`, `Db { code, message, detail, hint, position, line }`, `ReadOnlyViolation { reason }`, `Bridge`, `Config`, `Secret`, `Io`. Serialized to the UI as `{ kind, message, code?, position?, line? }`.
- Db errors with a position or line become an editor diagnostic at that spot.
- Cancel: PostgreSQL cancel token (over the same TLS config); SQL Server TDS attention if the crate supports it, otherwise close the socket and reconnect the session with a "session state was reset" message; Oracle via the bridge's `cancel` (Go context → protocol break).
- Timeouts: connect 10 s; statement timeout off in the UI (setting), 30 s for CLI/MCP by default.
- Lost connection: mark the session disconnected, offer **Reconnect** and, for read statements only, **Reconnect & re-run**. Never auto re-run a write.

### 7.4 Transactions

- Auto-commit by default in every dialect (the Oracle bridge commits after each statement in this mode).
- Manual mode per tab: Strata begins a transaction before the first statement; the status bar shows a "Transaction open" pill with Commit and Rollback. Closing the tab or app with an open transaction asks first.

## 8. Driver specifics

PostgreSQL and SQL Server run natively in Rust; Oracle runs through the bundled Go bridge because the pure-Rust Oracle crates are still too young for a daily-driver tool. All introspection uses catalog queries stored as `.sql` files per driver, never `information_schema` for PostgreSQL.

### 8.1 PostgreSQL (`tokio-postgres`)

- **Connect:** host, port, database, user, `sslmode` (disable, prefer, require, verify-ca, verify-full) mapped to rustls; `application_name = Strata`.
- **Execute (per statement):** first `prepare` (Parse/Describe only) to get column names and type OIDs; then run it with `simple_query_raw` (text protocol). Text results render every type exactly like psql: numeric, arrays, ranges, enums, PostGIS, custom types. If `prepare` fails, still run it and mark column types `other`.
- **Type mapping:** OID table → `kind` (int2/4/8, float4/8, numeric, bool, text family, date/time family, uuid, json/jsonb, xml, bytea, arrays via element type). Parse int/float/bool text into typed cells; everything else stays text. Convert bytea `\x…` into the binary preview.
- **Notices:** drive the `Connection` in a spawned task with `poll_message`; forward `RAISE NOTICE` and warnings to the tab's Messages view.
- **Cancel:** `cancel_token().cancel_query(tls)`.
- **Databases:** one connection = one database. Expanding another database in the explorer opens a metadata connection to it; each editor tab has a database picker.
- **Introspection:** `pg_namespace`, `pg_class` (relkind r, p, v, m, f), `pg_attribute` + `format_type`, `pg_index` + `pg_get_indexdef`, `pg_constraint` + `pg_get_constraintdef`, `pg_description`, `pg_proc` + `pg_get_functiondef`, sequences. Views via `pg_get_viewdef`. Table DDL is rebuilt from the catalog. Row estimate from `reltuples`, size from `pg_total_relation_size`. Hide `pg_toast`, `pg_temp_*`, and system schemas unless "Show system objects" is on.
- **Name resolution context:** `current_schemas(true)`.

### 8.2 SQL Server (`tiberius-ng`)

- **Connect:** host + port or named instance (SQL Browser), database, SQL login or Windows integrated auth (Windows only in V1), Encrypt (off, on, strict) + Trust server certificate checkbox, `ApplicationName = Strata`.
- **Execute:** send each unit as a raw batch with `simple_query`; read `QueryStream` items (metadata, rows, multiple result sets, affected counts). Map `ColumnData` to cells: numeric as exact text, `chrono` for date/time types, GUID, XML, binary.
- **Batches:** `GO` is client-side; the splitter handles it. Ctrl+Enter sends the whole block at the cursor (blank-line or `GO` delimited) as one batch, so `DECLARE @x` keeps working across statements.
- **Messages:** forward `PRINT`/`RAISERROR` info messages if the crate exposes them; otherwise document the gap in `PROGRESS.md`.
- **Databases:** a session switches database with `USE [db]`; the explorer reads each database with three-part names or its own metadata connection.
- **Introspection:** `sys.schemas`, `sys.objects`/`tables`/`views`, `sys.columns` + `sys.types` (alias types resolved to base types), `sys.indexes` + `index_columns`, `sys.foreign_keys` + `foreign_key_columns`, `sys.key_constraints`, `sys.check_constraints`, `sys.extended_properties` (`MS_Description`), `sys.dm_db_partition_stats` (rows), `sys.sql_modules` (view/proc/function bodies). Table DDL rebuilt from the catalog.
- **Name resolution context:** `SCHEMA_NAME()` (usually `dbo`) and `DB_NAME()`.

### 8.3 Oracle (`oracle-bridge`, Go + go-ora)

- **Process:** `strata-driver-oracle` finds the binary next to the current executable (override: `STRATA_ORACLE_BRIDGE`), spawns it with piped stdio, logs its stderr through `tracing`, restarts it on crash and fails in-flight requests with `CoreError::Bridge`.
- **Protocol:** newline-delimited JSON over stdio, versioned by a `hello` handshake. Request `{"id":7,"method":"execute","params":{…}}`; reply `{"id":7,"result":{…}}` or `{"id":7,"error":{"code":"ORA-00942","message":"…","offset":15}}`.
- **Methods:** `hello`, `connect` → `conn_id`, `close`, `execute` {conn\_id, sql, fetch\_size, max\_cell\_bytes} → {query\_id, columns | affected}, `fetch` {query\_id, n} → {rows, exhausted}, `close_query`, `cancel`, `begin`, `commit`, `rollback`, `set_read_only`, `server_info`, `ping`, `dbms_output` {conn\_id, enable | read}.
- **Concurrency:** one goroutine per connection, requests serialized per connection, all connections in parallel. Cell encoding follows section 7.2 (NUMBER as exact text).
- **Connect options:** host/port + service name or SID, or a full EZConnect/TNS descriptor; user/password; optional role (SYSDBA, SYSOPER); TCPS with optional wallet path.
- **Statement rules:** strip the trailing `;` from plain SQL (else ORA-00911); keep it for PL/SQL (`BEGIN`, `DECLARE`, `CREATE [OR REPLACE] PROCEDURE|FUNCTION|PACKAGE [BODY]|TRIGGER|TYPE`). A `/` alone on a line ends a PL/SQL unit in scripts.
- **Types to cover:** NUMBER, BINARY\_FLOAT/DOUBLE, VARCHAR2/NVARCHAR2/CHAR, DATE (render the time part too), TIMESTAMP \[WITH \[LOCAL\] TIME ZONE\], INTERVAL, RAW, LONG, LONG RAW, CLOB/NCLOB/BLOB, ROWID, XMLType (text, or `[XMLType]` if unsupported), BOOLEAN and JSON (23ai), VECTOR (as text).
- **Introspection:** `ALL_*` views only (never `DBA_*`): `ALL_USERS` (hide `ORACLE_MAINTAINED = 'Y'`), `ALL_TABLES`, `ALL_VIEWS` (`TEXT_VC` on 12c+, `TEXT` LONG otherwise), `ALL_MVIEWS`, `ALL_TAB_COLUMNS`, `ALL_CONSTRAINTS` + `ALL_CONS_COLUMNS`, `ALL_INDEXES` + `ALL_IND_COLUMNS`, `ALL_TAB_COMMENTS`/`ALL_COL_COMMENTS`, `ALL_SYNONYMS`, `ALL_PROCEDURES`/`ALL_SOURCE`, `ALL_SEQUENCES`. DDL via `DBMS_METADATA.GET_DDL`, falling back to catalog-built DDL when privileges are missing.
- **Name resolution context:** `SYS_CONTEXT('USERENV','CURRENT_SCHEMA')`, then private synonyms, then public synonyms.
- **DBMS\_OUTPUT (should-have):** per-tab toggle; after each statement read lines into the Messages view.
- **ADR 0001:** record why the bridge exists and the exit criterion: replace it with a pure-Rust driver (`oracle-rs` or `oracledb`) once one runs the full Oracle integration suite green on stable Rust, including LONG columns and 11g/19c.

## 9. SQL utilities (`strata-sql`)

All SQL text handling lives in one pure Rust crate with heavy unit and snapshot tests; the UI, CLI and MCP all call it. Offsets crossing the IPC boundary are **UTF-16 code units** (CodeMirror's unit), converted in Rust, so `ñ`, `á` and emoji never shift a statement.

### 9.1 Lexer

- Tokens: whitespace, `--` line comments, `/* */` block comments (nested for PostgreSQL), `'…'` strings with `''` escapes, PostgreSQL `E'…'` and `$tag$…$tag$`, `"quoted"` identifiers, SQL Server `[brackets]` and `N'…'`, Oracle `q'[…]'` quoting, `GO` alone on a line (SQL Server, optional count), `/` alone on a line (Oracle).
- Never panics: an unterminated string or comment runs to end of input.

### 9.2 Splitter and statement at cursor

- Delimiters: top-level `;` (PostgreSQL, Oracle SQL), a blank line (setting, default on), `GO` (SQL Server), `/` line (Oracle).
- Bodies never split: PostgreSQL dollar-quoted bodies and `BEGIN ATOMIC … END`; Oracle PL/SQL units run to the next `/` line or end of input, ignoring blank lines and inner `;`.
- SQL Server: Ctrl+Enter takes the block at the cursor (blank-line or `GO` delimited) as one batch; Run Script sends each `GO` batch whole.
- Statement at cursor: the span containing the cursor; on a blank line, the nearest span above. A selection overrides and runs as a script.
- Skip empty and comment-only units. Return spans with UTF-16 offsets plus a `kind_hint`.

### 9.3 Classifier

- `classify(sql, dialect) -> StmtClass` ∈ `Read`, `Write`, `Ddl`, `TxControl`, `Session`, `Procedural`, `Unknown`.
- Read = `SELECT`, `WITH … SELECT`, `VALUES`, `TABLE`, `SHOW`, `EXPLAIN` without `ANALYZE`. Write = `INSERT`, `UPDATE`, `DELETE`, `MERGE`, `COPY … FROM`, `SELECT … INTO`, `SELECT … FOR UPDATE`, `CALL`, `EXEC`, `EXPLAIN ANALYZE`, data-modifying CTEs. Ddl = `CREATE`, `ALTER`, `DROP`, `TRUNCATE`, `RENAME`, `COMMENT`, `GRANT`, `REVOKE`.
- Keyword-first walk over lexer tokens (skipping comments and parentheses, finding the final verb after CTEs), cross-checked with `sqlparser` when it parses. Disagreement or parse doubt → `Unknown`.
- Used for: prod confirmations, the "UPDATE/DELETE without WHERE" warning, MCP read-only guard (fail closed), and metadata cache refresh after DDL.

### 9.4 Identifier resolution (Ctrl+Click)

- `ident_at(text, offset, dialect)` returns the path under the cursor: up to three parts (`db.schema.table` on SQL Server), honoring quoting and case folding (PostgreSQL lowercases unquoted, Oracle uppercases, SQL Server compares case-insensitively).
- Alias pass over the current statement's `FROM`, `JOIN`, `UPDATE`, `INTO`, `MERGE` clauses: clicking `u` in `FROM users u` resolves to `users`; clicking `u.email` opens `users` with the `email` column highlighted.
- Resolution order: metadata cache, then `Introspector::resolve` with the session context (search path / default schema / current schema, then Oracle synonyms).
- Kinds: table, view, materialized view, foreign table, synonym (followed). Functions and procedures open their DDL in a Schema tab.
- Not found → a small tooltip "No object named X in \<schema list>", never a dialog.

## 10. Storage and secrets (`strata-store`)

Three stores, shared by app and CLI: `config.toml` for connections and settings (no secrets), the OS keychain for passwords, and `strata.db` (SQLite, WAL) for history, audit and cached state. Paths come from `directories`; `STRATA_HOME` overrides everything for tests.

### 10.1 `config.toml`

```toml
version = 1

[settings]
fetch_size = 500
theme = "system"            # system | light | dark
blank_line_delimiter = true
editor_font_size = 13
agent_default_row_limit = 200
agent_statement_timeout_s = 30

[[connection]]
id = "0193a0c2-…"           # uuid v7, stable
name = "athena-dev"         # unique; what CLI and MCP use
kind = "postgres"           # postgres | sqlserver | oracle
env = "dev"                 # dev | staging | prod
color = "#2e7d32"           # optional
folder = "work"             # optional grouping in the sidebar
host = "localhost"
port = 5432
database = "athena"
user = "daniel"
secret = "keychain"         # keychain | prompt | env:VAR_NAME
read_only = false           # forces UI sessions read-only
agent_access = "read"       # none | read | write
allow_agent_ddl = false     # only with agent_access = "write", never on prod
[connection.tls]
mode = "prefer"
[connection.options]        # driver-specific: instance, auth, encrypt,
                            # trust_server_cert, service_name, sid, descriptor, role
```

- Edit with `toml_edit` to keep the user's comments and order; write atomically (temp file + rename).
- The app watches the file with `notify` and reloads; invalid edits show a non-blocking error and keep the last good config.

### 10.2 Secrets

- `keyring` service `strata`, account = connection id. `Secret` is a newtype with redacted `Debug`/`Display`, zeroized on drop (`zeroize`).
- `prompt` mode asks on connect and keeps the secret in memory for the app session only. `env:VAR` reads an environment variable (handy for agents and CI).
- macOS asks once per binary for keychain access (app and CLI are separate binaries); document "Always Allow" in the README.
- Containers have no OS keychain: in Docker and browser mode use `env:` secrets from `.env`, or keyring's in-memory mock (gone when the devserver restarts). Never a plaintext secrets file.

### 10.3 `strata.db`

- WAL mode, `busy_timeout` 5 s, schema migrations via `PRAGMA user_version`.
- `history`: id, conn\_id, source (`ui` | `cli` | `mcp`), sql, started\_at, duration\_ms, rows, status (`ok` | `error` | `cancelled`), error. Prune to the newest 10,000 per connection.
- `audit`: id, ts, source, client\_name (MCP `clientInfo`), conn\_name, tool, sql, class, decision (`allowed` | `denied`), reason, rows, duration\_ms.
- `workspace`: open tabs, their connection, database and editor text, so scratch SQL survives restarts and crashes (autosave every 2 s while dirty).
- `metadata_cache`: per connection and schema, JSON payload + fetched\_at, so autocomplete works instantly after restart.

### 10.4 Logs

Daily rolling files, keep 7. Never log secrets, full connection strings or result data; SQL text is logged only at `debug` level.

## 11. Desktop app UX

Dense, keyboard-first, quiet. One window: explorer on the left, tabs on the right, each SQL tab split into editor (top) and results (bottom).

```text
+------------------------------------------------------------------------------+
| [athena-dev ▾ (dev)] [db: athena ▾]  [▶ Run] [■ Stop] [Explain] [Tx: auto ▾] |
+-------------+----------------------------------------------------------------+
| EXPLORER    | [scratch-1 ×] [cartera.sql • ×] [Schema: orders ×] [+]          |
| filter…     |----------------------------------------------------------------|
| ▾ athena-dev|  SQL editor (CodeMirror 6), current statement softly shaded    |
|   ▾ public  |                                                                |
|     ▸ Tables|================================ drag ==========================|
|     ▸ Views |  [Result 1] [Result 2] [Messages] [📌 users]                    |
| ▸ oracle-qa |  results grid (Glide)                                          |
+-------------+----------------------------------------------------------------+
| ● athena-dev · PostgreSQL 16.4 · public · 500 rows (more) · 132 ms · auto   |
+------------------------------------------------------------------------------+
```

### 11.1 Connections

- Dialog with per-kind fields, **Test connection** (shows server version and round-trip ms), and **Paste URL** that fills fields from `postgres://…`, `jdbc:sqlserver://…`, or an Oracle EZConnect string.
- Folders, duplicate, delete (also removes the keychain entry), env tag and color.

### 11.2 Editor (CodeMirror 6)

- Extensions: `lang-sql` with the connection's dialect (`PostgreSQL`, `MSSQL`, `PLSQL`), schema-aware completion fed by the metadata cache (schemas, tables, columns, aliases in the current statement), search/replace, bracket matching, line numbers, folding, current-statement shading (spans from `strata-sql`, refreshed 150 ms after typing), execution errors as lint diagnostics.
- **Multi-cursor moves to Alt+Click:** set `EditorView.clickAddsSelectionRange` to `altKey`, because CodeMirror uses Ctrl/Cmd+Click for extra cursors by default and that would collide with Ctrl+Click navigation.
- **Ctrl+Click (Cmd on macOS):** while the modifier is held, the identifier under the mouse gets an underline and pointer cursor (pure frontend decoration). Click → `resolve_at` → the table view opens as a pinned sub-tab in *this tab's* lower panel. Ctrl+Shift+Click → a new top-level Schema tab. F4 does the same from the keyboard.
- Format SQL with `sql-formatter` (`postgresql`, `transactsql`, `plsql`); open/save `.sql` files; dirty dot on tabs; scratch tabs autosave to `workspace`.

### 11.3 Results panel

- Sub-tabs: one per result set, **Messages** (notices, DBMS\_OUTPUT, affected rows, timings, errors), and pinned table views.
- Grid: row numbers, header tooltip with native type, resizable columns, dim italic `NULL`, right-aligned numbers, hide/pin columns.
- Infinite scroll fetches the next batch near the bottom; **Fetch all** goes to the row cap. Status shows "500 rows · more available".
- Selection of cells, rows, columns. Ctrl+C copies TSV; **Copy as** CSV, JSON or Markdown (clipboard only; file export is V2).
- Ctrl+F filters fetched rows; header click sorts fetched rows locally and says so.
- Value viewer (double-click or Shift+Enter): side panel with the full value via `get_cell`, JSON/XML pretty print, hex for binary, copy button.

### 11.4 Explorer

- Tree: connection → databases (where relevant) → schemas → Tables, Views, Materialized views, Functions, Procedures, Sequences (+ Packages and Synonyms on Oracle). Lazy loading, virtualized, item counts.
- Filter box over loaded nodes; Ctrl+P / Ctrl+K palette does fuzzy search over all cached objects.
- Double-click a table → Schema tab. Context menu: Open data, Open schema, Copy name, Generate SELECT, Refresh (F5). Drag a node into the editor to insert its qualified name.
- Auto-refresh a schema's node after DDL runs against it.

### 11.5 Table view (Ctrl+Click target)

- Segmented sections: **Data | Columns | Keys & Indexes | References | DDL | Info**.
- Data: streamed `SELECT *` with a server-side WHERE box and ORDER BY from header clicks (re-query), infinite scroll, estimated rows + **Count rows** button.
- Columns: name, type, nullable, default, PK marker, FK target (click opens that table), comment.
- Keys & Indexes: PK, unique, FKs (columns → target, ON DELETE/UPDATE), indexes (columns, unique, method, partial predicate), checks.
- References: incoming and outgoing FKs as clickable lists (the V1 stand-in for an ER diagram).
- DDL: read-only CodeMirror + copy. Info: owner, rows estimate, size, comment, created/modified where available.
- **Open as tab** promotes it to a Schema tab.

### 11.6 Schema tab (Ctrl+Shift+Click target)

Full-height version of the table view plus a left list of FK neighbors (depth 1) and back/forward history (Alt+← / Alt+→). V2's ER diagram lives here.

### 11.7 Shortcuts (Cmd replaces Ctrl on macOS)

| Action | Shortcut |
| --- | --- |
| Run statement / block at cursor | Ctrl+Enter |
| Run script (all, or selection) | Ctrl+Shift+Enter, Alt+X |
| Stop | Ctrl+. |
| Explain plan (text) | Ctrl+Shift+E |
| Table view / Schema tab | Ctrl+Click / Ctrl+Shift+Click, F4 |
| Autocomplete | Ctrl+Space |
| Format SQL | Ctrl+Shift+F |
| Toggle comment | Ctrl+/ |
| New SQL tab on current connection | Ctrl+T |
| Close tab / next / previous | Ctrl+W / Ctrl+Tab / Ctrl+Shift+Tab |
| Command palette and quick open | Ctrl+K, Ctrl+P |
| Save file | Ctrl+S |
| Toggle explorer / results / history | Ctrl+B / Ctrl+J / Ctrl+H |
| Add cursor | Alt+Click |

Define all bindings in one keymap module so remapping is a later config change.

Explain plan per dialect: PostgreSQL `EXPLAIN` (text), SQL Server `SET SHOWPLAN_TEXT ON` batch, Oracle `EXPLAIN PLAN FOR` + `DBMS_XPLAN.DISPLAY`. Output appears as a text result.

### 11.8 Safety in the UI

- Env colors everywhere: prod gets a red 3 px top bar, red tab dots and a red status-bar badge.
- On prod, any statement not classified `Read` needs a confirmation dialog showing the SQL and connection name (Enter confirms, Esc cancels).
- On every env, `UPDATE`/`DELETE` without `WHERE` needs confirmation.
- Read-only connections set the session read-only; violations show a clear message.
- **Agent activity** panel: recent CLI/MCP queries from `audit` (polled every 2 s), with connection, tool, SQL, decision, rows and duration; click opens the SQL in a new tab.

### 11.9 Settings and look

- Settings: theme, fonts, fetch size, row cap, blank-line delimiter, statement timeout, prod confirmations, agent defaults, show system objects, **Install CLI to PATH**, **Copy MCP config** (JSON snippet with the absolute path of `strata` and `args: ["mcp"]`).
- System UI font; editor/grid font stack `"JetBrains Mono", "Cascadia Code", Menlo, Consolas, monospace`. No web fonts (offline). Light/dark through CSS variables, following the OS unless overridden.

### 11.10 Design system (shadcn/ui)

shadcn/ui is the only component source, and every surface (app chrome, CodeMirror, Glide grid) reads the same CSS variables, so Strata looks like one product in light and dark.

- **Setup:** `bunx --bun shadcn@latest init` for Vite with CSS variables, neutral base color, `components.json` committed. Add only what the app uses: button, input, textarea, label, select, checkbox, switch, radio-group, toggle-group, tabs, dialog, alert-dialog, sheet, popover, dropdown-menu, context-menu, command, tooltip, badge, separator, scroll-area, resizable, skeleton, sonner, kbd.
- **Tokens:** `styles/tokens.css` defines the light and dark palettes, typography, spacing, and Strata's environment, editor, and grid roles. `styles/globals.css` maps those values to Tailwind and shadcn utilities. See [the design system](DESIGN.md) for the complete palette and usage.
- **Density:** desktop-compact. Text 13 px (12 px secondary), toolbar controls 28 px high, dialog controls 32 px, 4 px spacing grid, `--radius` 6 px, lucide icons 16 px at stroke 1.75. Set these once as shadcn component variants (for example `size="sm"` as default), never per call site.
- **Rules:**
  - No raw colors (hex, rgb, oklch) or arbitrary Tailwind values in feature code; only token-backed utilities. `./x check` greps `features/` and fails on violations.
  - Feature code imports from `components/ui` and `components/` only; primitive libraries are imported nowhere else.
  - One pattern per job: destructive confirmations use `AlertDialog`, transient feedback uses `sonner`, loading uses `Skeleton`, empty states use the shared `EmptyState`, menus show shortcuts with `Kbd`.
  - Every interactive element is keyboard reachable with a visible `--ring` focus outline; icon-only buttons have a tooltip naming the action and its shortcut.
  - Every screen is checked in light and dark before a UI milestone closes.
- **Non-shadcn surfaces:** `theme/glide.ts` builds Glide's `Theme` from computed CSS variables and rebuilds it on theme change; `theme/codemirror.ts` builds `EditorView.theme` and a `HighlightStyle` from the same tokens. Env colors drive the prod top bar, tab dots and status badge.
- **`docs/DESIGN.md`:** token table, component inventory, patterns with do/don't examples, and light/dark screenshots of the main screens taken in browser mode.

## 12. IPC contract (Tauri ↔ frontend)

Commands are thin async wrappers over `Core`; query results stream through a `tauri::ipc::Channel`. Every DTO derives `Serialize` + `ts_rs::TS`, bindings are generated into `src/ipc/bindings/` and committed, and every command returns `Result<T, CoreErrorDto>`.

| Group | Commands |
| --- | --- |
| Connections | `list_connections`, `save_connection(profile, secret?)`, `delete_connection(id)`, `test_connection(profile, secret?)`, `parse_connection_url(url)` |
| Sessions | `open_session(conn_id, database?)`, `close_session`, `set_session_database`, `set_tx_mode(auto \| manual)`, `commit`, `rollback`, `session_info` |
| Query | `run(session_id, text, target, mode, channel)`, `fetch_more(cursor_id, n)`, `fetch_all(cursor_id)`, `cancel(run_id)`, `close_cursor(cursor_id)`, `get_cell(cursor_id, row, col)`, `explain(session_id, text, offset)`, `split(text, dialect)` |
| Metadata | `list_databases`, `list_schemas`, `list_objects(conn, db, schema, kinds)`, `table_detail(conn, ref)`, `object_ddl(conn, ref)`, `resolve_at(session_id, text, offset)`, `completion_schema(conn, db)`, `refresh_metadata(conn, scope)`, `open_table_data(conn, ref, where?, order_by?, channel)` |
| Store | `history_list(filter)`, `audit_list(since)`, `workspace_load`, `workspace_save`, `settings_get`, `settings_set`, `read_sql_file(path)`, `write_sql_file(path, text)` |
| CLI/MCP | `install_cli()`, `mcp_config_snippet()` |

`target` is `{ cursor: offset }` or `{ selection: [from, to] }` (UTF-16); `mode` is `statement` or `script`.

```ts
type RunEvent =
  | { type: "statementStart"; index: number; span: [number, number] }
  | { type: "resultStart"; cursorId: string; resultIndex: number; columns: ColumnMeta[] }
  | { type: "rows"; cursorId: string; rows: Cell[][] }          // batches of ≤ 500
  | { type: "resultPaused"; cursorId: string; fetched: number }  // more available
  | { type: "resultEnd"; cursorId: string; fetched: number }
  | { type: "affected"; statementIndex: number; rows: number }
  | { type: "message"; level: "info" | "notice" | "warning"; text: string }
  | { type: "error"; statementIndex: number; error: CoreErrorDto }
  | { type: "done"; elapsedMs: number; statements: number };

type Cell = null | boolean | number | string;
```

- `fetch_more` returns `{ rows, exhausted }` directly; the channel is for the initial run.
- Global events via `emit`: `config-changed`, `session-state` (connected, disconnected, transaction open), `audit-appended`.
- Tauri capabilities allow only the plugins in use; no generic shell or filesystem access from the webview.

### 12.1 Transports: Tauri and browser mode

The frontend never calls Tauri directly; `ipc/client.ts` exposes the commands above and picks a transport at startup, so the same UI runs in the native app and in a plain browser during Docker development.

- **Shared handlers:** each command is one async method on `AppService` in `strata-app` (DTO in, DTO out). `src-tauri/commands.rs` wraps each in `#[tauri::command]`; `strata-devserver` exposes the same set over HTTP. Neither wrapper contains logic.
- **Tauri transport:** `invoke` + `Channel`, used when `window.__TAURI_INTERNALS__` exists.
- **Dev transport:** `POST /invoke/<command>` with JSON, plus one WebSocket at `/ws` carrying channel messages tagged by channel id. Same DTOs, same `RunEvent` stream.
- **Dev safety:** the devserver is never bundled, starts only with `STRATA_DEV=1`, requires a shared token (compose env → `VITE_STRATA_DEV_TOKEN`), allows CORS only from `http://localhost:5173`, and its port is bound to `127.0.0.1` on the host.
- **Graceful gaps in browser mode:** file dialogs become the browser file picker and downloads; secrets use `env:` or the in-memory mock; window state and single-instance are skipped.

## 13. CLI (`strata`)

One binary for humans, scripts and agents that shell out, using the same config, keychain, history and audit as the app. Connections are created and edited in the app in V1; the CLI reads them by name.

```text
strata conn list [--json]
strata conn test <conn>
strata ls <conn> [<schema>] [--kind table|view|mview|function|procedure|sequence] [--db <name>] [--json]
strata describe <conn> <object> [--json]          # columns, keys, indexes, comments
strata ddl <conn> <object>
strata query <conn> [<sql> | -f <file> | -] [--db <name>] [--format table|json|csv|tsv|md]
             [--limit <n>] [--timeout <s>] [--write] [--confirm-prod <conn>]
strata history [--conn <conn>] [--limit <n>] [--json]
strata mcp [--only <conn,conn>] [--max-rows <n>] [--timeout <s>]
```

- `query` runs statements read-only unless `--write` is passed. On a prod connection, writes also need `--confirm-prod <conn>` with the exact name. `read_only = true` connections refuse writes always.
- Defaults: `--limit 1000` (the result says when it was truncated), `--timeout 30`, table format on a TTY and JSON when piped.
- JSON shape: `{"columns":[{"name","type","kind"}],"rows":[[…]],"row_count":200,"truncated":true,"elapsed_ms":42}`; multiple statements return an array of these.
- Table format truncates cells to 60 chars; JSON/CSV never truncate below the row limit.
- Exit codes: 0 ok, 1 database error, 2 usage, 3 connection/auth, 4 blocked by safety, 130 cancelled (Ctrl+C sends a real cancel first).
- Every run is written to `history` and `audit` with source `cli`.

## 14. MCP server and agent safety (`strata mcp`)

`strata mcp` is an `rmcp` stdio server named `strata`. Agents see connections by name only, read-only by default, with every call audited. Its `instructions` string tells the agent which tools exist, that results are row-limited, and that writes are denied unless the connection allows them.

### 14.1 Tools

| Tool | Input | Output |
| --- | --- | --- |
| `list_connections` | none | name, kind, env, agent\_access, default database (only connections with `agent_access` ≠ `none`, filtered by `--only`) |
| `list_schemas` | connection, database? | schema names |
| `list_objects` | connection, schema, database?, kinds?, name\_filter? | name, kind, rows estimate, comment (max 500, `truncated` flag) |
| `search_objects` | connection, query | fuzzy matches across all schemas from the metadata cache |
| `describe_table` | connection, object | columns, PK, FKs in/out, indexes, comments, rows estimate |
| `get_ddl` | connection, object | DDL text |
| `run_query` | connection, sql, database?, max\_rows?, timeout\_s? | columns, rows, row\_count, truncated, elapsed\_ms |
| `explain_query` | connection, sql | plan text |
| `run_write` | connection, sql, database?, dry\_run? | affected rows; `dry_run` executes in a transaction and rolls back |

Results are compact JSON (column list once, rows as arrays), also returned as `structuredContent` where the SDK supports it. Cells longer than 4,000 chars are truncated with a marker to protect the agent's context.

### 14.2 Guard layers for `run_query` (all must pass)

1. Connection is visible to agents (`agent_access` ≠ `none`, within `--only`).
2. Exactly one statement (splitter); scripts are rejected.
3. Classifier says `Read`. `Write`, `Ddl`, `TxControl`, `Session`, `Procedural` and `Unknown` are denied (fail closed) with the reason.
4. Database-level enforcement:
   - PostgreSQL: `BEGIN TRANSACTION READ ONLY` + `SET LOCAL statement_timeout`, run, `ROLLBACK`.
   - SQL Server: `SET XACT_ABORT ON; SET LOCK_TIMEOUT …; BEGIN TRAN`, run, `ROLLBACK TRAN`.
   - Oracle: `SET TRANSACTION READ ONLY`, run, `ROLLBACK`.
5. Row limit through the cursor (fetch `max_rows + 1`, never rewrite SQL); default 200, hard max from settings.
6. Timeout triggers a real cancel.
7. Audit row written for every call, allowed or denied, with the MCP client name.

### 14.3 `run_write` policy

- Registered only when at least one visible connection has `agent_access = "write"`; rejected on any `env = "prod"` connection in V1, whatever the setting.
- Single statement; `Ddl` needs `agent_access = "write"` plus `allow_agent_ddl = true` on the connection.
- Denials explain the way forward: "ask the user to run it in Strata, or enable write access for this connection".

### 14.4 Docs to ship

- README section with `claude mcp add strata -- <path>/strata mcp` and the JSON `mcpServers` snippet for other clients.
- Recommendation: for prod, connect with a database user that only has read grants. Strata's guard is defense in depth, not a replacement for permissions.

## 15. Testing strategy

"Works fine" means proven against real databases: every driver feature has an integration test against a container, and the SQL utilities carry the largest unit suite in the repo.

- **`strata-sql` unit + snapshot tests (≥ 150 cases):** dollar quotes, nested comments, `q'[…]'`, `GO` inside strings, PL/SQL with blank lines and inner `;`, `BEGIN ATOMIC`, data-modifying CTEs, `SELECT … INTO`, unterminated strings, and UTF-16 offsets with `ñ`, `á` and emoji.
- **Type zoo per database:** a seeded `type_zoo` table with every supported type and edge values (NULLs, `numeric(38,10)` max, int8 extremes, timestamptz, intervals, arrays, json, bytea, uuid, `NVARCHAR` with emoji, `MONEY`, `DATETIMEOFFSET`, Oracle `DATE` with time, `LONG`, CLOB > 1 MB, BLOB). Snapshot the rendered cells.
- **Integration (`./x test-int`, inside the compose network with `STRATA_IT=1`):** services `postgres`, `mssql`, `oracle`, plus `oracle11` under `--profile legacy`. Seed scripts create schemas with FKs, views, a synonym, a function, and a 1M-row table.
- **Integration cases:** connect + TLS modes; stream 1M rows with pause/resume (memory stays flat); cancel within 2 s on `pg_sleep(30)` / `WAITFOR DELAY '00:00:30'` / `DBMS_SESSION.SLEEP(30)` (`DBMS_LOCK.SLEEP` on 11g); multiple result sets; error positions; introspection snapshots; resolution through search path, default schema, synonyms and aliases.
- **Guard bypass suite (must all be denied or rolled back):** plain `UPDATE`; `WITH d AS (DELETE … RETURNING *) SELECT * FROM d`; `SELECT … INTO`; `COMMIT; DELETE …` (two statements); `SET default_transaction_read_only = off`; Oracle `CREATE TABLE` (implicit commit); SQL Server `EXEC('DELETE …')`; a PostgreSQL function that writes, called from `SELECT`.
- **MCP:** tests spawn `strata mcp` with a temp `STRATA_HOME` through an `rmcp` client: tool list, `run_query`, denials, row limits, audit rows.
- **Bridge:** Go unit tests for the protocol; Rust test kills the bridge mid-query and checks the error and recovery.
- **Frontend:** `vp test` (Vitest) for stores, the Ctrl+Click decoration logic, keymap and both IPC transports with mocks. The manual `docs/SMOKE.md` checklist runs in browser mode (`./x up`) at every UI milestone, and in the native app from a Docker-built installer at M8.
- **Design check:** the raw-color grep in `./x check`, plus light/dark screenshots refreshed in `DESIGN.md` at each UI milestone.
- **Performance script:** measures startup time, time to first batch and memory on the 1M-row query; results go into `PROGRESS.md`.

## 16. Milestones

Nine milestones, in order; each ends green and with its acceptance list checked in `PROGRESS.md`. PostgreSQL goes end-to-end first so every later driver lands in a working app.

1. **M0 — Scaffold and dev environment.** Dev image, compose file with healthchecks and seeds, `x`/`x.ps1`, `justfile`, Cargo workspace with empty crates (incl. `strata-app` and `strata-devserver`), Vite+ app on Bun, shadcn init with the Strata tokens and a `DESIGN.md` skeleton, Tauri window with the empty layout, devserver skeleton with the dev transport, CI running `just ci` in the image.
   - Accept: on a machine with only Docker and git, `./x up` shows the empty layout at `localhost:5173` in light and dark; `./x check` green; `./x bundle-linux` and `./x bundle-windows` produce installers that open the empty window.
2. **M1 — Core, store, PostgreSQL, CLI.** Traits, `Core`, cursors, value model, `strata-store` (config, keychain, history), `strata-sql` (lexer, splitter, classifier), PostgreSQL driver incl. introspection, CLI `conn`, `ls`, `describe`, `ddl`, `query`.
   - Accept: `strata query` streams the 1M-row table with `--limit`; type zoo snapshot and cancel test pass; splitter suite green.
3. **M2 — Desktop shell.** Connection dialog, sessions, CodeMirror editor with run at cursor and script, streaming grid via Channel and the dev WebSocket, fetch more, Messages, Stop, status bar, workspace autosave, all built from shadcn components.
   - Accept: first rows on screen < 100 ms after the server returns; smooth scroll over 100k rows; Stop works; restart restores tabs and text; every flow behaves the same in browser mode and the native window.
4. **M3 — Explorer, metadata, autocomplete.** Virtualized tree, metadata cache, schema-aware completion, command palette, refresh after DDL, history panel.
   - Accept: completion offers columns after `u.` for `FROM users u`; expanding a 2,000-table schema takes < 300 ms.
5. **M4 — Ctrl+Click, table view, Schema tab.** `resolve_at` with aliases, hover decoration, Alt+Click multi-cursor, table view sections, Schema tab with FK navigation, F4, value viewer, Copy as, Format SQL, Explain.
   - Accept: Ctrl+Click works on plain, qualified, quoted and aliased names; Ctrl+Shift+Click opens a Schema tab; FK links navigate both ways.
6. **M5 — SQL Server.** Full parity: batches and `GO`, multiple results, introspection, resolution, cancel strategy, Windows auth on Windows.
   - Accept: type zoo and integration suite green on SQL Server 2022; every M2–M4 flow works unchanged.
7. **M6 — Oracle bridge.** Go bridge, Rust client and supervisor, introspection, synonyms, PL/SQL rules, DBMS\_OUTPUT, `externalBin` bundling for all targets.
   - Accept: suite green on 23ai Free and 11g XE; killing the bridge mid-query recovers cleanly; works on a machine with no Oracle software installed.
8. **M7 — MCP, guard, audit.** `strata mcp` and all tools, guard layers, audit log, Agent activity panel, Install CLI and Copy MCP config.
   - Accept: bypass suite fully denied; Claude Code lists connections, describes a table and runs a query through MCP.
9. **M8 — Safety, polish, packaging.** Prod confirmations, env colors, read-only connections, manual transaction mode, settings, budget measurements, installers for Windows/macOS/Linux, design pass against section 11.10, README.
   - Accept: every item in section 17.

## 17. V1 definition of done

V1 ships when every box below is true on a clean Windows machine with no database software installed.

- [ ] One installer gives the app, the `strata` CLI and `oracle-bridge`; nothing else needs installing.
- [ ] Connect, browse, query and Ctrl+Click work on PostgreSQL, SQL Server and Oracle (11g and 23ai).
- [ ] Large results stream with pause/resume; Stop cancels within 2 s on all three databases.
- [ ] Every budget in section 3 is met and recorded in `PROGRESS.md`.
- [ ] Prod confirmations, WHERE-less UPDATE/DELETE warning and read-only connections behave as specified.
- [ ] `strata mcp` works from Claude Code; the guard bypass suite is fully denied; every agent call is audited and visible in the app.
- [ ] No secret appears in config, logs, history, audit or MCP output (grep test in CI).
- [ ] `cargo tree -i openssl` is empty; all checks and integration suites green in CI.
- [ ] A fresh clone on a machine with only Docker and git passes `./x up`, `./x check`, `./x test-int`, `./x bundle-linux` and `./x bundle-windows`.
- [ ] The UI follows section 11.10: no raw colors in feature code, light/dark parity, `DESIGN.md` current.
- [ ] README covers install, the Docker dev workflow, connections, shortcuts, CLI, MCP setup and the read-only-user recommendation.

## 18. V2 roadmap (do not build in V1)

V2 adds export, cell editing, ER diagrams and a visual query builder, in that order: the builder reuses the diagram's components. V1 must leave the hooks listed under each feature in place.

### 18.1 Export data

- Formats: CSV, TSV, JSON (array and NDJSON), Excel via `rust_xlsxwriter` (pure Rust), SQL `INSERT` (dialect-aware), Markdown.
- Sources: a query (re-run in export mode, streaming straight to disk, ignoring the in-memory row cap), a whole table, or a grid selection.
- Options: delimiter, quoting, header, NULL text, date format, UTF-8 with optional BOM for Excel. Progress events and cancel.
- CLI: `strata export <conn> <sql | table> --format csv -o out.csv`.
- **V1 hook:** `Core` can run a statement into any `RowSink`, not only a cursor; cells are already lossless text.

### 18.2 Cell editing

- Editable when results map to one table with a PK or unique key: always in the table view's Data section; in editor results only for single-table `SELECT`s that include the key columns.
- Glide inline editors by kind (text, number, bool, date; JSON via the value viewer); add, duplicate and delete rows; changed cells highlighted.
- Save builds **parameterized** `UPDATE`/`INSERT`/`DELETE`, shows the SQL preview, runs everything in one transaction and rolls back on any error. Ctrl+S saves, Esc reverts. Prod adds a confirmation with the preview.
- **V1 hooks:** `ColumnMeta` keeps table/column origin when the driver knows it (PostgreSQL `prepare` gives table OID + attnum); cursors keep original values; the `DbConnection` trait has room for `execute_with_params`.

### 18.3 ER diagrams

- A Diagram view in the Schema tab: tables as nodes with columns and PK/FK markers, FK edges, pan and zoom.
- `@xyflow/react` for rendering and `elkjs` (layered) for auto-layout. Scope: a table plus N hops, or a whole schema (warn above 150 tables).
- Click a node to open its table view; save layouts per connection in `strata.db`; export PNG and SVG.
- **V1 hook:** a `fk_graph(conn, schema)` API on the metadata cache, already used by References and the Schema tab neighbors list.

### 18.4 Visual query builder

- Canvas built on the diagram components: drag tables from the explorer, auto-joins from FKs (join type editable), column checkboxes, filters, sort, group/aggregate, limit.
- Generates dialect-correct SQL into the editor, one-way in V2 (SQL → canvas sync later with `sqlparser`); live SQL preview.
- **V1 hook:** `strata-sql::dialect` owns identifier quoting and limit/offset rendering per dialect.

## 19. Later backlog (candidates, not committed)

Ideas to keep out of V1 and V2 unless the owner promotes them; record them here instead of building them.

- SSH tunnels per connection with `russh` (pure Rust), key or password auth.
- Swap `oracle-bridge` for a pure-Rust driver once ADR 0001's exit criterion is met.
- Local socket API so agents can reuse open app sessions and see the active tab's SQL.
- Query parameters (`:name`, `@name`) with a prompt dialog and remembered values.
- Saved queries and snippets per connection; customizable keymap.
- Result compare (two results side by side, diff highlighting).
- More engines: MySQL/MariaDB and SQLite, through the same `Driver` trait.
