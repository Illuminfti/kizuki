import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { addAgent, authenticate, OWNER_AGENT_GRANT } from "../../src/agents";
import { applyCanonWrite } from "../../src/canon/apply";
import { undoReceipt } from "../../src/canon/undo";
import { worldCanonTarget } from "../../src/canon/world-materialization";
import { insertClaim } from "../../src/claims/store";
import { activeWorldRegistry } from "../../src/contracts/world-vocabulary";
import { EXTRACT_RESPONSE_V2_SCHEMA, type ProduceInputV2, type RichClaimDraft } from "../../src/contracts/producer-v2";
import { accept } from "../../src/ledger/ledger";
import { purgeEvents } from "../../src/ledger/purge";
import { revokeSourceGrant } from "../../src/ledger/source-grants";
import { prepareWorldDrafts } from "../../src/producer/world-drafts";
import { serveCorrect } from "../../src/serving/correct";
import { serveWorldView } from "../../src/serving/world-view";
import { collectReadFrames } from "../../src/world/pipeline/frame";
import { ulid } from "../../src/util/ulid";
import { validEvent } from "../fixtures";
import { budget } from "../canon/helpers";
import { completeEmptyWorldSummaries, EMPTY_SUMMARY_MODEL } from "../helpers/world-consolidation";
import { personFixture, ADA, PERSON_WHEN } from "../helpers/person-fixture";

const DOMAIN = "topic:posters";
beforeEach(() => setSystemTime(new Date("2030-01-01T00:00:00.000Z")));
afterEach(() => setSystemTime());
async function fixture() {
  const f = await personFixture(undefined, { model: EMPTY_SUMMARY_MODEL });
  await f.write("world.kind", { kind: "vocabulary", ref: { kind: "vocabulary", id: "world/concept" } }, { subject: DOMAIN });
  await f.write("concept.label", { kind: "literal", value: "Poster design" }, { subject: DOMAIN });
  return f;
}

function draft(f: Awaited<ReturnType<typeof fixture>>, metadata: Record<string, unknown> = {}) {
  const stored = accept(f.db, { ...validEvent(), connector_id: "card.fixture", source_record_id: ulid(),
    text: "Ada visited one page about poster design.", sensitivity_hint: "public", metadata,
    subjects: [ADA, DOMAIN].map(subject_id => ({ subject_id, role: "about" as const })),
  }, { source: { source_key: f.sourceKey, expected_revision: 1 } });
  if (stored.status !== "stored") throw Error("interest evidence missing");
  const event = stored.event, anchor = { event_id: event.event_id, start_utf16: 0, end_utf16: event.text.length };
  const input: ProduceInputV2 = { events: [{ event_id: event.event_id, text: event.text }],
    supplied_refs: ["person", "domain"].map(id => ({ id, anchors: [anchor] })), vocabulary_refs: [], predicates: [],
    budget: { max_calls: 1, max_input_tokens: 1000, max_output_tokens: 1000 } };
  const claim: RichClaimDraft = { id: "interest", subject: { kind: "supplied", id: "person" }, predicate: "person.interest",
    object: { kind: "subject", ref: { kind: "supplied", id: "domain" } },
    perspective: { holder: null, speaker: null, addressee: null, mode: "asserted", interpretation: "explicit", anchors: [] },
    context: [], polarity: "positive", body: "Possible interest in poster design, based on one visit.",
    valid_from: null, valid_to: null, temporal_basis: "unknown", confidence: 0.8, sensitivity: "public", anchors: [anchor] };
  const prepared = prepareWorldDrafts({ schema: EXTRACT_RESPONSE_V2_SCHEMA, mentions: [], claims: [claim] }, input, {
    events: [{ ...event, accepted_at: f.db.query<{ accepted_at: string }, [string]>("SELECT accepted_at FROM events WHERE event_id=?").get(event.event_id)!.accepted_at,
      source_key: f.sourceKey, subjects: [f.ref(ADA), f.ref(DOMAIN)] }],
    supplied_refs: new Map([["person", f.ref(ADA)], ["domain", f.ref(DOMAIN)]]), model_ref: "synthetic-interest-model",
  });
  expect(prepared.dropped).toEqual([]);
  if (prepared.drafts.length !== 1) throw Error("interest draft missing");
  return { input: prepared.drafts[0]!, event };
}

