import type { Database } from "bun:sqlite";

/**
 * RFC 0003 §"Shared claim storage and immutable support" (B1b). Durable home
 * for `kizuki.claim/v2` semantics and their immutable support children.
 *
 * Nothing in the production path writes these tables yet: B1b installs the
 * floor, B1c adds the shared prepare/commit writer, B1d the versioned reader.
 * The DDL is additive and idempotent so a re-run of migration 31 is a no-op.
 */

/**
 * A v2 semantic extends its `claims` row rather than forming a parallel
 * universe: `claim_id` is both the primary key and the foreign key. Columns
 * mirror exactly what `validateClaimV2Semantic` accepts; `payload` holds the
 * whole validated DTO as canonical JSON and the projected columns exist only
 * so the B1d reader can filter without parsing every row. Identity controls
 * carry no subject, predicate, polarity or interval, so those are nullable.
 */
const CLAIM_V2_SEMANTICS = `
CREATE TABLE IF NOT EXISTS claim_v2_semantics (
  claim_id TEXT PRIMARY KEY REFERENCES claims(claim_id),
  semantic_key TEXT NOT NULL UNIQUE,
  schema TEXT NOT NULL,
  discriminator TEXT NOT NULL CHECK (discriminator IN ('assertion', 'identity_control')),
  subject_kind TEXT,
  subject_id TEXT,
  predicate TEXT,
  object_kind TEXT,
  polarity TEXT CHECK (polarity IS NULL OR polarity IN ('positive', 'negative')),
  temporal_basis TEXT CHECK (temporal_basis IS NULL OR temporal_basis IN ('explicit', 'observed', 'unknown')),
  valid_from TEXT,
  valid_to TEXT,
  payload TEXT NOT NULL
) STRICT;
`;

/**
 * Support is evidence, immutable once written: the support key is the primary
 * key, so a duplicate sighting collides instead of adding a second row or a
 * second confidence observation (RFC 0003, identity 2).
 *
 * `source_key` and `grant_revision` snapshot the verified source identity at
 * admission. They carry no foreign key on purpose: a purged grant is physically
 * deleted (RFC 0002 invariant 3) and evidence recorded before the purge must
 * not be able to block it.
 */
const CLAIM_V2_SUPPORT = `
CREATE TABLE IF NOT EXISTS claim_v2_support (
  support_key TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL REFERENCES claims(claim_id),
  anchors TEXT NOT NULL,
  source_key TEXT NOT NULL,
  grant_revision INTEGER NOT NULL,
  admission TEXT NOT NULL,
  admitted_at TEXT NOT NULL
) STRICT;
`;

/**
 * The checked event identity behind one support row. `ON DELETE CASCADE` keeps
 * physical event purge (RFC 0002 invariant 3) working: erasing the event erases
 * the evidence link, and the provenance union over the survivors is derived and
 * rebuildable (invariant 4). `event_content_hash` snapshots the exact revision
 * that was verified, so a later revision supplies new evidence rather than
 * silently redefining old evidence.
 */
const CLAIM_V2_SUPPORT_EVENTS = `
CREATE TABLE IF NOT EXISTS claim_v2_support_events (
  support_key TEXT NOT NULL REFERENCES claim_v2_support(support_key),
  event_id TEXT NOT NULL REFERENCES events(event_id) ON DELETE CASCADE,
  event_content_hash TEXT NOT NULL,
  PRIMARY KEY (support_key, event_id)
) STRICT;
`;

/**
 * What the B1d reader queries: a claim's semantics and support by claim id, a
 * subject's assertions in validity order, and live-at-time selection, whose
 * status half lives on `claims` and is covered here by (status, valid_from).
 */
const CLAIM_V2_INDEXES = `
CREATE INDEX IF NOT EXISTS claim_v2_semantics_by_subject
  ON claim_v2_semantics(subject_kind, subject_id, valid_from);
CREATE INDEX IF NOT EXISTS claim_v2_support_by_claim
  ON claim_v2_support(claim_id, admitted_at);
CREATE INDEX IF NOT EXISTS claim_v2_support_events_by_event
  ON claim_v2_support_events(event_id);
CREATE INDEX IF NOT EXISTS claims_by_status_valid_from
  ON claims(status, valid_from);
`;

/** Additive and idempotent: safe on a fresh ledger and on a re-run. */
export function applyClaimV2Tables(db: Database): void {
  db.exec(CLAIM_V2_SEMANTICS);
  db.exec(CLAIM_V2_SUPPORT);
  db.exec(CLAIM_V2_SUPPORT_EVENTS);
  db.exec(CLAIM_V2_INDEXES);
}
