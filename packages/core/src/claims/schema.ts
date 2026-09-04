import type { Database } from "bun:sqlite";
import { tableExists } from "../ledger/schema";
import { claimKey } from "./hash";

/** RFC 0002 §18.1 — claims-core widens durable state to schema v3. */
export const CLAIMS_SCHEMA_VERSION = 3;

const CLAIMS_TABLE = `
CREATE TABLE IF NOT EXISTS claims (
  claim_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  target TEXT,
  body TEXT NOT NULL,
  frontmatter TEXT NOT NULL,
  provenance TEXT NOT NULL,
  subjects TEXT NOT NULL,
  producer TEXT NOT NULL,
  confidence REAL NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  body_hash TEXT NOT NULL,
  subject TEXT,
  predicate TEXT,
  object TEXT,
  polarity TEXT NOT NULL DEFAULT 'positive',
  claim_key TEXT,
  authority TEXT NOT NULL DEFAULT 'connector_evidence',
  sensitivity TEXT,
  taint TEXT NOT NULL DEFAULT 'quoted',
  model_ref TEXT,
  valid_from TEXT NOT NULL DEFAULT '',
  valid_to TEXT,
  asserted_at TEXT NOT NULL DEFAULT '',
  retracted_at TEXT,
  superseded_by TEXT,
  receipt_id TEXT,
  corroboration INTEGER NOT NULL DEFAULT 1,
  last_confirmed_at TEXT
) STRICT;
`;

const CLAIMS_INDEXES = `
DROP INDEX IF EXISTS claims_idempotency;
CREATE UNIQUE INDEX claims_idempotency
  ON claims (kind, coalesce(target, ''), body_hash)
  WHERE kind <> 'purge_review';
CREATE INDEX IF NOT EXISTS claims_by_key ON claims(claim_key, status, valid_from);
CREATE INDEX IF NOT EXISTS claims_by_status ON claims(status, created_at);
CREATE INDEX IF NOT EXISTS claims_by_subject ON claims(subject, status);
`;

const SUPPORTING_TABLES = `
CREATE TABLE IF NOT EXISTS claim_supersessions (
  winner TEXT NOT NULL,
  loser TEXT NOT NULL,
  rule TEXT NOT NULL,
  prior_valid_to TEXT,
  receipt_id TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (winner, loser)
) STRICT;
CREATE TABLE IF NOT EXISTS claim_bindings (
  claim_key TEXT NOT NULL,
  page_id TEXT NOT NULL,
  bound_at TEXT NOT NULL,
  PRIMARY KEY (claim_key, page_id)
) STRICT;
CREATE TABLE IF NOT EXISTS retrieval_ops (
  op_id TEXT PRIMARY KEY,
  store TEXT NOT NULL,
  op TEXT NOT NULL,
  doc_id TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  done_at TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS retrieval_ops_pending
  ON retrieval_ops(state, created_at);
CREATE TABLE IF NOT EXISTS identity_links (
  subject_a TEXT NOT NULL,
  subject_b TEXT NOT NULL,
  score REAL NOT NULL,
  evidence TEXT NOT NULL,
  status TEXT NOT NULL,
  decided_by TEXT NOT NULL,
  receipt_id TEXT,
  at TEXT NOT NULL,
  PRIMARY KEY (subject_a, subject_b)
) STRICT;
CREATE INDEX IF NOT EXISTS identity_links_by_b ON identity_links(subject_b);
`;