const interests = (f: Awaited<ReturnType<typeof fixture>>) => f.readPerson().perspectives.flatMap(group => group.relations)
  .filter(relation => relation.predicate === "person.interest");

test("one page visit becomes a source-backed, uncertain interest on the public Person card", async () => {
  const f = await fixture();
  try {
    const one = draft(f);
    await insertClaim({ db: f.db }, one.input);
    const relations = interests(f);
    expect(relations).toHaveLength(1);
    expect(relations[0]!.perspective).toMatchObject({ mode: "uncertain", interpretation: "inferred" });
    expect(relations[0]!.valid).toEqual({ kind: "unknown" });
    expect(relations[0]!.object.kind).toBe("node");
    expect(relations[0]!.assessments).toHaveLength(1);
    expect(relations[0]!.assessments[0]!.authority).toBe("model_inference");
    const evidence = relations[0]!.assessments[0]!.evidence[0]!;
    expect(serveWorldView(f.ctx, { operation: "evidence", evidence, ...PERSON_WHEN }).quoted[0]?.text).toBe(one.event.text);
    expect(activeWorldRegistry().kind("person")?.offeredToProducer).toBe(false);
    expect(activeWorldRegistry().offered.vocabulary.some(row => row.predicate === "person.interest")).toBe(false);
  } finally { f.dispose(); }
}, 120_000);

test("interest replay and copied attention never promote the hypothesis or manufacture independent support", async () => {
  const f = await fixture();
  try {
    const one = draft(f);
    await insertClaim({ db: f.db }, one.input);
    const counts = () => f.db.query("SELECT (SELECT count(*) FROM claims) AS claims, (SELECT count(*) FROM claim_v2_support) AS supports").get();
    const before = counts();
    await insertClaim({ db: f.db }, one.input);
    expect(counts()).toEqual(before);
    const copy = draft(f, { copied_from: one.event.event_id });
    await insertClaim({ db: f.db }, copy.input);
    const relations = interests(f);
    expect(relations).toHaveLength(1);
    expect(relations[0]!.perspective).toMatchObject({ interpretation: "inferred", mode: "uncertain" });
    expect(relations[0]!.assessments).toHaveLength(2);
    expect(relations[0]!.assessments.filter(item => item.independence === "independent")).toHaveLength(1);
    expect(relations[0]!.assessments.some(item => item.independence === "dependent")).toBe(true);
    expect(relations[0]!.assessments.every(item => item.authority === "model_inference")).toBe(true);
    expect(f.readPerson().roles).toEqual([]);
  } finally { f.dispose(); }
}, 120_000);

test("the shared writer refuses asserted source interest and wrong endpoint kinds without allocated claims", async () => {
  const f = await fixture();
  try {
    const one = draft(f).input;
    const before = f.db.query("SELECT (SELECT count(*) FROM claims) AS claims, (SELECT count(*) FROM semantic_allocations) AS allocations").get();
    for (const semantic of [
      { ...one.semantic, perspective: { ...one.semantic.perspective, interpretation: "explicit" as const, mode: "asserted" as const } },
      { ...one.semantic, object: { kind: "subject" as const, ref: f.ref(ADA) } },
      { ...one.semantic, object: { kind: "literal" as const, value: "poster design" } },
    ]) {
      await expect(insertClaim({ db: f.db }, { ...one, semantic, world_admission: { ...one.world_admission, semantic } })).rejects.toThrow();
      expect(f.db.query("SELECT (SELECT count(*) FROM claims) AS claims, (SELECT count(*) FROM semantic_allocations) AS allocations").get()).toEqual(before);
    }
  } finally { f.dispose(); }
}, 120_000);

