# 0006. Decouple headless `strata` CLI and MCP server from the desktop app

Accepted by the project owner. Supersedes the single-binary aspect of [ADR 0002](0002-mcp-without-query-cli.md).

## Context

In V1, `strata mcp` ran as a subcommand inside the Tauri desktop executable (`strata`). While the MCP server did not require the GUI to stay running at runtime, bundling it into the GUI binary coupled MCP to Tauri, WebView/GTK runtime libraries, Windows GUI-subsystem behavior, updater process locks, and ephemeral Linux AppImage mount paths.

## Decision

1. **Separate executables:** Rename the Tauri desktop binary to `strata-desktop` (preserving the `Strata` product name, window title, and bundle names) and introduce a dedicated headless console crate `strata-cli` producing the `strata` binary (`strata mcp [--only ...]`, `strata --version`, `strata --help`).
2. **Headless runtime layer:** Extract `Engine`, `Metadata`, `CatalogScope`, `CatalogSnapshot`, and `WireCell` into `crates/strata-engine` so `strata-mcp` and `strata-cli` depend only on headless crates, never on the desktop UI command crate (`strata-app`).
3. **Bundled + stable install path:** Bundle `strata` as an `externalBin` alongside `oracle-bridge` in every desktop installer. Provide an **Install CLI** action (and automatic copy refresh on desktop startup after updates):
   - Debian `.deb` installs `/usr/bin/strata` directly on `PATH`.
   - macOS symlinks `~/.local/bin/strata` to `Strata.app/Contents/MacOS/strata`.
   - Linux AppImage copies `strata` and `oracle-bridge` into the user data directory (`<data_dir>/bin`) and symlinks `~/.local/bin/strata`, avoiding ephemeral `/tmp/.mount_*` paths.
   - Windows copies `strata.exe` and `oracle-bridge.exe` into `%LOCALAPPDATA%\Strata\bin` and adds it to the user `PATH`, decoupling active MCP processes from NSIS desktop updates.
4. **Sidecar discovery:** `strata-driver-oracle` canonicalizes `current_exe()` before resolving the sibling `oracle-bridge` binary so symlinked CLI installations always locate the Oracle bridge reliably.
