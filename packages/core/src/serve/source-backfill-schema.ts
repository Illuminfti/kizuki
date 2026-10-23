import type { Database } from "bun:sqlite";

export { SOURCE_BACKFILL_SCHEMA_VERSION } from "../world/tables/versions";

/**
 * Each source event and composite extraction identity has one immutable bounded
 * backfill attempt. Its result is
 * separately immutable, so an accepted plan can never be silently retried or
 * rewritten after a source has changed or been erased.
 */
export function applySourceBackfill(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS source_backfill_attempts (
      operation_id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL REFERENCES events(event_id) ON DELETE CASCADE,
      producer_fingerprint TEXT NOT NULL,
      model_binding_digest TEXT NOT NULL,
      start_utf16 INTEGER NOT NULL,
      end_utf16 INTEGER NOT NULL,
      cap_utf16 INTEGER NOT NULL,
      plan_sha256 TEXT NOT NULL,
      plan TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(event_id,producer_fingerprint,model_binding_digest)
    ) STRICT;
    CREATE TRIGGER IF NOT EXISTS source_backfill_attempts_immutable BEFORE UPDATE ON source_backfill_attempts
    BEGIN SELECT RAISE(ABORT,'source backfill attempts are immutable'); END;

    CREATE TABLE IF NOT EXISTS source_backfill_results (
      operation_id TEXT PRIMARY KEY REFERENCES source_backfill_attempts(operation_id) ON DELETE CASCADE,
      outcome TEXT NOT NULL CHECK(outcome IN ('settled','rejected','failed')),
      report TEXT NOT NULL,
      created_at TEXT NOT NULL
    ) STRICT;
    CREATE TRIGGER IF NOT EXISTS source_backfill_results_immutable BEFORE UPDATE ON source_backfill_results
    BEGIN SELECT RAISE(ABORT,'source backfill results are immutable'); END;

    CREATE TRIGGER IF NOT EXISTS source_backfill_source_erased AFTER UPDATE OF status ON source_grants
    WHEN NEW.status='purged'
    BEGIN
      DELETE FROM source_backfill_attempts WHERE event_id IN (
        SELECT event_id FROM source_event_bindings WHERE source_key=NEW.source_key
      );
    END;
  `);
}