test("owner correction supersedes an interest hypothesis and receipted undo restores its qualifications", async () => {
  const f = await fixture();
  try {
    const one = draft(f), stored = await insertClaim({ db: f.db }, one.input);
    if (stored.outcome !== "stored") throw Error("interest claim missing");
    applyCanonWrite({ db: f.db, vault_path: f.ctx.vaultPath }, [stored.claim], worldCanonTarget(f.db, stored.claim.claim_id), { writer: "loop", budget: budget() });
    const prior = interests(f)[0]!;
    const corrected = await serveCorrect(f.ctx, { statement: "That visit did not indicate an interest in poster design.",
      target: { world_claim: prior.claim }, mode: "retract" });
    const next = interests(f);
    expect(next).toHaveLength(1);
    expect(next[0]!.claim.token).not.toBe(prior.claim.token);
    expect(next[0]!.polarity).toBe("negative");
    expect(next[0]!.perspective).toMatchObject({ interpretation: "explicit", mode: "uncertain" });
    expect(next[0]!.assessments[0]!.epistemicKind).toBe("owner_assertion");
    expect(corrected.data?.receipt_id).toBeString();
    await undoReceipt({ db: f.db, vault_path: f.ctx.vaultPath }, corrected.data!.receipt_id!);
    expect(interests(f)).toEqual([prior]);
  } finally { f.dispose(); }
}, 120_000);

test.each(["revocation", "purge"] as const)("%s removes interest evidence and invalidates the retained Person view", async cause => {
  const f = await fixture();
  try {
    const one = draft(f);
    await insertClaim({ db: f.db }, one.input);
    await completeEmptyWorldSummaries(f.db, f.ctx.vaultPath);
    const request = { operation: "person", person: f.personRef, ...PERSON_WHEN }, initial = serveWorldView(f.ctx, request).data;
    if (!("result" in initial) || initial.result.status !== "current") throw Error("interest baseline missing");
    if (cause === "revocation") revokeSourceGrant(f.db, { source_key: f.sourceKey, expected_revision: 1, operation_id: "interest-revoke" });
    else purgeEvents(f.db, f.ctx.vaultPath, { event_id: one.event.event_id }, "interest-purge");
    expect(serveWorldView(f.ctx, { ...request, priorView: initial.result.view }).data).toMatchObject({ result: { status: "new_view_required" } });
    if (cause === "purge") expect(interests(f)).toEqual([]);
    else expect(serveWorldView(f.ctx, request).data).toEqual({ status: "not_found" });
  } finally { f.dispose(); }
}, 120_000);

test("an interest in a forbidden domain changes neither public Person bytes nor charged work", async () => {
  const f = await fixture();
  try {
    const agent = addAgent(f.db, "person-only", { ...OWNER_AGENT_GRANT, ceiling: "public", subjects: [ADA], rate_limit_per_minute: 1000 });
    const reader = { ...f.ctx, principal: authenticate(f.db, agent.token)! };
    await completeEmptyWorldSummaries(f.db, f.ctx.vaultPath);
    const request = { operation: "person", person: f.findPerson("Ada", reader), ...PERSON_WHEN };
    const initial = serveWorldView(reader, request).data;
    if (!("result" in initial) || initial.result.status !== "current") throw Error("private-domain baseline missing");
    const priorView = initial.result.view;
    const observe = () => collectReadFrames(() => serveWorldView(reader, { ...request, priorView }));
    const before = observe(), one = draft(f);
    await insertClaim({ db: f.db }, one.input);
    await completeEmptyWorldSummaries(f.db, f.ctx.vaultPath);
    const after = observe();
    expect(after.result).toEqual(before.result);
    expect(after.frames.map(frame => frame.stats)).toEqual(before.frames.map(frame => frame.stats));
    expect(interests(f)).toHaveLength(1);
    purgeEvents(f.db, f.ctx.vaultPath, { event_id: one.event.event_id }, "hidden-interest-purge");
    const purged = observe();
    expect(purged.result).toEqual(before.result);
    expect(purged.frames.map(frame => frame.stats)).toEqual(before.frames.map(frame => frame.stats));
  } finally { f.dispose(); }
}, 120_000);
