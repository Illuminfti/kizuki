import { createObservationTables, observationTableSpecs } from "./observations";
import { backfillSupportObservations } from "../../claims/observations";
import type { Database } from "bun:sqlite";
import type { WorldTableSpec } from "./registry";

// Reserved by the current all-features task. Register only after actual FCST44.
export const TYPED_REF_MIGRATION_VERSION = 45;
export const TYPED_REF_KINDS = ["page", "source", "receipt", "raw_subject", "captured_subject", "claim_group", "observation"] as const;
export type TypedRefKind = typeof TYPED_REF_KINDS[number];
const allKinds = ["object", "claim", "admission", "event_version", "principal", ...TYPED_REF_KINDS];
const base = (kind: TypedRefKind) => `namespace_id TEXT NOT NULL, wire_ref TEXT NOT NULL,
  ref_kind TEXT NOT NULL DEFAULT '${kind}' CHECK(ref_kind='${kind}')`;
const reference = `FOREIGN KEY(namespace_id,wire_ref,ref_kind) REFERENCES world_wire_refs(namespace_id,wire_ref,ref_kind) ON DELETE CASCADE,
  PRIMARY KEY(namespace_id,wire_ref)`;

/** Cache rows bind exact retained identities; they are never evidence or grants. */
export function createTypedRefTables(db: Database): void {
  createObservationTables(db);
  db.exec(`
CREATE TABLE IF NOT EXISTS world_wire_page_targets (
  ${base("page")}, page_id TEXT NOT NULL, rel_path TEXT NOT NULL, content_hash TEXT NOT NULL,
  ${reference}, UNIQUE(namespace_id,page_id,content_hash)
) STRICT;
CREATE TABLE IF NOT EXISTS world_wire_source_targets (
  ${base("source")}, source_key TEXT REFERENCES source_grants(source_key) ON DELETE CASCADE,
  native_event_id TEXT REFERENCES events(event_id) ON DELETE CASCADE,
  CHECK((source_key IS NOT NULL AND native_event_id IS NULL) OR (source_key IS NULL AND native_event_id IS NOT NULL)),
  ${reference}, UNIQUE(namespace_id,source_key), UNIQUE(namespace_id,native_event_id)
) STRICT;
CREATE TABLE IF NOT EXISTS world_wire_receipt_targets (
  ${base("receipt")}, receipt_id TEXT NOT NULL REFERENCES canon_receipts(receipt_id) ON DELETE CASCADE,
  ${reference}, UNIQUE(namespace_id,receipt_id)
) STRICT;
CREATE TABLE IF NOT EXISTS world_wire_raw_subject_targets (
  ${base("raw_subject")}, raw_key TEXT NOT NULL CHECK(length(raw_key)=64),
  raw_ref TEXT NOT NULL CHECK(json_valid(raw_ref) AND json_type(raw_ref)='object'),
  ${reference}, UNIQUE(namespace_id,raw_key)
) STRICT;
CREATE TABLE IF NOT EXISTS world_wire_captured_subject_targets (
  ${base("captured_subject")}, event_id TEXT NOT NULL REFERENCES events(event_id) ON DELETE CASCADE,
  subject_id TEXT NOT NULL, ${reference}, UNIQUE(namespace_id,event_id,subject_id)
) STRICT;
CREATE TABLE IF NOT EXISTS world_wire_claim_group_targets (
  ${base("claim_group")}, group_key TEXT NOT NULL CHECK(length(group_key)=64),
  member_count INTEGER NOT NULL CHECK(member_count BETWEEN 2 AND 16),
  ${reference}, UNIQUE(namespace_id,group_key)
) STRICT;
CREATE TABLE IF NOT EXISTS world_wire_observation_targets (
  ${base("observation")}, observation_id TEXT NOT NULL REFERENCES world_observations(observation_id) ON DELETE CASCADE,
  ${reference}, UNIQUE(namespace_id,observation_id)
) STRICT;
CREATE TABLE IF NOT EXISTS world_wire_page_events (
  namespace_id TEXT NOT NULL, wire_ref TEXT NOT NULL,
  event_id TEXT NOT NULL REFERENCES events(event_id) ON DELETE CASCADE,
  FOREIGN KEY(namespace_id,wire_ref) REFERENCES world_wire_page_targets(namespace_id,wire_ref) ON DELETE CASCADE,
  PRIMARY KEY(namespace_id,wire_ref,event_id)
) STRICT;
CREATE TABLE IF NOT EXISTS world_wire_raw_subject_members (
  namespace_id TEXT NOT NULL, wire_ref TEXT NOT NULL,
  event_id TEXT NOT NULL REFERENCES events(event_id) ON DELETE CASCADE,
  source_key TEXT NOT NULL,
  FOREIGN KEY(namespace_id,wire_ref) REFERENCES world_wire_raw_subject_targets(namespace_id,wire_ref) ON DELETE CASCADE,
  PRIMARY KEY(namespace_id,wire_ref,event_id,source_key)
) STRICT;
CREATE TABLE IF NOT EXISTS world_wire_claim_group_members (
  namespace_id TEXT NOT NULL, wire_ref TEXT NOT NULL,
  claim_id TEXT NOT NULL REFERENCES claims(claim_id) ON DELETE CASCADE,
  FOREIGN KEY(namespace_id,wire_ref) REFERENCES world_wire_claim_group_targets(namespace_id,wire_ref) ON DELETE CASCADE,
  PRIMARY KEY(namespace_id,wire_ref,claim_id)
) STRICT;
CREATE TRIGGER IF NOT EXISTS world_wire_page_index_changed AFTER UPDATE OF rel_path,last_hash ON page_index
WHEN NEW.rel_path IS NOT OLD.rel_path OR NEW.last_hash IS NOT OLD.last_hash
BEGIN DELETE FROM world_wire_page_targets WHERE page_id=OLD.page_id; END;
CREATE TRIGGER IF NOT EXISTS world_wire_page_index_erased AFTER DELETE ON page_index
BEGIN DELETE FROM world_wire_page_targets WHERE page_id=OLD.page_id; END;
CREATE TRIGGER IF NOT EXISTS world_wire_page_event_erased AFTER DELETE ON world_wire_page_events
BEGIN DELETE FROM world_wire_page_targets WHERE namespace_id=OLD.namespace_id AND wire_ref=OLD.wire_ref; END;
CREATE TRIGGER IF NOT EXISTS world_wire_source_revoked AFTER UPDATE ON source_grants
WHEN NEW.status<>'active'
BEGIN DELETE FROM world_wire_source_targets WHERE source_key=NEW.source_key; END;
CREATE TRIGGER IF NOT EXISTS world_wire_receipt_erased AFTER UPDATE OF receipt_state ON canon_receipts
WHEN NEW.receipt_state='erased'
BEGIN DELETE FROM world_wire_receipt_targets WHERE receipt_id=NEW.receipt_id; END;
CREATE TRIGGER IF NOT EXISTS world_wire_raw_subject_occurrence_erased AFTER DELETE ON claim_occurrences
BEGIN DELETE FROM world_wire_raw_subject_targets WHERE json_extract(raw_ref,'$.kind')='occurrence' AND json_extract(raw_ref,'$.id')=OLD.occurrence_id; END;
CREATE TRIGGER IF NOT EXISTS world_wire_raw_subject_last_member AFTER DELETE ON world_wire_raw_subject_members
WHEN NOT EXISTS(SELECT 1 FROM world_wire_raw_subject_members WHERE namespace_id=OLD.namespace_id AND wire_ref=OLD.wire_ref)
BEGIN DELETE FROM world_wire_raw_subject_targets WHERE namespace_id=OLD.namespace_id AND wire_ref=OLD.wire_ref; END;
CREATE TRIGGER IF NOT EXISTS world_wire_claim_group_member_erased AFTER DELETE ON world_wire_claim_group_members
BEGIN DELETE FROM world_wire_claim_group_targets WHERE namespace_id=OLD.namespace_id AND wire_ref=OLD.wire_ref; END;
CREATE TRIGGER IF NOT EXISTS world_wire_claim_group_bounded BEFORE INSERT ON world_wire_claim_group_members
WHEN (SELECT count(*) FROM world_wire_claim_group_members WHERE namespace_id=NEW.namespace_id AND wire_ref=NEW.wire_ref)>=16
BEGIN SELECT RAISE(ABORT,'claim group exceeds bound'); END;
CREATE TRIGGER IF NOT EXISTS world_wire_captured_subject_member BEFORE INSERT ON world_wire_captured_subject_targets
WHEN NOT EXISTS(SELECT 1 FROM events e,json_each(e.subjects) s WHERE e.event_id=NEW.event_id AND json_extract(s.value,'$.subject_id')=NEW.subject_id)
BEGIN SELECT RAISE(ABORT,'captured subject membership missing'); END;
`);
  for (const kind of TYPED_REF_KINDS) db.exec(`
CREATE TRIGGER IF NOT EXISTS world_wire_${kind}_cleanup AFTER DELETE ON world_wire_${kind}_targets
BEGIN DELETE FROM world_wire_refs WHERE namespace_id=OLD.namespace_id AND wire_ref=OLD.wire_ref; END;`);
}

