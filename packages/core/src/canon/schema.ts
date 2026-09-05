import type { Database } from "bun:sqlite";
import { tableExists } from "../ledger/schema";

/** RFC 0002 §18.1 — canon-writer widens durable state to schema v4. */
export const CANON_SCHEMA_VERSION = 4;

/**
 * The receipt row is the durable half of `CanonReceipt` (§4.5). Every column
 * RFC 0002 lists for v4 is present; `superseded` and `retrieval_ops` are
 * added so the row round-trips the whole receipt, and the legacy
 * `proposal_id` column becomes the first entry of `claim_ids`.
 */
const CANON_RECEIPTS_TABLE = `
CREATE TABLE IF NOT EXISTS canon_receipts (
  receipt_id TEXT PRIMARY KEY,
  claim_ids TEXT NOT NULL DEFAULT '[]',
  provenance TEXT NOT NULL,
  sensitivity TEXT NOT NULL,
  page_path TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'claim',
  before_hash TEXT,
  after_hash TEXT NOT NULL,
  at TEXT NOT NULL,
  receipt_kind TEXT NOT NULL DEFAULT 'write',
  page_action TEXT NOT NULL DEFAULT 'edit',
  archive_path TEXT,
  writer TEXT NOT NULL DEFAULT 'import',
  producer TEXT NOT NULL DEFAULT 'deterministic',
  model_ref TEXT,
  authority TEXT NOT NULL DEFAULT 'connector_evidence',
  confidence REAL NOT NULL DEFAULT 1.0,
  taint TEXT NOT NULL DEFAULT 'quoted',
  candidates TEXT NOT NULL DEFAULT '[]',
  superseded TEXT NOT NULL DEFAULT '[]',
  retrieval_ops TEXT NOT NULL DEFAULT '[]',
  reverts TEXT,
  reverted_by TEXT
) STRICT;
`;

const SOURCE_ERASURE_INTENTS_SQL = `CREATE TABLE IF NOT EXISTS canon_source_erasure_intents (
  page_path TEXT PRIMARY KEY, source_key TEXT NOT NULL, intent TEXT NOT NULL, digest TEXT NOT NULL
) STRICT;`;

const CANON_INDEXES = `
CREATE INDEX IF NOT EXISTS canon_receipts_by_page ON canon_receipts(page_path, at, receipt_id);
CREATE INDEX IF NOT EXISTS canon_receipts_by_at ON canon_receipts(at, receipt_id);
CREATE TABLE IF NOT EXISTS page_index (
  page_id TEXT PRIMARY KEY,
  rel_path TEXT NOT NULL,
  subject_key TEXT,
  last_receipt TEXT,
  last_hash TEXT NOT NULL
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS page_index_by_path ON page_index(rel_path);
CREATE INDEX IF NOT EXISTS page_index_by_subject ON page_index(subject_key);
`;

const WIDENING_COLUMNS = [
  "claim_ids TEXT NOT NULL DEFAULT '[]'",
  "receipt_kind TEXT NOT NULL DEFAULT 'write'",
  "page_action TEXT NOT NULL DEFAULT 'edit'",
  "archive_path TEXT",
  "writer TEXT NOT NULL DEFAULT 'import'",
  "producer TEXT NOT NULL DEFAULT 'deterministic'",
  "model_ref TEXT",
  "authority TEXT NOT NULL DEFAULT 'connector_evidence'",
  "confidence REAL NOT NULL DEFAULT 1.0",
  "taint TEXT NOT NULL DEFAULT 'quoted'",
  "candidates TEXT NOT NULL DEFAULT '[]'",
  "superseded TEXT NOT NULL DEFAULT '[]'",
  "retrieval_ops TEXT NOT NULL DEFAULT '[]'",
  "reverts TEXT",
  "reverted_by TEXT",
] as const;

function columnNames(db: Database, table: string): Set<string> {
  return new Set(
    db
      .query<{ name: string }, [string]>("SELECT name FROM pragma_table_info(?)")
      .all(table)
      .map(({ name }) => name),
  );
}

function addColumn(db: Database, table: string, ddl: string): void {
  const name = ddl.split(/\s+/)[0];
  if (name === undefined || columnNames(db, table).has(name)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

/**
 * A pre-RFC promotion receipt has no archive copy and no writer stamp. It
 * migrates as `writer='import'`, `producer='deterministic'`,
 * `archive_path=NULL`, and `kizuki undo` will say so rather than fail
 * obscurely (§18.1).
 */
function migratePromotions(db: Database): void {
  db.exec(CANON_RECEIPTS_TABLE);
  db.exec(`
    INSERT INTO canon_receipts
      (receipt_id, claim_ids, provenance, sensitivity, page_path, kind,
       before_hash, after_hash, at, receipt_kind, page_action, archive_path,
       writer, producer, model_ref, authority, confidence, taint,
       candidates, superseded, retrieval_ops, reverts, reverted_by)
    SELECT
      receipt_id, json_array(proposal_id), provenance, sensitivity, page_path,
      kind, before_hash, after_hash, at, 'write',
      CASE WHEN before_hash IS NULL THEN 'create'
           WHEN kind = 'deletion' THEN 'archive'
           ELSE 'edit' END,
      NULL, 'import', 'deterministic', NULL, 'connector_evidence', 1.0,
      'quoted', '[]', '[]', '[]', NULL, NULL
    FROM promotions
    ORDER BY at, receipt_id;
  `);
  db.exec("DROP TABLE promotions");
}

/**
 * RFC 0002 §18.1 v4. Idempotent: safe on a fresh database, on a v3 database
 * that still holds `promotions`, and on a database where a partial upgrade
 * left `canon_receipts` narrower than this revision expects.
 */
export function applyCanonV4(db: Database): void {
  if (tableExists(db, "promotions") && !tableExists(db, "canon_receipts")) {
    migratePromotions(db);
  }
  db.exec(CANON_RECEIPTS_TABLE);
  for (const ddl of WIDENING_COLUMNS) addColumn(db, "canon_receipts", ddl);
  db.exec(CANON_INDEXES);
  db.exec(SOURCE_ERASURE_INTENTS_SQL);
}

function canonSurfaceReady(db: Database): boolean {
  if (!tableExists(db, "canon_receipts") || !tableExists(db, "page_index") || !tableExists(db, "canon_source_erasure_intents")) {
    return false;
  }
  const columns = columnNames(db, "canon_receipts");
  return WIDENING_COLUMNS.every((ddl) => {
    const name = ddl.split(/\s+/)[0];
    return name !== undefined && columns.has(name);
  });
}

/** Cheap no-op once v4 exists. `applyCanonV4` stays the migration path. */
export function initCanon(db: Database): void {
  if (canonSurfaceReady(db)) return;
  applyCanonV4(db);
}
