import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { CLAIM_V2_SCHEMA, type ClaimV2Assertion } from "../../src/contracts/claim-v2";
import { recordNativeCorrection } from "../../src/correction/evidence";
import { ensureClaimOccurrences, mintOccurrenceId, validateStoredClaimOccurrences, validateWorldEndpointProofs, type OccurrenceEventIdentity } from "../../src/claims/occurrences";
import { registerConnection } from "../../src/ledger/connections";
import { openLedger } from "../../src/ledger/db";
import { accept } from "../../src/ledger/ledger";
import { setSourceGrant } from "../../src/ledger/source-grants";
import { seedConnectorSensitivity } from "../../src/sensitivity/store";
import { ulid } from "../../src/util/ulid";
import { applyWorldTables } from "../../src/world/schema";
import { validEvent } from "../fixtures";

type StoredEvent = OccurrenceEventIdentity & { readonly text: string };

function grantSource(db: Database, connectorId = "fixture"): string {
  const sourceKey = ulid();
  registerConnection(db, connectorId, sourceKey);
  seedConnectorSensitivity(db, { connector_id: connectorId, source_key: sourceKey }, {
    default_sensitivity: "personal", sensitivity_floor: "personal",
  });
  setSourceGrant(db, {
    source_key: sourceKey, expected_revision: 0, operation_id: `grant-${sourceKey}`,
    policy: {
      purposes: ["capture", "derive", "recall", "correction", "session"],
      allowed_fields: ["text", "subjects", "attachments", "metadata"],
      retention: "persistent_owned_until_revoked", egress: "local_only", sensitivity_floor: "personal",
    },
  });
  return sourceKey;
}

function readEvent(db: Database, eventId: string): StoredEvent {
  const event = db.query<StoredEvent, [string]>(
    "SELECT connector_id,source_record_id,event_id,content_hash_version,content_hash,text_hash,origin_binding,accepted_at,text FROM events WHERE event_id=?",
  ).get(eventId);
  if (event === null) throw new Error("fixture event was not stored");
  return event;
}

function sourceFixture() {
  const db = openLedger(":memory:");
  applyWorldTables(db);
  const sourceKey = grantSource(db);
  const accepted = accept(db, {
    ...validEvent(), connector_id: "fixture", source_record_id: `occurrence-${crypto.randomUUID()}`,
    text: "A😀B",
  }, { source: { source_key: sourceKey, expected_revision: 1 } });
  if (accepted.status !== "stored") throw new Error("source fixture event was refused");
  return { db, sourceKey, event: readEvent(db, accepted.event.event_id) };
}

function nativeFixture() {
  const db = openLedger(":memory:");
  applyWorldTables(db);
  const requestDigest = "a".repeat(64);
  const native = recordNativeCorrection(db, {
    ...validEvent(), connector_id: "kizuki.owner", source_record_id: `native-${crypto.randomUUID()}`,
    text: "A😀B", metadata: { origin: "fixture" },
  }, requestDigest);
  return { db, event: readEvent(db, native.event_id) };
}

function occurrenceSemantic(event: StoredEvent, sourceKey: string | null): ClaimV2Assertion {
  return occurrenceSemanticAt(event, sourceKey, { event_id: event.event_id, start_utf16: 1, end_utf16: 3 });
}

function occurrenceSemanticAt(event: StoredEvent, sourceKey: string | null, anchor: { readonly event_id: string; readonly start_utf16: number; readonly end_utf16: number }): ClaimV2Assertion {
  return {
    schema: CLAIM_V2_SCHEMA, discriminator: "assertion",
    subject: { kind: "occurrence", id: mintOccurrenceId(event, sourceKey, anchor) },
    predicate: "role.holds", object: { kind: "literal", value: "emoji occurrence" },
    perspective: { holder: null, speaker: null, addressee: null, mode: "asserted", interpretation: "explicit", anchors: [] },
    context: [], polarity: "positive", valid_from: "2026-01-01T00:00:00.000Z", valid_to: null,
    temporal_basis: "explicit", anchors: [anchor],
  };
}

function suppliedSemantic(event: StoredEvent, sourceKey: string): ClaimV2Assertion {
  const anchor = { event_id: event.event_id, start_utf16: 0, end_utf16: 1 };
  return {
    schema: CLAIM_V2_SCHEMA, discriminator: "assertion",
    subject: { kind: "supplied", id: "person:ada", namespace: { connector_id: event.connector_id, source_key: sourceKey } },
    predicate: "role.holds", object: { kind: "literal", value: "fixture subject" },
    perspective: { holder: null, speaker: null, addressee: null, mode: "asserted", interpretation: "explicit", anchors: [] },
    context: [], polarity: "positive", valid_from: "2026-01-01T00:00:00.000Z", valid_to: null,
    temporal_basis: "explicit", anchors: [anchor],
  };
}

function seedOccurrence(db: Database, event: StoredEvent, sourceKey: string | null): ClaimV2Assertion {
  const semantic = occurrenceSemantic(event, sourceKey);
  ensureClaimOccurrences(db, semantic, sourceKey);
  return semantic;
}

