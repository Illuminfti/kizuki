import type { Database } from "bun:sqlite";

/**
 * Ledger migration 34. Two additive tables and one index; no existing row is
 * touched, so a re-run is a no-op and an interrupted run rolls back whole.
 *
 * `purge_erasures` records that a purge batch finished erasing the claim and
 * proposal payloads, archive copies and page images it is answerable for, so
 * `recover` can tell a finished batch from one interrupted after phase 1.
 *
 * `purge_suppression_lifts` records that the owner lifted the refusal of a
 * purged source record. The refusal itself is derived from the purge history
 * (`event_purges` and `event_purge_proofs`), which already survives backup and
 * restore; a restored vault therefore refuses again until the owner lifts it.
 */
export function applyPurgeReingestV34(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS purge_erasures (
      batch_id TEXT PRIMARY KEY,
      erased_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS purge_suppression_lifts (
      receipt_id TEXT PRIMARY KEY,
      lifted_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS event_purge_proofs_by_record ON event_purge_proofs(source_record_id);
  `);
}
