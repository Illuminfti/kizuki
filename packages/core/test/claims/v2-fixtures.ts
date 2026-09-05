import { Database } from "bun:sqlite";
import { applyClaimsV3 } from "../../src/claims/schema";
import { applyCanonV4 } from "../../src/canon/schema";
import { applyPurgeV5 } from "../../src/ledger/purge-schema";
import { applySensitivityV6 } from "../../src/sensitivity/schema";
import { applyServeV7 } from "../../src/serve/schema";
import { applyConnectionsV8 } from "../../src/ledger/connections-schema";
import { applyAgentsV9 } from "../../src/agents/schema";
import { applyDerivedV10 } from "../../src/derived";
import { applySourceGrantsV11, applyNativeOwnerEvidenceV12, applySourceStoresV13,
  applySourceErasureV14, applySourceReceiptIntegrityV15 } from "../../src/ledger/source-grants-schema";
import { applyEventIdentityV16 } from "../../src/ledger/event-identity-schema";

// Exact historical fixture: never call the current openLedger to manufacture
// an old version stamp on a newer database.
const V2_SCHEMA = `
        CREATE TABLE schema_version (version INTEGER NOT NULL);
        INSERT INTO schema_version VALUES (2);
        CREATE TABLE events (
          event_id TEXT PRIMARY KEY,
          connector_id TEXT NOT NULL,
          source_record_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          occurred_at TEXT NOT NULL,
          observed_at TEXT NOT NULL,
          text TEXT NOT NULL,
          subjects TEXT NOT NULL,
          sensitivity_hint TEXT,
          deleted INTEGER NOT NULL,
          attachments TEXT NOT NULL,
          metadata TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          accepted_at TEXT NOT NULL,
          UNIQUE(connector_id, source_record_id, content_hash)
        );
        CREATE TABLE event_purges (
          receipt_id TEXT PRIMARY KEY,
          event_id TEXT NOT NULL,
          connector_id TEXT NOT NULL,
          reason TEXT NOT NULL,
          purged_at TEXT NOT NULL
        );
        CREATE TABLE connections (
          connector_id TEXT NOT NULL,
          source_key TEXT NOT NULL,
          config TEXT NOT NULL,
          secret_refs TEXT NOT NULL,
          connected_at TEXT NOT NULL,
          disconnected_at TEXT,
          PRIMARY KEY (connector_id, source_key)
        ) STRICT;
        CREATE TABLE checkpoints (
          connector_id TEXT NOT NULL,
          source_key TEXT NOT NULL,
          cursor TEXT,
          mode TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          last_run_at TEXT NOT NULL,
          last_result TEXT NOT NULL,
          PRIMARY KEY (connector_id, source_key)
        ) STRICT;
        CREATE TABLE canon_holds (
          page_path TEXT NOT NULL,
          proposal_id TEXT NOT NULL,
          reason TEXT NOT NULL,
          held_at TEXT NOT NULL,
          PRIMARY KEY (page_path, proposal_id)
        ) STRICT;
        CREATE TABLE promotions (
          receipt_id TEXT PRIMARY KEY,
          proposal_id TEXT NOT NULL UNIQUE,
          provenance TEXT NOT NULL,
          sensitivity TEXT NOT NULL,
          page_path TEXT NOT NULL,
          kind TEXT NOT NULL DEFAULT 'claim',
          before_hash TEXT,
          after_hash TEXT NOT NULL,
          at TEXT NOT NULL
        ) STRICT;
        CREATE TABLE proposals (
          proposal_id TEXT PRIMARY KEY,
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
          body_hash TEXT NOT NULL
        ) STRICT;
        CREATE TABLE rejections (
          body_hash TEXT NOT NULL,
          reason TEXT NOT NULL,
          proposal_id TEXT NOT NULL,
          at TEXT NOT NULL,
          PRIMARY KEY (body_hash, proposal_id)
        ) STRICT;
`;
const STEPS = [applyClaimsV3, applyCanonV4, applyPurgeV5, applySensitivityV6,
  applyServeV7, applyConnectionsV8, applyAgentsV9, applyDerivedV10,
  applySourceGrantsV11, applyNativeOwnerEvidenceV12, applySourceStoresV13,
  applySourceErasureV14, applySourceReceiptIntegrityV15, applyEventIdentityV16];
export function historicalLedger(path: string, version = 16): Database {
  const db = new Database(path);
  db.exec("PRAGMA foreign_keys=ON");
  db.transaction(() => {
    db.exec(V2_SCHEMA);
    for (let v=3; v<=version; v++) STEPS[v-3]!(db);
    db.query("UPDATE schema_version SET version=?").run(version);
  }).immediate();
  return db;
}
export function legacyClaim(db: Database, id = "legacy-claim", status = "live"): void {
  db.query(`INSERT INTO claims(claim_id,kind,target,body,frontmatter,provenance,subjects,
    producer,confidence,status,created_at,body_hash,subject,predicate,object,claim_key,
    valid_from,asserted_at,valid_to,receipt_id,last_confirmed_at)
    VALUES (?,'claim','facts/test.md','historical body','{}','["legacy-event"]','["person:one"]',
    'deterministic',0.8,?,'2026-01-01T00:00:00Z',?,'person:one','employment.role','reader',?,
    '2025-01-01T00:00:00+01:00','2026-01-01T00:00:00Z','2027-01-01T00:00:00Z',
    'legacy-receipt','2026-01-02T00:00:00Z')`).run(id,status,"a".repeat(64),"b".repeat(64));
}
