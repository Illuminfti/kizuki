import type { Database } from "bun:sqlite";
import type { WorldTableSpec } from "./registry";
import { WORLD_MIGRATION_VERSIONS } from "./versions";

/** A cached opaque reference, not receipt contents or a second temporal store. */
const DDL = `CREATE TABLE IF NOT EXISTS world_known_receipt_refs (
  namespace_id TEXT NOT NULL REFERENCES world_authorization_namespaces(namespace_id) ON DELETE CASCADE,
  claim_id TEXT NOT NULL REFERENCES claims(claim_id) ON DELETE CASCADE,
  receipt_id TEXT NOT NULL REFERENCES canon_receipts(receipt_id) ON DELETE CASCADE,
  wire_ref TEXT NOT NULL CHECK(length(wire_ref)=43),
  PRIMARY KEY(namespace_id,claim_id,receipt_id)
) STRICT;
CREATE INDEX IF NOT EXISTS world_known_receipt_lookup ON world_known_receipt_refs(namespace_id,receipt_id);
CREATE TRIGGER IF NOT EXISTS world_known_receipt_semantics_erased AFTER DELETE ON claim_v2_semantics
BEGIN DELETE FROM world_known_receipt_refs WHERE claim_id=OLD.claim_id; END;
CREATE TRIGGER IF NOT EXISTS world_known_receipt_history_erased AFTER DELETE ON claim_lifecycle_history
BEGIN DELETE FROM world_known_receipt_refs WHERE claim_id=OLD.claim_id AND receipt_id=OLD.receipt_id; END;`;
export function applyKnownRefs(db: Database): void { db.exec(DDL); }
export const KNOWN_REF_TABLE_SPECS: readonly WorldTableSpec[] = [{
  name: "world_known_receipt_refs", class: "cache", since: WORLD_MIGRATION_VERSIONS.refs,
  columns: ["namespace_id", "claim_id", "receipt_id", "wire_ref"],
  erasure: { via: "trigger", triggers: ["world_known_receipt_semantics_erased", "world_known_receipt_history_erased"] },
  create: applyKnownRefs,
}];
