import type { Database } from "bun:sqlite";
import { tableColumns } from "./schema";

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

/** Ledger v23: sticky backfill completion that sync cannot overwrite. */
export function applyCheckpointBackfillCompleteV23(db: Database): void {
  if (tableColumns(db, "checkpoints").includes("backfill_complete")) return;
  db.exec(`
    ALTER TABLE checkpoints
      ADD COLUMN backfill_complete INTEGER NOT NULL DEFAULT 0
      CHECK (backfill_complete IN (0, 1));
  `);
}

/** Ledger v25: independent backfill and sync resume tokens. */
export function applyCheckpointModeCursorsV25(db: Database): void {
  if (tableColumns(db, "checkpoints").includes("backfill_cursor")) return;
  db.exec(`
    ALTER TABLE checkpoints ADD COLUMN backfill_cursor TEXT;
    ALTER TABLE checkpoints ADD COLUMN sync_cursor TEXT;
    UPDATE checkpoints SET
      backfill_cursor = (
        SELECT r.committed_cursor FROM connection_runs r
         WHERE r.connector_id = checkpoints.connector_id
           AND r.source_key = checkpoints.source_key
           AND r.mode = 'backfill' AND r.status = 'ok'
         ORDER BY r.finished_at DESC, r.run_id DESC
         LIMIT 1
      ),
      sync_cursor = (
        SELECT r.committed_cursor FROM connection_runs r
         WHERE r.connector_id = checkpoints.connector_id
           AND r.source_key = checkpoints.source_key
           AND r.mode = 'sync' AND r.status = 'ok'
         ORDER BY r.finished_at DESC, r.run_id DESC
         LIMIT 1
      );
  `);
}
