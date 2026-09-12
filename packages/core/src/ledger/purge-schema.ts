import type { Database } from "bun:sqlite";
import { EVENT_LIMITS } from "../contracts/event";
import { tableColumns, tableExists } from "./schema";

/**
 * RFC 0002 §18.1 v5 fragment owned by purge-totality: `purge_ops` only.
 * Schedules, leases, budgets and retrieval_ops stay with serve-daemon.
 */
export const PURGE_SCHEMA_VERSION = 5;

export const PURGE_SLA_SECONDS = 3600;

const PURGE_OPS_TABLE = `
CREATE TABLE IF NOT EXISTS purge_ops (
  op_id TEXT PRIMARY KEY,
  receipt_id TEXT NOT NULL,
  store TEXT NOT NULL,
  ids TEXT NOT NULL,
  state TEXT NOT NULL,
  proof TEXT,
  created_at TEXT NOT NULL,
  done_at TEXT
) STRICT;
`;

export function applyPurgeV5(db: Database): void {
  db.exec(PURGE_OPS_TABLE);
}

export function initPurgeOps(db: Database): void {
  if (tableExists(db, "purge_ops")) return;
  applyPurgeV5(db);
}

export function applyEventPurgeIntegrityV22(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS event_purge_proofs (
      receipt_id TEXT PRIMARY KEY REFERENCES event_purges(receipt_id),
      content_hash TEXT NOT NULL CHECK (
        length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*'
      ),
      source_record_id TEXT NOT NULL CHECK (length(source_record_id) BETWEEN 1 AND ${EVENT_LIMITS.sourceRecordIdBytes})
    ) STRICT;
  `);
}

/** Ledger v24: event-only selector provenance. Other families stay unrecorded. */
export function applyEventPurgeSelectorKindV24(db: Database): void {
  if (tableColumns(db, "event_purge_proofs").includes("selector_kind")) return;
  db.exec(`
    ALTER TABLE event_purge_proofs
      ADD COLUMN selector_kind TEXT
      CHECK (selector_kind IS NULL OR selector_kind = 'event');
  `);
}

/** Ledger v26: connector-only selector provenance. Compound selectors stay unrecorded. */
export function applyEventPurgeSelectorKindV26(db: Database): void {
  if (!tableExists(db, "event_purge_proofs")) return;
  const sql = db.query<{ sql: string | null }, []>(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'event_purge_proofs'",
  ).get()?.sql ?? "";
  if (sql.includes("'connector'")) return;
  db.exec(`
    CREATE TABLE event_purge_proofs_v26 (
      receipt_id TEXT PRIMARY KEY REFERENCES event_purges(receipt_id),
      content_hash TEXT NOT NULL CHECK (
        length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*'
      ),
      source_record_id TEXT NOT NULL CHECK (length(source_record_id) BETWEEN 1 AND ${EVENT_LIMITS.sourceRecordIdBytes}),
      selector_kind TEXT CHECK (selector_kind IS NULL OR selector_kind IN ('event', 'connector'))
    ) STRICT;
    INSERT INTO event_purge_proofs_v26 (receipt_id, content_hash, source_record_id, selector_kind)
      SELECT receipt_id, content_hash, source_record_id, selector_kind FROM event_purge_proofs;
    DROP TABLE event_purge_proofs;
    ALTER TABLE event_purge_proofs_v26 RENAME TO event_purge_proofs;
  `);
}
