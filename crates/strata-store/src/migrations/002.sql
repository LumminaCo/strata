CREATE INDEX IF NOT EXISTS history_all_recent ON history (started_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS saved_queries (
    id TEXT PRIMARY KEY,
    conn_id TEXT,
    title TEXT NOT NULL,
    sql TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS saved_queries_recent ON saved_queries (updated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS saved_queries_conn_recent ON saved_queries (conn_id, updated_at DESC, id DESC);