/** Preserve existing namespace/token identities under the owned migration hold.
 * FK enforcement must be disabled outside this transaction, then checked before
 * commit and restored by ledger/db.ts, just as for the receipt-parent rebuild. */
export function applyTypedRefs(db: Database): void {
  if (!db.inTransaction || db.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get()?.foreign_keys !== 0)
    throw new Error("typed reference rebuild requires the owned migration boundary");
  const current = db.query<{ sql: string }, []>("SELECT sql FROM sqlite_master WHERE type='table' AND name='world_wire_refs'").get();
  if (current === null) throw new Error("world reference parent missing");
  if (!current.sql.includes("'captured_subject'")) {
    const triggers = db.query<{ name: string; sql: string }, []>("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND instr(sql,'world_wire_refs')>0 ORDER BY name").all();
    for (const trigger of triggers) {
      if (!/^[A-Za-z0-9_]+$/.test(trigger.name)) throw new Error("unsupported reference trigger name");
      db.exec(`DROP TRIGGER ${trigger.name}`);
    }
    db.exec(`CREATE TABLE world_wire_refs_v45 (
      namespace_id TEXT NOT NULL REFERENCES world_authorization_namespaces(namespace_id) ON DELETE CASCADE,
      wire_ref TEXT NOT NULL CHECK(length(wire_ref)=43 AND wire_ref NOT GLOB '*[^A-Za-z0-9_-]*' AND substr(wire_ref,43,1) GLOB '[AEIMQUYcgkosw048]'),
      ref_kind TEXT NOT NULL CHECK(ref_kind IN (${allKinds.map(kind => `'${kind}'`).join(",")})),
      PRIMARY KEY(namespace_id,wire_ref), UNIQUE(namespace_id,wire_ref,ref_kind)
    ) STRICT;
    INSERT INTO world_wire_refs_v45 SELECT namespace_id,wire_ref,ref_kind FROM world_wire_refs;
    DROP TABLE world_wire_refs;
    ALTER TABLE world_wire_refs_v45 RENAME TO world_wire_refs;`);
    for (const trigger of triggers) db.exec(trigger.sql);
  }
  createTypedRefTables(db);
  backfillSupportObservations(db);
  if (db.query("PRAGMA foreign_key_check").get() !== null) throw new Error("typed reference rebuild violated foreign keys");
}

