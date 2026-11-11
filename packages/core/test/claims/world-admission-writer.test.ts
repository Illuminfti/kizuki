import { expect, test } from "bun:test";
import { CLAIM_V2_SCHEMA, type ClaimV2Assertion } from "../../src/contracts/claim-v2";
import { admissionIdentityConflict, readClaimRecord } from "../../src/claims/claim-v2-commit";
import { AdmissionConflictError, ClaimError } from "../../src/claims/errors";
import { semanticKey } from "../../src/claims/claim-v2-keys";
import { mintOccurrenceId } from "../../src/claims/occurrences";
import { prepareClaimInsert,insertClaim } from "../../src/claims/store";
import { registerConnection } from "../../src/ledger/connections";
import { openLedger } from "../../src/ledger/db";
import { accept } from "../../src/ledger/ledger";
import { recordNativeCorrection } from "../../src/correction/evidence";
import { bindLocalSourcePort, setSourceGrant } from "../../src/ledger/source-grants";
import { seedConnectorSensitivity } from "../../src/sensitivity/store";
import { ulid } from "../../src/util/ulid";
import { removeWorldSchema } from "../helpers/world-schema";
import { validEvent } from "../fixtures";
import { FixtureVectorPort } from "./helpers";

function fixture(withWorldTables: boolean) {
  const db = openLedger(":memory:");
  if (!withWorldTables) {removeWorldSchema(db);db.exec("UPDATE schema_version SET version=31");}
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

function suppliedSemantic(db: ReturnType<typeof fixture>["db"], sourceKey: string, eventId: string): ClaimV2Assertion {
  const event = db.query<{ connector_id: string }, [string]>("SELECT connector_id FROM events WHERE event_id=?").get(eventId)!;
  return { schema: CLAIM_V2_SCHEMA, discriminator: "assertion", predicate: "role.holds",
    object: { kind: "literal", value: "partnerships lead" }, perspective: { holder: null, speaker: null, addressee: null, mode: "asserted", interpretation: "explicit", anchors: [] },
    context: [], polarity: "positive", valid_from: "2026-01-01T00:00:00.000Z", valid_to: null, temporal_basis: "explicit", anchors: [{ event_id: eventId, start_utf16: 0, end_utf16: 5 }],
    subject: { kind: "supplied", id: "person:ada", namespace: { connector_id: event.connector_id, source_key: sourceKey } } };
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
    await expect(prepareClaimInsert({ db }, input(db, sourceKey, eventId))).rejects.toThrow("migration_required");
    expect(db.query<{ n: number }, []>("SELECT count(*) AS n FROM claims").get()?.n).toBe(0);
  } finally { db.close(); }
});

