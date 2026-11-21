# 0002. Keep MCP and omit the query CLI in V1

Accepted by the project owner.

V1 ships the desktop client and the `strata mcp` stdio entry point. The human-facing connection, inspection, query and history subcommands and the Install CLI to PATH command are outside V1. The executable may report its version for installer smoke tests. M1 verifies PostgreSQL through Rust integration tests. M7 adds MCP mode and validates the entry point with an MCP client.

An agent-visible connection with `secret = "prompt"` appears as unavailable in MCP. Calls against it receive guidance to switch to keychain or an `env:` reference. Audit each denial.
