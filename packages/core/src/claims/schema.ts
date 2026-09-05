import type { Database } from "bun:sqlite";
import { tableExists } from "../ledger/schema";
import { claimKey } from "./hash";
import { boundedClaimRows, decodeClaimV1, invalidStoredClaim } from "./record-storage";
import { appendClaimTransition, claimProjection } from "./history";

/** RFC 0002 §18.1 — claims-core widens durable state to schema v3. */
export const CLAIMS_SCHEMA_VERSION = 4;

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
  const v1 = columnNames(db, "claims").has("claim_schema") ? "claim_schema='kizuki.claim/v1' AND " : "";
  db.exec(`
    UPDATE claims SET valid_from = created_at
     WHERE ${v1}(valid_from IS NULL OR valid_from = '');
    UPDATE claims SET asserted_at = created_at
     WHERE ${v1}(asserted_at IS NULL OR asserted_at = '');
    UPDATE claims SET sensitivity = 'private'
     WHERE ${v1}(sensitivity IS NULL OR sensitivity = '');
    UPDATE claims SET last_confirmed_at = created_at
     WHERE ${v1}last_confirmed_at IS NULL;
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
    FROM claims ${columnNames(db, "claims").has("claim_schema") ? "WHERE claim_schema='kizuki.claim/v1'" : ""};
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
  db.exec(columnNames(db, "claims").has("claim_schema") ? CLAIMS_INDEXES.replace("WHERE kind <> 'purge_review'", "WHERE claim_schema='kizuki.claim/v1' AND kind <> 'purge_review'") : CLAIMS_INDEXES);
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


const RICH_CHILDREN = `
CREATE TABLE claim_v2_semantics (
  claim_id TEXT PRIMARY KEY REFERENCES claims(claim_id),
  semantic_key TEXT NOT NULL UNIQUE CHECK(length(semantic_key)=64 AND semantic_key NOT GLOB '*[^0-9a-f]*'),
  conflict_key TEXT CHECK(conflict_key IS NULL OR (length(conflict_key)=64 AND conflict_key NOT GLOB '*[^0-9a-f]*')),
  payload TEXT NOT NULL CHECK(octet_length(payload)<=262144)
) STRICT;
CREATE INDEX claim_v2_semantics_conflict ON claim_v2_semantics(conflict_key,claim_id);
CREATE TABLE claim_v2_support (
  support_key TEXT PRIMARY KEY CHECK(length(support_key)=64 AND support_key NOT GLOB '*[^0-9a-f]*'),
  claim_id TEXT NOT NULL REFERENCES claims(claim_id),
  admission TEXT NOT NULL CHECK(octet_length(admission)<=262144)
) STRICT;
CREATE INDEX claim_v2_support_claim ON claim_v2_support(claim_id,support_key);
CREATE TABLE claim_v2_support_events (
  support_key TEXT NOT NULL REFERENCES claim_v2_support(support_key) ON DELETE CASCADE,
  event_id TEXT NOT NULL REFERENCES events(event_id),
  PRIMARY KEY(support_key,event_id)
) STRICT;
CREATE INDEX claim_v2_support_events_event ON claim_v2_support_events(event_id,support_key);
CREATE TABLE claim_v2_support_anchors (
  support_key TEXT NOT NULL REFERENCES claim_v2_support(support_key) ON DELETE CASCADE,
  event_id TEXT NOT NULL REFERENCES events(event_id),
  start_utf16 INTEGER NOT NULL CHECK(start_utf16>=0),
  end_utf16 INTEGER NOT NULL CHECK(end_utf16>start_utf16),
  role TEXT NOT NULL CHECK(role IN ('assertion','attribution','subject','object','context','holder','speaker','addressee','control')),
  ref_kind TEXT NOT NULL CHECK(ref_kind IN ('','supplied','occurrence')),
  ref_id TEXT NOT NULL CHECK(octet_length(ref_id)<=1024),
  CHECK((role IN ('assertion','attribution') AND ref_kind='' AND ref_id='') OR (role NOT IN ('assertion','attribution') AND ref_kind<>'' AND ref_id<>'')),
  PRIMARY KEY(support_key,event_id,start_utf16,end_utf16,role,ref_kind,ref_id)
) STRICT;
CREATE INDEX claim_v2_support_anchors_event ON claim_v2_support_anchors(event_id,support_key);
CREATE INDEX claim_v2_support_anchors_ref ON claim_v2_support_anchors(ref_kind,ref_id,support_key);
CREATE TABLE claim_occurrences (
  occurrence_id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(event_id),
  label TEXT NOT NULL CHECK(octet_length(label) BETWEEN 1 AND 512),
  payload TEXT NOT NULL CHECK(octet_length(payload)<=16384)
) STRICT;
CREATE INDEX claim_occurrences_event ON claim_occurrences(event_id,occurrence_id);
CREATE TABLE claim_history (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  transition_id TEXT NOT NULL UNIQUE,
  claim_id TEXT NOT NULL REFERENCES claims(claim_id),
  schema TEXT NOT NULL,
  operation TEXT NOT NULL,
  at TEXT NOT NULL,
  before_projection TEXT CHECK(before_projection IS NULL OR octet_length(before_projection)<=262144),
  after_projection TEXT CHECK(after_projection IS NULL OR octet_length(after_projection)<=262144),
  receipt_id TEXT,
  purge_ref TEXT,
  integrity TEXT NOT NULL CHECK(length(integrity)=64 AND integrity NOT GLOB '*[^0-9a-f]*'),
  CHECK((schema='kizuki.claim-transition/v1' AND operation IN
    ('upgrade_baseline','assertion','support_addition','supersession','retraction','revert','reinstate','materialization','projection')
    AND after_projection IS NOT NULL AND purge_ref IS NULL)
    OR (schema='kizuki.claim-transition-purged/v1' AND operation='purged' AND before_projection IS NULL
    AND after_projection IS NULL AND receipt_id IS NULL AND purge_ref IS NOT NULL))
) STRICT;
CREATE INDEX claim_history_claim ON claim_history(claim_id,sequence);
CREATE TRIGGER claim_semantics_immutable BEFORE UPDATE ON claim_v2_semantics
  BEGIN SELECT RAISE(ABORT,'claim meaning is immutable'); END;
CREATE TRIGGER claim_support_immutable BEFORE UPDATE ON claim_v2_support
  BEGIN SELECT RAISE(ABORT,'claim admission is immutable'); END;
CREATE TRIGGER claim_occurrence_immutable BEFORE UPDATE ON claim_occurrences
  BEGIN SELECT RAISE(ABORT,'claim occurrence is immutable'); END;
CREATE TRIGGER claim_history_immutable BEFORE UPDATE ON claim_history
  BEGIN SELECT RAISE(ABORT,'claim history is append only'); END;
CREATE TRIGGER claim_history_delete BEFORE DELETE ON claim_history
  WHEN NOT EXISTS(SELECT 1 FROM claims WHERE claim_id=OLD.claim_id AND status='purged')
  BEGIN SELECT RAISE(ABORT,'claim history deletion requires physical purge'); END;
`;

/** Ledger 17: table copy and every child/index/baseline share the migration transaction. */
export function applyClaimsV4(db:Database):void {
  if(!db.inTransaction) return invalidStoredClaim();
  // Admit bounded keyset pages before copying or parsing any historical payload.
  let after="";
  for(;;) {
    const rows=boundedClaimRows(db,"WHERE claim_id>? ORDER BY claim_id",[after]);
    if(rows.length===0) break;
    for(const row of rows) { decodeClaimV1(row); after=row.claim_id; }
  }
  // Current v16 has no claim FKs, but defer NO ACTION references during the
  // create/copy/swap so existing references still resolve to the same IDs.
  // Unknown extension schemas with destructive FK actions need their own
  // coordinated rebuild; a DROP must never cascade away somebody else's rows.
  using destructiveStatement=db.prepare(`SELECT 1 FROM sqlite_master m,pragma_foreign_key_list(m.name) f
    WHERE m.type='table' AND f.[table]='claims' AND f.on_delete NOT IN ('NO ACTION','RESTRICT') LIMIT 1`);
  const destructive=destructiveStatement.get();
  if(destructive!==null) return invalidStoredClaim();
  using deferralStatement=db.prepare<{defer_foreign_keys:number},[]>("PRAGMA defer_foreign_keys");
  const priorDeferral=deferralStatement.get()?.defer_foreign_keys??0;
  db.exec("PRAGMA defer_foreign_keys=ON");
  const columns=[...columnNames(db,"claims")].join(",");
  const table=CLAIMS_TABLE.replace("IF NOT EXISTS claims", "claims_v4")
    .replace("valid_from TEXT NOT NULL DEFAULT ''", "valid_from TEXT DEFAULT ''")
    .replace("last_confirmed_at TEXT\n", `last_confirmed_at TEXT,
      claim_schema TEXT NOT NULL DEFAULT 'kizuki.claim/v1',
      temporal_basis TEXT,
      purge_ref TEXT,
      CHECK((claim_schema='kizuki.claim/v1' AND valid_from IS NOT NULL AND temporal_basis IS NULL AND purge_ref IS NULL)
        OR (claim_schema='kizuki.claim/v2' AND (
          (status='purged' AND purge_ref IS NOT NULL AND temporal_basis IS NULL AND valid_from IS NULL AND valid_to IS NULL
            AND body='' AND frontmatter='{}' AND provenance='[]' AND subjects='[]' AND subject IS NULL AND predicate IS NULL
            AND object IS NULL AND claim_key IS NULL AND target IS NULL AND model_ref IS NULL AND receipt_id IS NULL
            AND superseded_by IS NULL AND producer='deterministic' AND sensitivity='private' AND authority='model_inference'
            AND taint='quoted' AND confidence=0 AND corroboration=0 AND last_confirmed_at IS NULL)
          OR (status<>'purged' AND purge_ref IS NULL AND (
            (temporal_basis='unknown' AND valid_from IS NULL AND valid_to IS NULL)
            OR (temporal_basis IN ('explicit','observed') AND valid_from IS NOT NULL)))))
      )
`);
  db.exec(table);
  db.exec(`INSERT INTO claims_v4(${columns}) SELECT ${columns} FROM claims;
    DROP TABLE claims; ALTER TABLE claims_v4 RENAME TO claims;`);
  db.exec(CLAIMS_INDEXES.replace("WHERE kind <> 'purge_review'", "WHERE claim_schema='kizuki.claim/v1' AND kind <> 'purge_review'"));
  db.exec(RICH_CHILDREN);
  const at=new Date().toISOString(); after="";
  for(;;) {
    const rows=boundedClaimRows(db,"WHERE claim_id>? ORDER BY claim_id",[after]);
    if(rows.length===0) break;
    for(const row of rows) {
      const claim=decodeClaimV1(row);
      appendClaimTransition(db,claim.claim_id,"upgrade_baseline",at,null,claimProjection(claim));
      after=row.claim_id;
    }
  }
  using foreignKeys=db.prepare("PRAGMA foreign_key_check");
  if(foreignKeys.all().length!==0) return invalidStoredClaim();
  // DROP leaves SQLite's deferred-violation counter set even after the exact
  // parent is recreated. Clear only that debt after a full FK validation;
  // foreign_keys remains ON throughout, and later writes enforce constraints.
  db.exec("PRAGMA defer_foreign_keys=OFF");
  if(priorDeferral===1) db.exec("PRAGMA defer_foreign_keys=ON");
}
