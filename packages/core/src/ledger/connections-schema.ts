import type { Database } from "bun:sqlite";

/** Ledger v8: connection identity, unique source keys, append-only run history. */
export function applyConnectionsV8(db: Database): void {
  db.exec(`
    ALTER TABLE connections
      ADD COLUMN implementation_version TEXT NOT NULL DEFAULT '';
    CREATE UNIQUE INDEX IF NOT EXISTS connections_source_key_uidx
      ON connections(source_key);
    CREATE TABLE connection_runs (
      run_id TEXT PRIMARY KEY,
      connector_id TEXT NOT NULL,
      source_key TEXT NOT NULL,
      mode TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT NOT NULL,
      previous_cursor TEXT,
      attempted_cursor TEXT,
      committed_cursor TEXT,
      stored INTEGER NOT NULL,
      duplicates INTEGER NOT NULL,
      errors TEXT NOT NULL,
      status TEXT NOT NULL,
      FOREIGN KEY (connector_id, source_key)
        REFERENCES connections(connector_id, source_key)
    ) STRICT;
    CREATE INDEX connection_runs_source_finished
      ON connection_runs(connector_id, source_key, finished_at);
  `);
}