const COMPAT_PROPOSALS = `
CREATE TABLE IF NOT EXISTS proposals (
  proposal_id TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  target      TEXT,
  body        TEXT NOT NULL,
  frontmatter TEXT NOT NULL,
  provenance  TEXT NOT NULL,
  subjects    TEXT NOT NULL,
  producer    TEXT NOT NULL,
  confidence  REAL NOT NULL,
  status      TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  body_hash   TEXT NOT NULL
) STRICT;
DROP INDEX IF EXISTS proposals_idempotency;
CREATE UNIQUE INDEX proposals_idempotency
  ON proposals (kind, coalesce(target, ''), body_hash)
  WHERE kind <> 'purge_review';
CREATE INDEX IF NOT EXISTS proposals_by_status
  ON proposals (status, created_at);
`;

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
  if (name === undefined) return;
  if (columnNames(db, table).has(name)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

function rewriteClaimStatuses(db: Database): void {
  db.exec(`
    UPDATE claims SET status = CASE status
      WHEN 'pending' THEN 'skipped'
      WHEN 'promoted' THEN 'live'
      WHEN 'rejected' THEN 'superseded'
      WHEN 'withdrawn' THEN 'skipped'
      ELSE status
    END
    WHERE status IN ('pending', 'promoted', 'rejected', 'withdrawn');
  `);
}

function backfillTemporal(db: Database): void {
  db.exec(`
    UPDATE claims SET valid_from = created_at
     WHERE valid_from IS NULL OR valid_from = '';
    UPDATE claims SET asserted_at = created_at
     WHERE asserted_at IS NULL OR asserted_at = '';
    UPDATE claims SET sensitivity = 'private'
     WHERE sensitivity IS NULL OR sensitivity = '';
    UPDATE claims SET last_confirmed_at = created_at
     WHERE last_confirmed_at IS NULL;
  `);
}

function convertRejections(db: Database): void {
  if (!tableExists(db, "rejections")) return;
  const rows = db
    .query<
      {
        body_hash: string;
        reason: string;
        proposal_id: string;
        at: string;
      },
      []
    >("SELECT body_hash, reason, proposal_id, at FROM rejections")
    .all();

  const insert = db.query(
    `INSERT OR IGNORE INTO claims
       (claim_id, kind, target, body, frontmatter, provenance, subjects,
        producer, confidence, status, created_at, body_hash,
        subject, predicate, object, polarity, claim_key, authority,
        sensitivity, taint, model_ref, valid_from, valid_to, asserted_at,
        retracted_at, superseded_by, receipt_id, corroboration, last_confirmed_at)
     VALUES (?, 'claim', NULL, ?, ?, ?, '[]', 'owner', 1, ?, ?, ?,
             ?, ?, NULL, 'negative', ?, 'owner_correction',
             'private', 'clean', NULL, ?, NULL, ?, NULL, NULL, NULL, 1, ?)`,
  );

  for (const row of rows) {
    const source = tableExists(db, "claims")
      ? db
          .query<
            { subjects: string; body: string; created_at: string },
            [string, string]
          >(
            "SELECT subjects, body, created_at FROM claims WHERE claim_id = ? OR body_hash = ? LIMIT 1",
          )
          .get(row.proposal_id, row.body_hash)
      : null;
    const subjectsRaw = source?.subjects ?? "[]";
    let subject: string | null = null;
    try {
      const parsed: unknown = JSON.parse(subjectsRaw);
      if (Array.isArray(parsed) && typeof parsed[0] === "string") {
        subject = parsed[0];
      }
    } catch {
      subject = null;
    }
    const inferable = subject !== null;
    const key = subject !== null ? claimKey(subject, "decision.rejected") : null;
    const status = inferable ? "live" : "skipped";
    const frontmatter = JSON.stringify({
      "x-rejection-reason": row.reason,
      "x-migrated-from": "rejections",
    });
    const convertedHash = new Bun.CryptoHasher("sha256")
      .update(`rejection:${row.body_hash}:${row.proposal_id}`)
      .digest("hex");
    insert.run(
      `rej-${row.proposal_id}`,
      source?.body ?? row.reason,
      frontmatter,
      JSON.stringify(["migrated-rejection"]),
      status,
      row.at,
      convertedHash,
      subject,
      inferable ? "decision.rejected" : null,
      key,
      row.at,
      row.at,
      row.at,
    );
  }

  db.exec("DROP TABLE rejections");
}

/** Staging still reads `proposals`; keep it a projection of `claims`. */
export function syncCompatProposals(db: Database): void {
  if (!tableExists(db, "proposals")) {
    db.exec(COMPAT_PROPOSALS);
  }
  db.exec(`
    INSERT OR IGNORE INTO proposals
      (proposal_id, kind, target, body, frontmatter, provenance, subjects,
       producer, confidence, status, created_at, body_hash)
    SELECT
      claim_id, kind, target, body, frontmatter, provenance, subjects,
      CASE producer WHEN 'model' THEN 'llm' ELSE producer END,
      confidence,
      CASE status
        WHEN 'live' THEN 'promoted'
        WHEN 'superseded' THEN 'rejected'
        WHEN 'skipped' THEN CASE WHEN retracted_at IS NOT NULL THEN 'withdrawn' ELSE 'pending' END
        WHEN 'purged' THEN 'withdrawn'
        WHEN 'provenance_reduced' THEN 'promoted'
        WHEN 'reverted' THEN 'withdrawn'
        ELSE status
      END,
      created_at, body_hash
    FROM claims;
  `);
}

function widenClaims(db: Database): void {
  addColumn(db, "claims", "subject TEXT");
  addColumn(db, "claims", "predicate TEXT");
  addColumn(db, "claims", "object TEXT");
  addColumn(db, "claims", "polarity TEXT NOT NULL DEFAULT 'positive'");
  addColumn(db, "claims", "claim_key TEXT");
  addColumn(db, "claims", "authority TEXT NOT NULL DEFAULT 'connector_evidence'");
  addColumn(db, "claims", "sensitivity TEXT");
  addColumn(db, "claims", "taint TEXT NOT NULL DEFAULT 'quoted'");
  addColumn(db, "claims", "model_ref TEXT");
  addColumn(db, "claims", "valid_from TEXT NOT NULL DEFAULT ''");
  addColumn(db, "claims", "valid_to TEXT");
  addColumn(db, "claims", "asserted_at TEXT NOT NULL DEFAULT ''");
  addColumn(db, "claims", "retracted_at TEXT");
  addColumn(db, "claims", "superseded_by TEXT");
  addColumn(db, "claims", "receipt_id TEXT");
  addColumn(db, "claims", "corroboration INTEGER NOT NULL DEFAULT 1");
  addColumn(db, "claims", "last_confirmed_at TEXT");
}

/**
 * RFC 0002 §18.1 v3. Idempotent: safe on a fresh database and on a v2
 * database that already has a `proposals` table.
 */
export function applyClaimsV3(db: Database): void {
  if (tableExists(db, "proposals") && !tableExists(db, "claims")) {
    db.exec("ALTER TABLE proposals RENAME TO claims");
    db.exec("DROP INDEX IF EXISTS proposals_idempotency");
    db.exec("DROP INDEX IF EXISTS proposals_by_status");
    if (columnNames(db, "claims").has("proposal_id")) {
      db.exec("ALTER TABLE claims RENAME COLUMN proposal_id TO claim_id");
    }
  }

  db.exec(CLAIMS_TABLE);
  if (tableExists(db, "claims")) {
    widenClaims(db);
    backfillTemporal(db);
    rewriteClaimStatuses(db);
  }
  db.exec(CLAIMS_INDEXES);
  db.exec(SUPPORTING_TABLES);
  convertRejections(db);
  syncCompatProposals(db);
}

function claimsSurfaceReady(db: Database): boolean {
  if (!tableExists(db, "claims")) return false;
  const claims = columnNames(db, "claims");
  if (!claims.has("claim_id") || !claims.has("claim_key") || !claims.has("authority")) {
    return false;
  }
  return (
    tableExists(db, "claim_supersessions") &&
    tableExists(db, "claim_bindings") &&
    tableExists(db, "retrieval_ops") &&
    tableExists(db, "identity_links") &&
    tableExists(db, "proposals")
  );
}

/** Cheap no-op once v3 exists. `applyClaimsV3` stays the migration path. */
export function initClaims(db: Database): void {
  if (claimsSurfaceReady(db)) {
    return;
  }
  applyClaimsV3(db);
}
