import type { Database } from "bun:sqlite";

/** Grant authority lives in the existing ledger; migration invents no grants. */
export function applySourceGrantsV11(db: Database): void {
  db.exec(`
    ALTER TABLE connections ADD COLUMN consent_required INTEGER NOT NULL DEFAULT 0 CHECK(consent_required IN (0,1));
    CREATE TABLE source_grants (
      source_key TEXT PRIMARY KEY REFERENCES connections(source_key),
      connector_id TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK(revision > 0),
      status TEXT NOT NULL CHECK(status IN ('active','denied','purged')),
      policy TEXT NOT NULL,
      policy_digest TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      revoke_operation TEXT,
      purge_receipt_id TEXT
    ) STRICT;
    CREATE TABLE source_event_bindings (
      event_id TEXT PRIMARY KEY,
      source_key TEXT NOT NULL REFERENCES source_grants(source_key),
      grant_revision INTEGER NOT NULL,
      policy_digest TEXT NOT NULL
    ) STRICT;
    CREATE INDEX source_event_bindings_source ON source_event_bindings(source_key,event_id);
    CREATE TABLE source_grant_receipts (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      operation_id TEXT NOT NULL UNIQUE,
      request_digest TEXT NOT NULL,
      receipt TEXT NOT NULL
    ) STRICT;
  `);
}

/** Explicit native authority is never inferred from captured connector metadata. */
export function applyNativeOwnerEvidenceV12(db: Database): void {
  db.exec(`CREATE TABLE native_owner_evidence (
    event_id TEXT PRIMARY KEY,
    origin TEXT NOT NULL CHECK(origin='correction'),
    request_digest TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    filing_state TEXT NOT NULL CHECK(filing_state IN ('recorded','filed','failed'))
  ) STRICT;`);
}