function seedStoredOccurrence(db: Database, event: StoredEvent, sourceKey: string | null): void {
  const anchor = { event_id: event.event_id, start_utf16: 1, end_utf16: 3 };
  db.query(`INSERT INTO claim_occurrences(occurrence_id,event_id,content_hash_version,event_content_hash,text_hash,origin_binding,accepted_at,source_key,start_utf16,end_utf16)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
    mintOccurrenceId(event, sourceKey, anchor), event.event_id, event.content_hash_version, event.content_hash,
    event.text_hash, event.origin_binding, event.accepted_at, sourceKey, anchor.start_utf16, anchor.end_utf16,
  );
}

function expectInvalid(db: Database): void {
  expect(() => validateStoredClaimOccurrences(db)).toThrow("stored occurrence proof is invalid");
}

test("stored source and native occurrence proofs restore when every immutable identity field matches", () => {
  const source = sourceFixture();
  const native = nativeFixture();
  try {
    seedOccurrence(source.db, source.event, source.sourceKey);
    seedStoredOccurrence(native.db, native.event, null);
    expect(() => validateStoredClaimOccurrences(source.db)).not.toThrow();
    expect(() => validateStoredClaimOccurrences(native.db)).not.toThrow();
  } finally {
    source.db.close();
    native.db.close();
  }
});

test("qualified supplied endpoints require their exact cited connector and source binding", () => {
  const fixture = sourceFixture();
  try {
    const qualified = suppliedSemantic(fixture.event, fixture.sourceKey);
    expect(validateWorldEndpointProofs(fixture.db, qualified, fixture.sourceKey)).toEqual([]);
    const legacy: ClaimV2Assertion = { ...qualified, subject: { kind: "supplied", id: "person:ada" } };
    expect(() => validateWorldEndpointProofs(fixture.db, legacy, fixture.sourceKey)).toThrow("qualified world supplied reference needs a source namespace");
    const otherSource = grantSource(fixture.db, "other-fixture");
    const wrongNamespace = suppliedSemantic(fixture.event, otherSource);
    expect(() => validateWorldEndpointProofs(fixture.db, wrongNamespace, fixture.sourceKey)).toThrow("namespaced cited event");
  } finally { fixture.db.close(); }
});

test("native endpoint proof restores from immutable target metadata without a live prior claim", () => {
  const db = openLedger(":memory:");
  applyWorldTables(db);
  const sourceKey = ulid();
  const subject = { kind: "supplied" as const, id: "person:ada", namespace: { connector_id: "fixture", source_key: sourceKey } };
  try {
    const native = recordNativeCorrection(db, {
      ...validEvent(), connector_id: "kizuki.owner", source_record_id: `native-target-${crypto.randomUUID()}`,
      text: "Ada is the fixture subject.", metadata: {
        world_target: { claim_id: ulid(), semantic_key: "a".repeat(64), subject, predicate: "role.holds" },
      },
    }, "b".repeat(64));
    const event = readEvent(db, native.event_id);
    const semantic: ClaimV2Assertion = { ...suppliedSemantic(event, sourceKey), subject };
    expect(validateWorldEndpointProofs(db, semantic, null, { restore: true })).toEqual([]);
    expect(() => validateWorldEndpointProofs(db, semantic, null)).toThrow("live attested claim");
  } finally { db.close(); }
});

test("restore rejects an occurrence whose stored source binding names another source", () => {
  const fixture = sourceFixture();
  try {
    seedOccurrence(fixture.db, fixture.event, fixture.sourceKey);
    const otherSource = grantSource(fixture.db, "other-fixture");
    const anchor = { event_id: fixture.event.event_id, start_utf16: 1, end_utf16: 3 };
    fixture.db.query("UPDATE claim_occurrences SET source_key=?,occurrence_id=?").run(otherSource, mintOccurrenceId(fixture.event, otherSource, anchor));
    expectInvalid(fixture.db);
  } finally { fixture.db.close(); }
});

test("restore rejects a native occurrence relabeled as source-backed", () => {
  const fixture = nativeFixture();
  try {
    seedStoredOccurrence(fixture.db, fixture.event, null);
    const sourceKey = grantSource(fixture.db);
    const anchor = { event_id: fixture.event.event_id, start_utf16: 1, end_utf16: 3 };
    fixture.db.query("UPDATE claim_occurrences SET source_key=?,occurrence_id=?").run(sourceKey, mintOccurrenceId(fixture.event, sourceKey, anchor));
    expectInvalid(fixture.db);
  } finally { fixture.db.close(); }
});

test("restore rejects a source occurrence relabeled as native", () => {
  const fixture = sourceFixture();
  try {
    seedOccurrence(fixture.db, fixture.event, fixture.sourceKey);
    const anchor = { event_id: fixture.event.event_id, start_utf16: 1, end_utf16: 3 };
    fixture.db.query("UPDATE claim_occurrences SET source_key=NULL,occurrence_id=?").run(mintOccurrenceId(fixture.event, null, anchor));
    expectInvalid(fixture.db);
  } finally { fixture.db.close(); }
});

test("restore rejects a corrupted content hash version snapshot", () => {
  const fixture = sourceFixture();
  try {
    seedOccurrence(fixture.db, fixture.event, fixture.sourceKey);
    fixture.db.query("UPDATE claim_occurrences SET content_hash_version=1").run();
    expectInvalid(fixture.db);
  } finally { fixture.db.close(); }
});

test("restore rejects UTF-16 offsets which split a surrogate pair", () => {
  const fixture = sourceFixture();
  try {
    seedOccurrence(fixture.db, fixture.event, fixture.sourceKey);
    const split = { event_id: fixture.event.event_id, start_utf16: 2, end_utf16: 3 };
    fixture.db.query("UPDATE claim_occurrences SET start_utf16=?,occurrence_id=?").run(split.start_utf16, mintOccurrenceId(fixture.event, fixture.sourceKey, split));
    expectInvalid(fixture.db);
  } finally { fixture.db.close(); }
});

test("restore rejects an end offset which splits a surrogate pair", () => {
  const fixture = sourceFixture();
  try {
    seedOccurrence(fixture.db, fixture.event, fixture.sourceKey);
    const split = { event_id: fixture.event.event_id, start_utf16: 1, end_utf16: 2 };
    fixture.db.query("UPDATE claim_occurrences SET end_utf16=?,occurrence_id=?").run(split.end_utf16, mintOccurrenceId(fixture.event, fixture.sourceKey, split));
    expectInvalid(fixture.db);
  } finally { fixture.db.close(); }
});

test("ASCII D, F, and u boundaries are valid occurrence offsets", () => {
  const fixture = sourceFixture();
  try {
    const accepted = accept(fixture.db, {
      ...validEvent(), connector_id: "fixture", source_record_id: `ascii-${crypto.randomUUID()}`,
      text: "ADFuB",
    }, { source: { source_key: fixture.sourceKey, expected_revision: 1 } });
    if (accepted.status !== "stored") throw new Error("ASCII fixture event was refused");
    const event = readEvent(fixture.db, accepted.event.event_id);
    const semantic = occurrenceSemanticAt(event, fixture.sourceKey, { event_id: event.event_id, start_utf16: 1, end_utf16: 4 });
    ensureClaimOccurrences(fixture.db, semantic, fixture.sourceKey);
    expect(() => validateStoredClaimOccurrences(fixture.db)).not.toThrow();
  } finally { fixture.db.close(); }
});

test("restore rejects a corrupted accepted-at snapshot", () => {
  const fixture = sourceFixture();
  try {
    seedOccurrence(fixture.db, fixture.event, fixture.sourceKey);
    fixture.db.query("UPDATE claim_occurrences SET accepted_at='2000-01-01T00:00:00.000Z'").run();
    expectInvalid(fixture.db);
  } finally { fixture.db.close(); }
});

test("restore rejects an event that fails canonical ledger integrity", () => {
  const fixture = sourceFixture();
  try {
    seedOccurrence(fixture.db, fixture.event, fixture.sourceKey);
    fixture.db.exec("DROP TRIGGER events_identity_update");
    fixture.db.query("UPDATE events SET accepted_at='2000-01-01T00:00:00.000Z' WHERE event_id=?").run(fixture.event.event_id);
    expectInvalid(fixture.db);
  } finally { fixture.db.close(); }
});

test("occurrence mint replay is idempotent", () => {
  const fixture = sourceFixture();
  try {
    const semantic = seedOccurrence(fixture.db, fixture.event, fixture.sourceKey);
    ensureClaimOccurrences(fixture.db, semantic, fixture.sourceKey);
    expect(fixture.db.query<{ count: number }, []>("SELECT count(*) AS count FROM claim_occurrences").get()?.count).toBe(1);
    expect(() => validateStoredClaimOccurrences(fixture.db)).not.toThrow();
  } finally { fixture.db.close(); }
});

test("a colliding occurrence identifier cannot be replayed with another immutable tuple", () => {
  const fixture = sourceFixture();
  try {
    seedOccurrence(fixture.db, fixture.event, fixture.sourceKey);
    const accepted = accept(fixture.db, {
      ...validEvent(), connector_id: "fixture", source_record_id: `other-occurrence-${crypto.randomUUID()}`,
      text: "A😀B",
    }, { source: { source_key: fixture.sourceKey, expected_revision: 1 } });
    if (accepted.status !== "stored") throw new Error("second source fixture event was refused");
    const otherEvent = readEvent(fixture.db, accepted.event.event_id);
    const otherSemantic = occurrenceSemantic(otherEvent, fixture.sourceKey);
    const otherId = otherSemantic.subject.kind === "occurrence" ? otherSemantic.subject.id : "";
    fixture.db.query("UPDATE claim_occurrences SET occurrence_id=?").run(otherId);
    expect(() => ensureClaimOccurrences(fixture.db, otherSemantic, fixture.sourceKey)).toThrow("occurrence identity collision has a different mint tuple");
  } finally { fixture.db.close(); }
});