test("a native correction is a separate support contribution and forged native support fails", async () => {
  const { db, eventId, sourceKey } = fixture(true);
  try {
    const initialSemantic = suppliedSemantic(db, sourceKey, eventId);
    const initialInput = input(db, sourceKey, eventId);
    const initial = await insertClaim({ db }, { ...initialInput, semantic: initialSemantic,
      world_admission: { ...initialInput.world_admission, semantic: initialSemantic } });
    if (initial.outcome !== "stored") throw new Error("initial world claim missing");
    const correction = recordNativeCorrection(db, {
      ...validEvent(), connector_id: "kizuki.owner", source_record_id: `correction-${crypto.randomUUID()}`,
      text: "Grace now leads strategy.", metadata: { world_target: {
        claim_id: initial.claim.claim_id, semantic_key: semanticKey(initialSemantic), subject: initialSemantic.subject, predicate: initialSemantic.predicate,
      } },
    }, "a".repeat(64));
    const corrected = { ...initialSemantic, object: { kind: "literal" as const, value: "strategy lead" }, valid_from: "2026-01-02T00:00:00.000Z",
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


test("typed world admission never sends its normalized empty v1 body to semantic dedup", async () => {
  const { db, eventId, sourceKey } = fixture(true);
  const retrieval = bindLocalSourcePort(new FixtureVectorPort(), { store_id: "local:typed-admission" });
  let semanticCalls = 0;
  retrieval.search = async () => { semanticCalls++; throw new Error("typed admission must use its exact semantic identity"); };
  try {
    const first = await insertClaim({ db, retrieval }, input(db, sourceKey, eventId));
    expect(first.outcome).toBe("stored");
    expect(first.dedup).toBe("structural-only");
    const repeat = await insertClaim({ db, retrieval }, input(db, sourceKey, eventId));
    expect(repeat.outcome).toBe("duplicate");
    expect(semanticCalls).toBe(0);
  } finally { db.close(); }
});

function supportCount(db: ReturnType<typeof fixture>["db"]): number {
  return db.query<{ n: number }, []>("SELECT count(*) AS n FROM claim_v2_support").get()!.n;
}

test("admission identity ignores only the retained rendering and confidence", () => {
  const anchor = { event_id: "01J00000000000000000000000", start_utf16: 0, end_utf16: 4 };
  const meaning = { predicate: "concept.label", anchors: [anchor], perspective: { mode: "asserted", anchors: [] } };
  const first = { schema: "kizuki.world-admission/v1", semantic: meaning, rendering: { body: "Flux is a concept.", frontmatter: {} },
    authority: "model_inference", confidence: 0.8, epistemicKind: "model_inference" };
  const stored = JSON.stringify(first);
  expect(admissionIdentityConflict(stored, first)).toEqual([]);
  expect(admissionIdentityConflict(stored, { ...first, rendering: { body: "Flux names a concept.", frontmatter: { tone: "plain" } }, confidence: 0.2 })).toEqual([]);
  // The stored bytes are not the comparison: another key order is the same admission.
  expect(admissionIdentityConflict(JSON.stringify(Object.fromEntries(Object.entries(first).reverse())), first)).toEqual([]);
  // Every other field is identity, including where inside the semantic an anchor sits.
  expect(admissionIdentityConflict(stored, { ...first, schema: "kizuki.world-admission/v2" })).toEqual(["schema"]);
  expect(admissionIdentityConflict(stored, { ...first, semantic: { ...meaning, anchors: [], perspective: { mode: "asserted", anchors: [anchor] } } })).toEqual(["semantic"]);
  expect(admissionIdentityConflict(stored, { ...first, semantic: { ...meaning, perspective: { mode: "quoted", anchors: [] } } })).toEqual(["semantic"]);
  expect(admissionIdentityConflict(stored, { ...first, authority: "owner_authored", epistemicKind: "owner_assertion" })).toEqual(["authority", "epistemicKind"]);
  expect(admissionIdentityConflict(stored, { ...first, grounding: [] })).toEqual(["grounding"]);
  // A field this build does not know, or a row that is not an admission object, fails closed.
  expect(admissionIdentityConflict(JSON.stringify({ ...first, taint: "quoted" }), first)).toEqual(["taint"]);
  expect(admissionIdentityConflict("not json", first)).toEqual(["admission"]);
  expect(admissionIdentityConflict("[]", first)).toEqual(["admission"]);
});

test("replaying identical world support changes no row", async () => {
  const { db, eventId, sourceKey } = fixture(true);
  try {
    const first = await insertClaim({ db, now: () => "2026-01-02T00:00:00.000Z" }, input(db, sourceKey, eventId));
    const stored = db.query<{ admission: string; admitted_at: string }, []>("SELECT admission, admitted_at FROM claim_v2_support").get();
    const changes = db.query<{ n: number }, []>("SELECT total_changes() AS n").get()!.n;
    const again = await insertClaim({ db, now: () => "2026-01-03T00:00:00.000Z" }, input(db, sourceKey, eventId));
    expect(again).toMatchObject({ outcome: "duplicate", claim: { claim_id: first.outcome === "stored" ? first.claim.claim_id : "" } });
    expect(db.query<{ n: number }, []>("SELECT total_changes() AS n").get()!.n).toBe(changes);
    expect(supportCount(db)).toBe(1);
    expect(db.query("SELECT admission, admitted_at FROM claim_v2_support").get()).toEqual(stored);
  } finally { db.close(); }
});

test("rephrased rendering or another model confidence over the same support keeps the first immutable admission", async () => {
  const { db, eventId, sourceKey } = fixture(true);
  try {
    await insertClaim({ db }, input(db, sourceKey, eventId));
    const stored = db.query<{ admission: string }, []>("SELECT admission FROM claim_v2_support").get()!.admission;
    const base = input(db, sourceKey, eventId);
    const rephrased = await insertClaim({ db }, { ...base, confidence: 0.3,
      world_admission: { ...base.world_admission, rendering: { body: "Grace runs partnerships.", frontmatter: {} } } });
    expect(rephrased.outcome).toBe("duplicate");
    expect(supportCount(db)).toBe(1);
    expect(db.query<{ admission: string }, []>("SELECT admission FROM claim_v2_support").get()!.admission).toBe(stored);
    expect(stored).toContain("Grace leads partnerships.");
    expect(db.query<{ n: number }, []>("SELECT count(*) AS n FROM claims").get()).toEqual({ n: 1 });
  } finally { db.close(); }
});

test("a support row serialized by an older writer in another key order still replays as the same admission", async () => {
  const { db, eventId, sourceKey } = fixture(true);
  try {
    await insertClaim({ db }, input(db, sourceKey, eventId));
    const row = db.query<{ support_key: string; admission: string }, []>("SELECT support_key, admission FROM claim_v2_support").get()!;
    const parsed = JSON.parse(row.admission) as Record<string, unknown>;
    const reordered = JSON.stringify(Object.fromEntries(Object.entries(parsed).reverse()));
    expect(reordered).not.toBe(row.admission);
    db.query("UPDATE claim_v2_support SET admission=? WHERE support_key=?").run(reordered, row.support_key);
    expect((await insertClaim({ db }, input(db, sourceKey, eventId))).outcome).toBe("duplicate");
    expect(db.query<{ admission: string }, []>("SELECT admission FROM claim_v2_support").get()!.admission).toBe(reordered);
  } finally { db.close(); }
});

test("a different assessment over the same support is still refused as an immutable admission conflict", async () => {
  const { db, eventId, sourceKey } = fixture(true);
  try {
    await insertClaim({ db }, input(db, sourceKey, eventId));
    const row = db.query<{ support_key: string; admission: string }, []>("SELECT support_key, admission FROM claim_v2_support").get()!;
    db.query("UPDATE claim_v2_support SET admission=? WHERE support_key=?")
      .run(JSON.stringify({ ...JSON.parse(row.admission), authority: "owner_authored", epistemicKind: "owner_assertion" }), row.support_key);
    const refused = await insertClaim({ db }, input(db, sourceKey, eventId)).then(() => null, (error: unknown) => error);
    expect(refused).toBeInstanceOf(AdmissionConflictError);
    expect(refused).toBeInstanceOf(ClaimError);
    expect((refused as AdmissionConflictError).fields).toEqual(["authority", "epistemicKind"]);
    expect((refused as AdmissionConflictError).support_key).toBe(row.support_key);
    expect(String((refused as Error).message)).not.toContain("Grace");
  } finally { db.close(); }
});
