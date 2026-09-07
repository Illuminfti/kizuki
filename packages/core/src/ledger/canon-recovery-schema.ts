import type { Database } from "bun:sqlite";
import { LedgerStoreError } from "./errors";

/** Replay payloads are private, source-associated state, never portable evidence. */
export const MAX_CANON_INTENT_BYTES = 8 * 1024 * 1024;
export const MAX_CANON_IMAGE_BYTES = 1024 * 1024;
export const MAX_CANON_IDENTITY_BINDINGS = 32_768;

const TABLES = {
  canon_write_intents: `CREATE TABLE canon_write_intents (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    receipt_id TEXT NOT NULL UNIQUE,
    page_path TEXT NOT NULL,
    intent TEXT NOT NULL CHECK (length(CAST(intent AS BLOB)) BETWEEN 1 AND ${MAX_CANON_INTENT_BYTES}),
    digest TEXT NOT NULL CHECK (length(digest) = 64 AND digest NOT GLOB '*[^0-9a-f]*')
  ) STRICT`,
  canon_write_intent_sources: `CREATE TABLE canon_write_intent_sources (
    receipt_id TEXT NOT NULL REFERENCES canon_write_intents(receipt_id) ON DELETE CASCADE,
    source_key TEXT NOT NULL,
    event_id TEXT NOT NULL,
    PRIMARY KEY (receipt_id, source_key, event_id)
  ) STRICT`,
  canon_read_generation: `CREATE TABLE canon_read_generation (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    generation INTEGER NOT NULL CHECK (generation >= 0)
  ) STRICT`,
  canon_projection_obligations: `CREATE TABLE canon_projection_obligations (
    receipt_id TEXT PRIMARY KEY REFERENCES canon_receipts(receipt_id) ON DELETE RESTRICT,
    page_path TEXT NOT NULL,
    obligation TEXT NOT NULL CHECK (length(CAST(obligation AS BLOB)) BETWEEN 1 AND ${MAX_CANON_INTENT_BYTES}),
    digest TEXT NOT NULL CHECK (length(digest) = 64 AND digest NOT GLOB '*[^0-9a-f]*')
  ) STRICT`,
  canon_projection_sources: `CREATE TABLE canon_projection_sources (
    receipt_id TEXT NOT NULL REFERENCES canon_projection_obligations(receipt_id) ON DELETE CASCADE,
    source_key TEXT NOT NULL,
    event_id TEXT NOT NULL,
    PRIMARY KEY (receipt_id, source_key, event_id)
  ) STRICT`,
} as const;

export function applyCanonRecoveryV21(db: Database): void {
  for (const sql of Object.values(TABLES)) db.exec(sql);
  db.exec("INSERT INTO canon_read_generation VALUES (1,0)");
}

function normalized(sql: string): string { return sql.replace(/\s+/g, "").replace(/;$/, "").toLowerCase(); }

export function assertCanonRecoverySchema(db: Database): void {
  for (const [name, expected] of Object.entries(TABLES)) {
    const row = db.query<{ sql: string }, [string]>("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(name);
    if (row === null || normalized(row.sql) !== normalized(expected)) {
      throw new LedgerStoreError("corrupt", "canon recovery schema is invalid");
    }
  }
  const rows = db.query<{ singleton: number; generation: number }, []>("SELECT * FROM canon_read_generation LIMIT 2").all();
  if (rows.length !== 1 || rows[0]!.singleton !== 1 || !Number.isSafeInteger(rows[0]!.generation) || rows[0]!.generation < 0) {
    throw new LedgerStoreError("corrupt", "canon recovery generation is invalid");
  }
}
