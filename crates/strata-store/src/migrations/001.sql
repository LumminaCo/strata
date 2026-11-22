CREATE TABLE history (
    id INTEGER PRIMARY KEY,
    conn_id TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('ui', 'cli', 'mcp')),
    sql TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL,
    rows INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('ok', 'error', 'cancelled')),
    error TEXT
);
CREATE INDEX history_recent ON history (conn_id, started_at DESC, id DESC);

CREATE TABLE audit (
    id INTEGER PRIMARY KEY,
    ts INTEGER NOT NULL,
    source TEXT NOT NULL,
    client_name TEXT,
    conn_name TEXT NOT NULL,
    tool TEXT NOT NULL,
    sql TEXT,
    class TEXT,
    decision TEXT NOT NULL,
    reason TEXT,
    rows INTEGER,
    duration_ms INTEGER
);

CREATE TABLE workspace (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    payload TEXT NOT NULL
);

CREATE TABLE metadata_cache (
    conn_id TEXT NOT NULL,
    database_name TEXT NOT NULL,
    schema_name TEXT NOT NULL,
    payload TEXT NOT NULL,
    fetched_at INTEGER NOT NULL,
    PRIMARY KEY (conn_id, database_name, schema_name)
);
