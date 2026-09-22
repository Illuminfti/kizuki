import type { Database } from "bun:sqlite";
import { tableColumns, tableExists } from "../ledger/schema";
import { LedgerStoreError } from "../ledger/errors";

/** Ledger32: identity bookkeeping, never a second semantic truth store. */
export const WORLD_TABLE_COLUMNS = {
  claim_occurrences: [
    "occurrence_id",
    "event_id",
    "content_hash_version",
    "event_content_hash",
    "text_hash",
    "origin_binding",
    "accepted_at",
    "source_key",
    "start_utf16",
    "end_utf16",
  ],
  semantic_handles: ["handle_id"],
  semantic_bindings: ["raw_kind", "raw_namespace", "raw_id", "handle_id"],
  semantic_allocations: [
    "receipt_id",
    "handle_id",
    "support_key",
    "allocated_at",
  ],
  world_authorization_namespaces: [
    "namespace_id",
    "principal_id",
    "authorization",
  ],
  world_wire_refs: ["namespace_id", "wire_ref", "ref_kind"],
  world_wire_object_targets: ["namespace_id", "wire_ref", "handle_id"],
  world_wire_claim_targets: ["namespace_id", "wire_ref", "claim_id"],
  world_wire_admission_targets: ["namespace_id", "wire_ref", "support_key"],
  world_wire_event_version_targets: [
    "namespace_id",
    "wire_ref",
    "event_id",
    "content_hash_version",
    "content_hash",
    "text_hash",
    "origin_binding",
    "accepted_at",
  ],
  world_wire_principal_targets: ["namespace_id", "wire_ref", "principal_id"],
} as const;
export type WorldTable = keyof typeof WORLD_TABLE_COLUMNS;
export const WORLD_TABLES = Object.keys(WORLD_TABLE_COLUMNS) as WorldTable[];

export function assertWorldSchema(db: Database): void {
  for (const table of WORLD_TABLES) {
    const columns = tableColumns(db, table);
    if (
      !tableExists(db, table) ||
      WORLD_TABLE_COLUMNS[table].some((column) => !columns.includes(column))
    )
      throw new LedgerStoreError("corrupt", `world storage missing ${table}`);
  }
  if (
    !tableColumns(db, "claims").includes("is_world_typed") ||
    !tableColumns(db, "claim_v2_support").includes("support_origin")
  )
    throw new LedgerStoreError(
      "corrupt",
      "world storage discriminator missing",
    );
}

