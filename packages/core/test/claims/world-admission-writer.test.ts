import { expect, test } from "bun:test";
import { CLAIM_V2_SCHEMA, type ClaimV2Assertion } from "../../src/contracts/claim-v2";
import { readClaimRecord } from "../../src/claims/claim-v2-commit";
import { semanticKey } from "../../src/claims/claim-v2-keys";
import { mintOccurrenceId } from "../../src/claims/occurrences";
import { insertClaim } from "../../src/claims/store";
import { registerConnection } from "../../src/ledger/connections";
import { openLedger } from "../../src/ledger/db";
import { accept } from "../../src/ledger/ledger";
import { recordNativeCorrection } from "../../src/correction/evidence";
import { setSourceGrant } from "../../src/ledger/source-grants";
import { seedConnectorSensitivity } from "../../src/sensitivity/store";
import { ulid } from "../../src/util/ulid";
import { applyWorldTables } from "../../src/world/schema";
import { validEvent } from "../fixtures";

function fixture(withWorldTables: boolean) {
  const db = openLedger(":memory:");
  if (withWorldTables) applyWorldTables(db);
  const sourceKey = ulid();
  registerConnection(db, "fixture", sourceKey);
  seedConnectorSensitivity(db, { connector_id: "fixture", source_key: sourceKey }, { default_sensitivity: "personal", sensitivity_floor: "personal" });
  setSourceGrant(db, { source_key: sourceKey, expected_revision: 0, operation_id: `grant-${sourceKey}`, policy: {
    purposes: ["capture", "derive", "recall", "correction", "session"], allowed_fields: ["text", "subjects", "attachments", "metadata"],
    retention: "persistent_owned_until_revoked", egress: "local_only", sensitivity_floor: "personal",
  } });
  const accepted = accept(db, { ...validEvent(), connector_id: "fixture", source_record_id: `world-${crypto.randomUUID()}`, text: "Grace leads partnerships." }, { source: { source_key: sourceKey, expected_revision: 1 } });
  if (accepted.status !== "stored") throw new Error("fixture event refused");
  return { db, eventId: accepted.event.event_id, sourceKey };
}

function semantic(db: ReturnType<typeof fixture>["db"], sourceKey: string, eventId: string): ClaimV2Assertion {
  const event = db.query<{ connector_id: string; source_record_id: string; content_hash_version: number; content_hash: string; text_hash: string; origin_binding: string; accepted_at: string }, [string]>("SELECT connector_id,source_record_id,content_hash_version,content_hash,text_hash,origin_binding,accepted_at FROM events WHERE event_id=?").get(eventId)!;
  const anchor = { event_id: eventId, start_utf16: 0, end_utf16: 5 };
  return { schema: CLAIM_V2_SCHEMA, discriminator: "assertion", predicate: "role.holds",
    object: { kind: "literal", value: "partnerships lead" }, perspective: { holder: null, speaker: null, addressee: null, mode: "asserted", interpretation: "explicit", anchors: [] },
    context: [], polarity: "positive", valid_from: "2026-01-01T00:00:00.000Z", valid_to: null, temporal_basis: "explicit", anchors: [anchor],
    subject: { kind: "occurrence", id: mintOccurrenceId({ ...event, event_id: eventId }, sourceKey, anchor) } };
}

function input(db: ReturnType<typeof fixture>["db"], sourceKey: string, eventId: string) {
  const typed = semantic(db, sourceKey, eventId);
  return { kind: "claim" as const, body: "attacker supplied body", provenance: [eventId], producer: "deterministic" as const, confidence: 1,
    semantic: typed, world_admission: { schema: "kizuki.world-admission/v1" as const, semantic: typed,
      rendering: { body: "Grace leads partnerships.", frontmatter: { source: "fixture" } }, authority: "owner_authored" as const, confidence: 1, epistemicKind: "hypothesis" as const } };
}

