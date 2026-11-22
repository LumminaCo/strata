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

Use Ctrl+Enter to run a statement, Ctrl+Shift+Enter or Alt+X for a script, and Ctrl+. to stop. On macOS, Cmd works in place of Ctrl. In browser mode, use Alt+T for a new tab, Alt+W to close it, and Alt+] or Alt+[ to switch tabs.

## Desktop bundles

1. On Linux, run `./x bundle-linux`. Install the Debian package or launch the AppImage and confirm that Strata opens the PostgreSQL workspace.
2. Run `./x bundle-windows` and install the NSIS executable on Windows x64. Confirm that Strata opens and includes the theme control. The Bundles workflow runs the silent installation and launch on a Windows runner.
3. Use the M8 checklist in the spec for interactive Windows acceptance, installer budgets, and the MCP smoke once those entry points are available.
