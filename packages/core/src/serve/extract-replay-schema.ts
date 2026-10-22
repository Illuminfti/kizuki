import type { Database } from "bun:sqlite";
import { initServe } from "./schema";

export const EXTRACT_REPLAY_SCHEMA_VERSION = 48;

/** Receipts are immutable except supported event/source erasure. Progress is
 * ordinary mutable extraction state, not a second claim or canon writer. */
export function applyExtractReplay(db: Database): void {
  // Supported older ledgers may predate the later serve-table repair. Reuse
  // its owner before altering that table within this migration transaction.
  initServe(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS extract_replay_receipts (
      operation_id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL REFERENCES events(event_id) ON DELETE CASCADE,
      plan_sha256 TEXT NOT NULL,
      plan TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(event_id,plan_sha256)
    ) STRICT;
    CREATE TRIGGER IF NOT EXISTS extract_replay_receipts_immutable BEFORE UPDATE ON extract_replay_receipts
    BEGIN SELECT RAISE(ABORT,'extraction replay receipts are immutable'); END;
    CREATE TABLE IF NOT EXISTS extract_segment_settlements (
      decision_id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL REFERENCES events(event_id) ON DELETE CASCADE,
      run_id TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      start_utf16 INTEGER NOT NULL,
      end_utf16 INTEGER NOT NULL,
      chars INTEGER NOT NULL,
      producer_fingerprint TEXT NOT NULL,
      model_binding_digest TEXT NOT NULL,
      outcome TEXT NOT NULL CHECK(outcome IN ('empty','nonempty')),
      replay_operation_id TEXT REFERENCES extract_replay_receipts(operation_id) ON DELETE CASCADE,
      created_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS extract_segment_settlements_event ON extract_segment_settlements(event_id);
    CREATE TRIGGER IF NOT EXISTS extract_segment_settlements_immutable BEFORE UPDATE ON extract_segment_settlements
    BEGIN SELECT RAISE(ABORT,'extraction segment settlements are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS extract_replay_source_erased AFTER UPDATE OF status ON source_grants
    WHEN NEW.status='purged'
    BEGIN
      DELETE FROM extract_segment_settlements WHERE event_id IN (SELECT event_id FROM source_event_bindings WHERE source_key=NEW.source_key);
      DELETE FROM extract_replay_receipts WHERE event_id IN (SELECT event_id FROM source_event_bindings WHERE source_key=NEW.source_key);
    END;
  `);
  if (!db.query<{ name: string }, []>("PRAGMA table_info(extract_oversized_records)").all().some(row => row.name === "replay_operation_id")) {
    db.exec("ALTER TABLE extract_oversized_records ADD COLUMN replay_operation_id TEXT REFERENCES extract_replay_receipts(operation_id) ON DELETE SET NULL");
  }
}