const targets: readonly [TypedRefKind, readonly string[]][] = [
  ["page", ["page_id", "rel_path", "content_hash"]], ["source", ["source_key", "native_event_id"]],
  ["receipt", ["receipt_id"]], ["raw_subject", ["raw_key", "raw_ref"]],
  ["captured_subject", ["event_id", "subject_id"]], ["claim_group", ["group_key", "member_count"]], ["observation", ["observation_id"]],
];
export const TYPED_REF_TABLE_SPECS: readonly WorldTableSpec[] = [
  ...observationTableSpecs(TYPED_REF_MIGRATION_VERSION),
  ...targets.map(([kind, columns]): WorldTableSpec => ({
    name: `world_wire_${kind}_targets`, class: "cache", since: TYPED_REF_MIGRATION_VERSION,
    columns: ["namespace_id", "wire_ref", "ref_kind", ...columns],
    erasure: { via: "cascade", parent: "world_wire_refs" }, create: createTypedRefTables,
    reset: db => { createTypedRefTables(db); db.query("DELETE FROM world_wire_refs WHERE ref_kind=?").run(kind); },
  })),
  ...([ ["page_events", "page", ["event_id"]], ["raw_subject_members", "raw_subject", ["event_id", "source_key"]], ["claim_group_members", "claim_group", ["claim_id"]] ] as const).map(([name, parent, columns]): WorldTableSpec => ({
    name: `world_wire_${name}`, class: "cache", since: TYPED_REF_MIGRATION_VERSION,
    columns: ["namespace_id", "wire_ref", ...columns], erasure: { via: "cascade", parent: `world_wire_${parent}_targets` }, create: createTypedRefTables,
  })),
];
