# Strata progress

## M0 · Scaffold and development environment

M0 passed local verification and hosted CI.

| Acceptance check | State |
| --- | --- |
| Browser workspace in light and dark | Passed against Docker-hosted Vite+ and Axum. Keyboard activation, theme persistence, and backend readiness passed. |
| `./x up` with all default services | Passed with Compose health checks and the browser smoke. |
| `./x check` | Passed in Docker, including Rust formatting, lint and tests, Go vet and tests, Vite+ type checks, and three transport tests. No OpenSSL or native-tls crates in the workspace. |
| `./x test-int` | Passed with the default and legacy profiles. PostgreSQL 17, SQL Server 2022, Oracle Free, and Oracle XE 11g each verified with public sample schemas and one million generated records. |
| Linux AppImage and Debian package build and launch | Passed. Both bundles opened the Strata window under Xvfb on Fedora x64. |
| Windows x64 NSIS build and launch | Cross-build passed. The 3.55 MiB installer contains the Strata x64 executable and WebView2 bootstrapper. Silent installation and native startup passed in the Bundles workflow. |

## Packaging notes

- The Linux M0 AppImage is 93.96 MiB and the Debian package is 2.49 MiB. The AppImage is above the 35 MB installer budget measured at M8.
- Windows cross-compilation uses NSIS 3.13. The Tauri installer template requires headers beyond the NSIS version packaged with Debian Bookworm.

## Decisions

- Use Strata for the project name and store the private repository under LumminaCo.
- Stop after each milestone for owner review. Use conventional commits and one pull request per milestone.
- Use Base UI with the shadcn Nova preset and system fonts. Reserve the browser-only tab shortcuts documented in SMOKE.md.
- Run Linux Docker checks and fixture smoke tests on branch pushes and pull requests. Run the cross-platform Bundles workflow for version tags and manual dispatch.
- Ship unsigned Windows installers and ad-hoc signed macOS arm64 bundles. The automated Windows smoke runs separately from the owner’s M8 acceptance on a Windows machine.
- Use Pagila, AdventureWorksLT, and Oracle HR with synthetic data for edge cases and large result sets.
- Publish fixture ports 15432, 11433, 11521, and 11522 on localhost to avoid collisions with other local projects. Use shared SELinux labels on the repository bind mount.
- Keep the agreed scope adjustments and development orchestration decisions in the ADRs.

## M1 · Core, storage, and PostgreSQL

The milestone passed local acceptance. The Rust engine opens saved PostgreSQL profiles, manages dedicated sessions and pull-based result cursors, and exposes separate catalog connections. The store supplies observed configuration updates and persistent query history. The database UI starts in M2. [CLI scope decision](adr/0002-mcp-without-query-cli.md)

| Acceptance check | State |
| --- | --- |
| `./x check` | Passed, including Clippy, the workspace tests, frontend checks, Go checks, and the Rust dependency guard. |
| SQL lexer, splitting, cursor spans, classifier | Passed 168 splitter variations and focused tests for UTF-16 positions, malformed input, batches, and statement classes. |
| PostgreSQL integration | Passed with the default and legacy Compose profiles. Seven Rust integration tests cover one million streamed rows, cursor pause and cap, cancel within two seconds, timeouts, manual transactions, value and DDL snapshots, metadata, and saved profile execution. |
| PostgreSQL TLS | Verified disabled, prefer, require, verify-ca, and verify-full against the fixture CA. Verified that verify-full rejects a mismatched hostname. |
| Store | Verified comment-preserving profile edits, last-good config after invalid external edits, redacted secrets, and SQLite history retention. The integration fixture uses an environment secret. |
| Windows x64 compatibility | `cargo xwin check --locked -p strata-app --target x86_64-pc-windows-msvc` passed. |

The PostgreSQL fixture generates its TLS identity at build time and shares its public CA with integration tests. The million-row test consumes the driver stream without retaining its rows, then verifies pause and resume through the capped core cursor. The Windows check builds the native credential backend. Native credential access requires an OS keychain session outside Docker.

## Next milestone

M2 begins after owner review. It connects the desktop shell and browser transport to the Rust engine for connection management, query editing, and result streaming.
