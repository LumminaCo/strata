# 0001. Ship a Go bridge for Oracle

Accepted for V1.

Use a small Go executable with the pure-Go go-ora driver. The Rust application spawns it lazily and exchanges newline-delimited JSON over standard I/O. This supports Oracle 11g and newer targets while avoiding Oracle Instant Client and other installer prerequisites. M0 reserves the module and build entry point. The protocol, driver and bundling ship in M6.

Replace the bridge when a pure-Rust driver passes the entire Oracle integration suite on stable Rust, including LONG columns and Oracle 11g and 19c.
