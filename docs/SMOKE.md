# Strata smoke checklist

## Browser and Linux desktop

1. Start the fixtures with `./x up` and open `http://localhost:5173`. Create a connection with **Use local PostgreSQL**. Test it and save it.
2. In a native install on the host, create a PostgreSQL connection for `127.0.0.1:15432`, database `pagila`, and user `postgres`. Use the fixture password from `.env`. When running the native window with `./x gui`, use `postgres:5432`. The Docker GUI has separate persistent workspace data.
3. Enter two statements separated by a semicolon. Use **Run** with the caret in the second statement, then use **Run script** to verify both result tabs.
4. Run `SELECT pg_sleep(30);` and click **Stop**. Verify the cancellation in **Messages** and run another query in the same session.
5. Run `SELECT i FROM generate_series(1, 100000) AS i;`. Use **Fetch more** or scroll near the end of the first page, then use **Fetch all** and scroll to the last row.
6. Create a second tab on the same profile, enter SQL, and leave it active for at least two seconds. Restart the app or reload the browser page and check both tabs and the active editor text.
7. Use Tab to focus the theme control and Space to switch themes. Verify the connection dialog, SQL syntax, grid, and status bar in light and dark.
8. Run `./x check` and `./x test-int`. Use `COMPOSE_PROFILES=legacy ./x test-int` to include Oracle XE 11g.

Use Ctrl+Enter to run a statement, Ctrl+Shift+Enter to run a statement in a new result tab, Alt+X for a script, and Ctrl+. to stop. On macOS, Cmd works in place of Ctrl. In browser mode, use Alt+T for a new tab, Alt+W to close it, and Alt+] or Alt+[ to switch tabs.

## Desktop bundles

1. On Linux, run `./x bundle-linux`. Open both the Debian package and the AppImage and connect to the local PostgreSQL fixture. With Xvfb and xdotool installed, run `xvfb-run -a python3 dev/measure-linux.py /absolute/path/to/strata` to record time to a visible window and session-free memory.
2. Run `./x bundle-windows` and install the NSIS executable on Windows x64. Confirm that Strata opens and registers as an MCP server. The Bundles workflow checks silent installation, startup, the installed Oracle bridge, and MCP initialization.
3. On macOS arm64, mount the DMG from the Bundles workflow, copy Strata to Applications, and open it. Follow the connection and query checks above. The workflow mounts the disk image and verifies the executables.
4. In Settings, set the initial fetch size and row cap, then reconnect and query past the cap. Confirm the limits and restore the original settings. Open and download a SQL file and compare its contents.
5. On a disposable test database, submit an `UPDATE` with a `WHERE` clause on a Production profile and an `UPDATE` without a `WHERE` clause on a Development profile. Verify and cancel each prompt. On a read-only profile, confirm that the first statement is rejected and a `SELECT` succeeds. In manual mode, run a query, roll back, run it again, and commit. Start another transaction and try closing the tab and the desktop window. Cancel once and confirm the transaction remains open, then choose **Roll back and close**.
6. Follow [MCP setup](../README.md#mcp-setup) and use Claude Code to list connections, describe a table, and run a read. Check allowed and denied calls in **Agent activity**. Use the [V1 definition of done](SPEC.md#17-v1-definition-of-done) for interactive Windows acceptance.

## Desktop performance

Run `python dev/benchmark-desktop.py /absolute/path/to/strata --pg-bin /path/to/postgresql/bin` with Python 3 and `psutil==7.2.2` on an idle desktop. The probe starts a disposable PostgreSQL instance bound to localhost, restores a saved editor in each fresh app process, and opens one read-only session. Linux can run under Xvfb. The Bundles workflow records Windows and macOS samples as JSON Lines artifacts.

The startup sample includes launch, editor focus, and two animation frames. First-row latency uses PostgreSQL's clock on the same host and records the first canvas draw. The scroll probe traverses 100,000 fetched rows and reports frame intervals. Memory includes Strata and the webview, using unique working set on Windows, physical footprint on macOS, and summed RSS on Linux. Run macOS measurements on an idle desktop so newly launched WebKit processes can be attributed to Strata.
