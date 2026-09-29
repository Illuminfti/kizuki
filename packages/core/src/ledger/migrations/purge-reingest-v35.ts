import type { Database } from "bun:sqlite";

/**
 * Ledger migration 35. Additive tables and one index; no existing row is
 * touched, so a re-run is a no-op and an interrupted run rolls back whole.
 *
 * `purge_erasures` receipts what a purge batch erased (archive copies, claim and
 * proposal payloads) and whether its ledger files were compacted and truncated
 * (`sealed`). `recover` finishes a batch whose row is missing or unsealed.
 *
 * `purge_claim_scope` names the typed claims whose evidence links a purge
 * removed, captured before those links are deleted so the erasure can still
 * reach them.
 *
 * `purge_suppression_lifts` records that the owner lifted the refusal of a
 * purged source record. The refusal itself is derived from the purge history
 * (`event_purges` and `event_purge_proofs`), which already survives backup and
 * restore; a restored vault therefore refuses again until the owner lifts it.
 * `purge_suppression_sources` narrows that refusal to the source the record
 * was captured from, when the event was bound to one.
 */
export function applyPurgeReingestV35(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS purge_erasures (
      batch_id TEXT PRIMARY KEY,
      erased_at TEXT NOT NULL,
      sealed INTEGER NOT NULL DEFAULT 0 CHECK (sealed IN (0, 1)),
      archive_paths TEXT NOT NULL DEFAULT '[]',
      claims INTEGER NOT NULL DEFAULT 0,
      proposals INTEGER NOT NULL DEFAULT 0
    ) STRICT;
    CREATE TABLE IF NOT EXISTS purge_claim_scope (
      batch_id TEXT NOT NULL,
      claim_id TEXT NOT NULL,
      PRIMARY KEY (batch_id, claim_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS purge_suppression_lifts (
      receipt_id TEXT PRIMARY KEY,
      lifted_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS purge_suppression_sources (
      receipt_id TEXT PRIMARY KEY,
      source_key TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS event_purge_proofs_by_record ON event_purge_proofs(source_record_id);
  `);
}
