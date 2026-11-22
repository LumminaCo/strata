# M0 smoke checklist

## Browser workspace

1. Run `./x up` from a fresh clone with Docker and Git.
2. Open `http://localhost:5173` and verify Explorer, the empty editor region, Results, and the Ready status.
3. Use Tab to focus the theme button. Activate it with Space to check the light and dark themes. Reload and verify that the selected theme persists.
4. Run `./x check` and `./x test-int`. To include Oracle XE 11g, run `COMPOSE_PROFILES=legacy ./x test-int`.

Browser-only shortcuts planned for M2 are Alt+T for a new tab, Alt+W to close it, and Alt+] or Alt+[ to switch tabs. The native app uses the bindings in the spec.

## Desktop workspace

1. On Linux, run `./x bundle-linux`. Install the Debian bundle or launch the AppImage and confirm the Strata window opens with the same workspace and Ready status.
2. Run `./x bundle-windows` and install the generated NSIS executable on Windows x64. Confirm that the Strata window opens and includes the theme control. The Bundles workflow runs the silent installation and launch on a Windows runner.
3. M8 adds the clean Windows acceptance run and the performance measurements. The owner performs the interactive Windows acceptance. The automated installer smoke will also check `strata --version` and the MCP `initialize` response once those entry points are available.
