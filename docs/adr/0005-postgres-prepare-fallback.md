# Preserve the single-statement boundary in PostgreSQL

PostgreSQL's extended protocol uses SQLSTATE `42601` for syntax failures, including inputs that contain multiple commands. Strata returns that error, statement cancellations, and failed-transaction errors directly. Other PostgreSQL preparation errors may use the text protocol with unknown column types, preserving access to commands that the server can only run through that protocol.
