# Strata

Strata is a desktop database client for PostgreSQL, SQL Server, and Oracle. It includes saved connections, per-tab sessions, a SQL editor, streamed results, catalog inspection, and an MCP server.

## Docker development

Use Docker with Compose and Git. Run these commands from the repository root.

```sh
./x up
./x check
./x test-int
```

Open [localhost:5173](http://localhost:5173) for the browser workspace. The first run creates a private `.env`, builds the development image, and seeds the local databases. Keep `.env` alongside its Docker volumes so subsequent runs use the original fixture credentials. `./x down` stops Strata's containers and preserves these volumes. `./x rebuild` rebuilds the tooling image after changes to `dev/Dockerfile`.

In the browser, choose a local fixture in **New connection**, test it, and save it. PostgreSQL uses a database name, SQL Server uses a database or named instance, and Oracle uses a service, SID, or descriptor. Strata opens an editor tab. **Run** executes the statement at the caret, and **Run script** executes the editor or selection in order. The grid fetches more rows near the end of the loaded results. **Fetch all** reads up to the configured row cap. Open **Messages** for notices, affected rows, and errors.

Strata saves scratch tabs and editor text every two seconds while the workspace has changes. Connections and workspace data in browser mode live in the Compose state volume. Native Strata uses its platform data directories and supports password prompts, environment variables, and the OS keychain.

On Windows, run `.\x.ps1 up` with Docker Desktop. Keep the clone in the WSL2 filesystem for faster bind mounts. When the repository is on the Windows filesystem, set `STRATA_WATCH_POLL=1`. For a native development window, use `./x gui` from Linux with X11/XWayland or from WSLg.

| Service | Local address | Fixture |
| --- | --- | --- |
| PostgreSQL 17 | `127.0.0.1:15432` | Database `pagila`, user `postgres` |
| SQL Server 2022 Developer | `127.0.0.1:11433` | Database `AdventureWorksLT2022`, user `sa` |
| Oracle Free | `127.0.0.1:11521` | Service `FREEPDB1`, user `hr` |
| Oracle XE 11g | `127.0.0.1:11522` | Service `XE`, user `hr` |

Set `COMPOSE_PROFILES=legacy` to include Oracle 11g. Use Oracle fixture passwords of at most 30 bytes when customizing credentials for that profile. Each engine includes a public sample schema, a type zoo, and one million synthetic records. Provenance and licenses are recorded in [dev/seed/README.md](dev/seed/README.md).

## Working with SQL

Use Ctrl+Enter for the current statement, Ctrl+Shift+Enter or Alt+X for the script, and Ctrl+. to stop. On macOS, Cmd replaces Ctrl. Ctrl+Click opens a pinned table inspector. Ctrl+Shift+Click opens a dedicated Schema tab. Ctrl+K opens the catalog palette. Ctrl+O opens a SQL file in a scratch tab and Ctrl+S saves a copy.

Session controls let you choose auto-commit or enter manual mode. Strata prompts before closing a tab or native window with an open manual transaction. Read-only profiles reject writes and production profiles ask before potentially mutating statements. Settings persist in `config.toml`.

## Desktop bundles

Use `./x bundle-linux` for the AppImage and Debian package, or `./x bundle-windows` for the Windows x64 NSIS installer. Bundles are copied to `artifacts/`. The Bundles workflow also builds the macOS arm64 disk image on a macOS runner. Each installer includes the Oracle sidecar. Both Linux bundles use system GTK 3 and WebKitGTK 4.1. The Debian package declares these dependencies. Install them on the host before running the AppImage.

Windows bundles are unsigned and may show a SmartScreen prompt. `embedBootstrapper` assumes a supported Windows installation with WebView2 Evergreen already present for offline installation. If the runtime is missing, the bootstrapper downloads it. [WebView2 installation decision](docs/adr/0003-webview2-bootstrapper.md)

macOS bundles use ad-hoc signing. After verifying that the bundle came from Lummina, users who encounter a Gatekeeper quarantine prompt can remove the quarantine attribute with `xattr -dr com.apple.quarantine /Applications/Strata.app`.

## MCP setup

Set **Agent access** to **Read** on a connection that an MCP client may use. Use an OS keychain entry or an environment variable for the password. Use a database account with read privileges for production.

Choose **Copy MCP config** in the native window, or register the installed binary with your client.

```sh
claude mcp add strata -- /path/to/strata mcp
codex mcp add strata -- /path/to/strata mcp
```

Example configuration for a client that accepts `mcpServers`:

```json
{
  "mcpServers": {
    "strata": {
      "command": "/path/to/strata",
      "args": ["mcp", "--only", "Analytics"]
    }
  }
}
```

**Agent activity** shows tool calls and decisions. Reads accept one classified statement, restrict callable routines, and enforce a row limit and timeout. **Read and write** enables writes for a non-production profile. Each tool call creates an audit record.

See [the progress log](docs/PROGRESS.md) for the acceptance checklist and [the smoke checklist](docs/SMOKE.md) for verification steps.