export function applyWorldTables(db: Database): void {
  if (tableColumns(db, "claims").includes("is_world_typed")) {
    assertWorldSchema(db);
    return;
  }
  // Genuine historical writers may omit the opt-in staging signature column.
  // Preserve their native uniqueness rule without enabling staging migration.
  const stagingSignatureFilter = tableColumns(db, "claims").includes("content_hash")
    ? "AND (content_hash IS NULL OR content_hash='')"
    : "";
  db.exec(`
    ALTER TABLE claims ADD COLUMN is_world_typed INTEGER NOT NULL DEFAULT 0 CHECK(is_world_typed IN (0,1));
    DROP INDEX claims_idempotency;
    CREATE UNIQUE INDEX claims_idempotency ON claims(kind,coalesce(target,''),body_hash)
      WHERE status='live' AND kind<>'purge_review' ${stagingSignatureFilter} AND is_world_typed=0;
    CREATE TABLE claim_occurrences (
      occurrence_id TEXT PRIMARY KEY CHECK(length(occurrence_id)=64 AND occurrence_id NOT GLOB '*[^0-9a-f]*'),
      event_id TEXT NOT NULL REFERENCES events(event_id) ON DELETE CASCADE,
      content_hash_version INTEGER NOT NULL,
      event_content_hash TEXT NOT NULL CHECK(length(event_content_hash)=64 AND event_content_hash NOT GLOB '*[^0-9a-f]*'),
      text_hash TEXT NOT NULL CHECK(length(text_hash)=64 AND text_hash NOT GLOB '*[^0-9a-f]*'),
      origin_binding TEXT NOT NULL, accepted_at TEXT NOT NULL, source_key TEXT,
      start_utf16 INTEGER NOT NULL CHECK(start_utf16>=0),
      end_utf16 INTEGER NOT NULL CHECK(end_utf16>start_utf16),
      UNIQUE(event_id,start_utf16,end_utf16)
    ) STRICT;
    CREATE INDEX claim_occurrences_event ON claim_occurrences(event_id);
    ALTER TABLE claim_v2_support ADD COLUMN support_origin TEXT NOT NULL DEFAULT 'source'
      CHECK(support_origin IN ('source','native_owner') AND
        ((support_origin='source' AND source_key<>'native-owner') OR
         (support_origin='native_owner' AND source_key='native-owner' AND grant_revision=0)));
    CREATE TABLE semantic_handles (
      handle_id TEXT PRIMARY KEY CHECK(length(handle_id)=32 AND handle_id NOT GLOB '*[^0-9a-f]*')
    ) STRICT;
    CREATE TABLE semantic_bindings (
      raw_kind TEXT NOT NULL CHECK(raw_kind IN ('occurrence','supplied')),
      raw_namespace TEXT NOT NULL CHECK(length(raw_namespace)<=2048),
      raw_id TEXT NOT NULL CHECK(length(raw_id) BETWEEN 1 AND 1024),
      handle_id TEXT NOT NULL UNIQUE REFERENCES semantic_handles(handle_id) ON DELETE CASCADE,
      PRIMARY KEY(raw_kind,raw_namespace,raw_id)
    ) STRICT;
    CREATE TABLE semantic_allocations (
      receipt_id TEXT PRIMARY KEY CHECK(length(receipt_id)=32 AND receipt_id NOT GLOB '*[^0-9a-f]*'),
      handle_id TEXT NOT NULL REFERENCES semantic_handles(handle_id) ON DELETE CASCADE,
      support_key TEXT NOT NULL REFERENCES claim_v2_support(support_key) ON DELETE CASCADE,
      allocated_at TEXT NOT NULL,
      UNIQUE(handle_id,support_key)
    ) STRICT;
    CREATE INDEX semantic_allocations_support ON semantic_allocations(support_key);
    CREATE TABLE world_authorization_namespaces (
      namespace_id TEXT PRIMARY KEY CHECK(length(namespace_id)=32 AND namespace_id NOT GLOB '*[^0-9a-f]*'),
      principal_id TEXT NOT NULL UNIQUE,
      authorization TEXT NOT NULL CHECK(length(authorization)<=16384)
    ) STRICT;
    CREATE TABLE world_wire_refs (
      namespace_id TEXT NOT NULL REFERENCES world_authorization_namespaces(namespace_id) ON DELETE CASCADE,
      wire_ref TEXT NOT NULL CHECK(length(wire_ref)=43 AND wire_ref NOT GLOB '*[^A-Za-z0-9_-]*' AND substr(wire_ref,43,1) GLOB '[AEIMQUYcgkosw048]'),
      ref_kind TEXT NOT NULL CHECK(ref_kind IN ('object','claim','admission','event_version','principal')),
      PRIMARY KEY(namespace_id,wire_ref),
      UNIQUE(namespace_id,wire_ref,ref_kind)
    ) STRICT;
    CREATE TABLE world_wire_object_targets (
      namespace_id TEXT NOT NULL, wire_ref TEXT NOT NULL,
      handle_id TEXT NOT NULL REFERENCES semantic_handles(handle_id) ON DELETE CASCADE,
      FOREIGN KEY(namespace_id,wire_ref) REFERENCES world_wire_refs(namespace_id,wire_ref) ON DELETE CASCADE,
      PRIMARY KEY(namespace_id,wire_ref), UNIQUE(namespace_id,handle_id)
    ) STRICT;
    CREATE TABLE world_wire_claim_targets (
      namespace_id TEXT NOT NULL, wire_ref TEXT NOT NULL,
      claim_id TEXT NOT NULL REFERENCES claims(claim_id) ON DELETE CASCADE,
      FOREIGN KEY(namespace_id,wire_ref) REFERENCES world_wire_refs(namespace_id,wire_ref) ON DELETE CASCADE,
      PRIMARY KEY(namespace_id,wire_ref), UNIQUE(namespace_id,claim_id)
    ) STRICT;
    CREATE TABLE world_wire_admission_targets (
      namespace_id TEXT NOT NULL, wire_ref TEXT NOT NULL,
      support_key TEXT NOT NULL REFERENCES claim_v2_support(support_key) ON DELETE CASCADE,
      FOREIGN KEY(namespace_id,wire_ref) REFERENCES world_wire_refs(namespace_id,wire_ref) ON DELETE CASCADE,
      PRIMARY KEY(namespace_id,wire_ref), UNIQUE(namespace_id,support_key)
    ) STRICT;
    CREATE TABLE world_wire_event_version_targets (
      namespace_id TEXT NOT NULL, wire_ref TEXT NOT NULL,
      event_id TEXT NOT NULL REFERENCES events(event_id) ON DELETE CASCADE,
      content_hash_version INTEGER NOT NULL, content_hash TEXT NOT NULL,
      text_hash TEXT NOT NULL, origin_binding TEXT NOT NULL, accepted_at TEXT NOT NULL,
      FOREIGN KEY(namespace_id,wire_ref) REFERENCES world_wire_refs(namespace_id,wire_ref) ON DELETE CASCADE,
      PRIMARY KEY(namespace_id,wire_ref), UNIQUE(namespace_id,event_id)
    ) STRICT;
    CREATE TABLE world_wire_principal_targets (
      namespace_id TEXT NOT NULL, wire_ref TEXT NOT NULL, principal_id TEXT NOT NULL,
      FOREIGN KEY(namespace_id,wire_ref) REFERENCES world_wire_refs(namespace_id,wire_ref) ON DELETE CASCADE,
      PRIMARY KEY(namespace_id,wire_ref), UNIQUE(namespace_id,principal_id)
    ) STRICT;
    CREATE INDEX world_semantic_predicate ON claim_v2_semantics(predicate,polarity,subject_kind,subject_id);
    CREATE INDEX world_semantic_object ON claim_v2_semantics(json_extract(payload,'$.object.ref.kind'),json_extract(payload,'$.object.ref.id'));
    CREATE TRIGGER world_agent_revoked AFTER UPDATE OF revoked_at,quarantined_at ON agents
      WHEN NEW.revoked_at IS NOT NULL OR NEW.quarantined_at IS NOT NULL
    BEGIN DELETE FROM world_authorization_namespaces WHERE principal_id=NEW.agent_id; END;
    CREATE TRIGGER world_agent_deleted AFTER DELETE ON agents
    BEGIN DELETE FROM world_authorization_namespaces WHERE principal_id=OLD.agent_id; END;
    CREATE TRIGGER world_grant_changed AFTER UPDATE ON agent_grants
    BEGIN DELETE FROM world_authorization_namespaces WHERE principal_id=NEW.agent_id; END;
    CREATE TRIGGER world_grant_deleted AFTER DELETE ON agent_grants
    BEGIN DELETE FROM world_authorization_namespaces WHERE principal_id=OLD.agent_id; END;
    CREATE TRIGGER semantic_binding_occurrence_cleanup AFTER DELETE ON semantic_bindings WHEN OLD.raw_kind='occurrence'
    BEGIN DELETE FROM claim_occurrences WHERE occurrence_id=OLD.raw_id; END;
    CREATE TRIGGER semantic_allocations_cleanup AFTER DELETE ON semantic_allocations
    BEGIN
      DELETE FROM semantic_handles WHERE handle_id=OLD.handle_id
        AND NOT EXISTS(SELECT 1 FROM semantic_allocations WHERE handle_id=OLD.handle_id);
    END;
    CREATE TRIGGER world_support_event_erased AFTER DELETE ON claim_v2_support_events
    BEGIN
      DELETE FROM world_wire_refs WHERE (namespace_id,wire_ref) IN
        (SELECT namespace_id,wire_ref FROM world_wire_event_version_targets WHERE event_id=OLD.event_id);
    END;
    CREATE TRIGGER world_support_erased AFTER DELETE ON claim_v2_support
    BEGIN
      DELETE FROM claim_v2_semantics WHERE claim_id=OLD.claim_id
        AND NOT EXISTS(SELECT 1 FROM claim_v2_support WHERE claim_id=OLD.claim_id);
    END;
    CREATE TRIGGER world_semantic_erased AFTER DELETE ON claim_v2_semantics
    BEGIN
      DELETE FROM world_wire_refs WHERE (namespace_id,wire_ref) IN
        (SELECT namespace_id,wire_ref FROM world_wire_claim_targets WHERE claim_id=OLD.claim_id);
      DELETE FROM semantic_allocations WHERE support_key IN
        (SELECT support_key FROM claim_v2_support WHERE claim_id=OLD.claim_id);
    END;
    CREATE TRIGGER world_claim_purge AFTER UPDATE OF status ON claims WHEN NEW.status='purged'
    BEGIN
      DELETE FROM world_wire_refs WHERE (namespace_id,wire_ref) IN
        (SELECT namespace_id,wire_ref FROM world_wire_claim_targets WHERE claim_id=NEW.claim_id);
      DELETE FROM semantic_allocations WHERE support_key IN
        (SELECT support_key FROM claim_v2_support WHERE claim_id=NEW.claim_id);
    END;
  `);
  for (const kind of [
    "object",
    "claim",
    "admission",
    "event_version",
    "principal",
  ] as const) {
    db.exec(`CREATE TRIGGER world_wire_${kind}_kind BEFORE INSERT ON world_wire_${kind}_targets
      WHEN NOT EXISTS(SELECT 1 FROM world_wire_refs WHERE namespace_id=NEW.namespace_id AND wire_ref=NEW.wire_ref AND ref_kind='${kind}')
      BEGIN SELECT RAISE(ABORT,'world reference kind mismatch'); END;`);
    db.exec(`CREATE TRIGGER world_wire_${kind}_cleanup AFTER DELETE ON world_wire_${kind}_targets
      BEGIN DELETE FROM world_wire_refs WHERE namespace_id=OLD.namespace_id AND wire_ref=OLD.wire_ref; END;`);
  }
}