test("production insertion writes typed world meaning, derived admission, and endpoint receipts atomically", async () => {
  const { db, eventId, sourceKey } = fixture(true);
  try {
    const first = await insertClaim({ db, now: () => "2026-01-02T00:00:00.000Z" }, input(db, sourceKey, eventId));
    expect(first.outcome).toBe("stored");
    const claim = first.outcome === "stored" ? first.claim : null;
    if (claim === null) throw new Error("claim not stored");
    expect(claim.body).toBe("");
    expect(claim.subject).toBeNull();
    const record = readClaimRecord(db, claim.claim_id);
    expect(record?.schema).toBe(CLAIM_V2_SCHEMA);
    expect(db.query("SELECT authority,confidence,admission FROM claims JOIN claim_v2_support ON claim_v2_support.claim_id=claims.claim_id").get()).toMatchObject({ authority: "model_inference", confidence: 0.5 });
    const admission = JSON.parse((db.query<{ admission: string }, []>("SELECT admission FROM claim_v2_support").get()!).admission);
    expect(admission.authority).toBe("model_inference");
    expect(admission.confidence).toBe(0.5);
    expect(admission.epistemicKind).toBe("model_inference");
    expect(db.query<{ n: number }, []>("SELECT count(*) AS n FROM semantic_allocations").get()?.n).toBe(1);
    const repeated = await insertClaim({ db, now: () => "2026-01-02T00:00:00.000Z" }, input(db, sourceKey, eventId));
    expect(repeated).toMatchObject({ outcome: "duplicate", claim: { claim_id: claim.claim_id } });
    expect(db.query<{ n: number }, []>("SELECT count(*) AS n FROM claims").get()?.n).toBe(1);
    expect(db.query<{ n: number }, []>("SELECT count(*) AS n FROM claim_v2_support").get()?.n).toBe(1);
  } finally { db.close(); }
});

test("qualified world admission rolls back when migration 32 is absent", async () => {
  const { db, eventId, sourceKey } = fixture(false);
  try {
    await expect(insertClaim({ db }, input(db, sourceKey, eventId))).rejects.toThrow("migration_required");
    expect(db.query<{ n: number }, []>("SELECT count(*) AS n FROM claims").get()?.n).toBe(0);
  } finally { db.close(); }
});

test("a native correction is a separate support contribution and forged native support fails", async () => {
  const { db, eventId, sourceKey } = fixture(true);
  try {
    const initial = await insertClaim({ db }, input(db, sourceKey, eventId));
    if (initial.outcome !== "stored") throw new Error("initial world claim missing");
    const correction = recordNativeCorrection(db, {
      ...validEvent(), connector_id: "kizuki.owner", source_record_id: `correction-${crypto.randomUUID()}`,
      text: "Grace now leads strategy.", metadata: { taint: "owner", origin: "external" },
    }, "a".repeat(64));
    const next = semantic(db, "native-owner", correction.event_id);
    const corrected = { ...next, object: { kind: "literal" as const, value: "strategy lead" }, valid_from: "2026-01-02T00:00:00.000Z",
      anchors: [{ event_id: correction.event_id, start_utf16: 0, end_utf16: 5 }] };
    const result = await insertClaim({ db }, {
      ...input(db, "native-owner", correction.event_id), body: "Grace now leads strategy.", semantic: corrected,
      provenance: [correction.event_id], producer: "owner", intent: "correct", events: [{ event_id: correction.event_id, connector_id: "kizuki.owner", taint: "owner", text: "Grace now leads strategy." }],
      world_admission: { ...input(db, "native-owner", correction.event_id).world_admission, semantic: corrected, rendering: { body: "Grace now leads strategy.", frontmatter: {} } },
    });
    expect(result.outcome).toBe("stored");
    expect(db.query<{ support_origin: string; source_key: string; grant_revision: number }, [string]>("SELECT support_origin,source_key,grant_revision FROM claim_v2_support WHERE claim_id=?").get(result.outcome === "stored" ? result.claim.claim_id : "")).toEqual({ support_origin: "native_owner", source_key: "native-owner", grant_revision: 0 });
    const forged = accept(db, { ...validEvent(), connector_id: "kizuki.owner", source_record_id: `forged-${crypto.randomUUID()}`, text: "forged correction" });
    if (forged.status !== "stored") throw new Error("forged fixture refused");
    await expect(insertClaim({ db }, {
      ...input(db, "native-owner", forged.event.event_id), provenance: [forged.event.event_id], producer: "owner", intent: "correct",
    })).rejects.toThrow("source-bound provenance");
  } finally { db.close(); }
});
