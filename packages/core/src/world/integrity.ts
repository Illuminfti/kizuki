import { isUtf16TextBoundary } from "../contracts/producer-v2";
import { rawSubjectNamespace } from "../contracts/claim-v2";
import type { Database } from "bun:sqlite";
import {
  validateStoredClaimOccurrences,
  validateWorldEndpointProofs,
} from "../claims/occurrences";
import { semanticKey, supportKey } from "../claims/claim-v2-keys";
import { readClaimV2Semantic } from "../claims/claim-v2-commit";
import {
  parseWorldAdmission,
  completeWorldAnchors,
} from "../contracts/world-admission";
import { assertionEndpoints } from "./allocation";
import { readEvent } from "../ledger/ledger";
import { canonicalJson } from "../util/hash";
import { toClaimV2SemanticRow } from "../claims/claim-v2-rows";
import { WORLD_TABLES } from "./schema";
import { tableExists } from "../ledger/schema";

/** Restore/open validation: mappings are retained bookkeeping, never trusted imported authority. */
export function assertWorldState(db: Database): void {
  for (const table of WORLD_TABLES)
    if (!tableExists(db, table))
      throw new Error("world storage migration required");
  if (db.query("PRAGMA foreign_key_check").get() !== null)
    throw new Error("world foreign key integrity failed");
  for (const row of db
    .query<
      {
        support_key: string;
        claim_id: string;
        support_origin: string;
        source_key: string;
        grant_revision: number;
        anchors: string;
        admission: string;
      },
      []
    >(
      "SELECT * FROM claim_v2_support WHERE json_valid(admission) AND json_extract(admission,'$.schema')='kizuki.world-admission/v1'",
    )
    .iterate()) {
    const admission = parseWorldAdmission(JSON.parse(row.admission));
    if (admission === null) throw new Error("world admission malformed");
    const meaning = readClaimV2Semantic(db, row.claim_id);
    if (meaning === null || meaning.schema !== "kizuki.claim-meaning/v1")
      throw new Error("world meaning codec mismatch");
    const expected = toClaimV2SemanticRow(
      row.claim_id,
      admission.semantic,
      true,
    );
    const stored = db
      .query<
        Record<string, unknown>,
        [string]
      >("SELECT * FROM claim_v2_semantics WHERE claim_id=?")
      .get(row.claim_id);
    if (
      !expected.ok ||
      stored === null ||
      Object.entries(expected.value).some(
        ([key, value]) => stored[key] !== value,
      )
    )
      throw new Error("world semantic columns mismatch");
    const anchors = completeWorldAnchors(admission.semantic);
    const events = db
      .query<
        { event_id: string; event_content_hash: string },
        [string]
      >("SELECT event_id,event_content_hash FROM claim_v2_support_events WHERE support_key=? ORDER BY event_id")
      .all(row.support_key);
    if (
      events.length === 0 ||
      events.length > 64 ||
      canonicalJson(anchors) !== row.anchors ||
      (row.support_origin !== "source" &&
        row.support_origin !== "native_owner") ||
      supportKey({
        support_origin: row.support_origin,
        semantic_key: semanticKey(admission.semantic),
        source_key: row.source_key,
        grant_revision: row.grant_revision,
        events,
        anchors,
      }) !== row.support_key
    )
      throw new Error("world support identity mismatch");
    for (const identity of events) {
      const event = readEvent(db, identity.event_id);
      const source = db
        .query<
          { source_key: string },
          [string]
        >("SELECT source_key FROM source_event_bindings WHERE event_id=?")
        .get(identity.event_id);
      if (
        event === null ||
        event.content_hash !== identity.event_content_hash ||
        event.origin !== "external" ||
        (row.support_origin === "source"
          ? source?.source_key !== row.source_key
          : source !== null ||
            row.source_key !== "native-owner" ||
            row.grant_revision !== 0 ||
            event.origin_binding_kind !== "native")
      )
        throw new Error("world support event mismatch");
    }
    validateWorldEndpointProofs(
      db,
      admission.semantic,
      row.support_origin === "native_owner" ? null : row.source_key,
      { restore: true },
    );
    for (const anchor of anchors) {
      if (!events.some((event) => event.event_id === anchor.event_id))
        throw new Error("world support anchor missing");
      const event = readEvent(db, anchor.event_id);
      if (
        event === null ||
        !isUtf16TextBoundary(event.text, anchor.start_utf16) ||
        !isUtf16TextBoundary(event.text, anchor.end_utf16)
      )
        throw new Error("world support anchor outside event");
    }
  }
  validateStoredClaimOccurrences(db);
  const invalid = db
    .query(
      `SELECT 1 FROM semantic_allocations a
    JOIN semantic_bindings b USING(handle_id) JOIN claim_v2_support s USING(support_key)
    LEFT JOIN claim_v2_semantics c USING(claim_id) WHERE c.claim_id IS NULL LIMIT 1`,
    )
    .get();
  if (invalid !== null)
    throw new Error("world allocation has no semantic support");
  for (const row of db
    .query<
      {
        raw_kind: string;
        raw_namespace: string;
        raw_id: string;
        admission: string;
        claim_id: string;
      },
      []
    >(
      `SELECT b.raw_kind,b.raw_namespace,b.raw_id,s.admission,s.claim_id
    FROM semantic_allocations a JOIN semantic_bindings b USING(handle_id) JOIN claim_v2_support s USING(support_key)`,
    )
    .iterate()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.admission);
    } catch {
      throw new Error("world admission malformed");
    }
    const admission = parseWorldAdmission(parsed),
      meaning = readClaimV2Semantic(db, row.claim_id);
    if (
      admission === null ||
      meaning === null ||
      semanticKey(admission.semantic) !== semanticKey(meaning) ||
      !assertionEndpoints(admission.semantic).some(
        (ref) =>
          ref.kind === row.raw_kind &&
          ref.id === row.raw_id &&
          rawSubjectNamespace(ref) === row.raw_namespace,
      )
    )
      throw new Error("world allocation support mismatch");
  }
  if (
    db
      .query(
        `SELECT 1 FROM semantic_handles h WHERE NOT EXISTS(SELECT 1 FROM semantic_bindings b WHERE b.handle_id=h.handle_id)
    OR NOT EXISTS(SELECT 1 FROM semantic_allocations a WHERE a.handle_id=h.handle_id) LIMIT 1`,
      )
      .get() !== null
  )
    throw new Error("world handle incomplete");
  if (
    db
      .query(
        `SELECT 1 FROM world_wire_event_version_targets w JOIN events e USING(event_id)
    WHERE w.content_hash_version<>e.content_hash_version OR w.content_hash<>e.content_hash OR w.text_hash<>e.text_hash
    OR w.origin_binding<>e.origin_binding OR w.accepted_at<>e.accepted_at LIMIT 1`,
      )
      .get() !== null
  )
    throw new Error("world event identity mismatch");
  if (
    db
      .query(
        `SELECT 1 FROM world_wire_principal_targets t JOIN world_authorization_namespaces n USING(namespace_id)
    WHERE t.principal_id<>n.principal_id LIMIT 1`,
      )
      .get() !== null
  )
    throw new Error("world principal namespace mismatch");
  for (const row of db
    .query<
      { namespace_id: string; wire_ref: string; ref_kind: string },
      []
    >("SELECT namespace_id,wire_ref,ref_kind FROM world_wire_refs")
    .iterate()) {
    const table = `world_wire_${row.ref_kind}_targets`;
    if (
      !WORLD_TABLES.includes(table as (typeof WORLD_TABLES)[number]) ||
      db
        .query(`SELECT 1 FROM ${table} WHERE namespace_id=? AND wire_ref=?`)
        .get(row.namespace_id, row.wire_ref) === null
    )
      throw new Error("world reference target missing");
  }
}
