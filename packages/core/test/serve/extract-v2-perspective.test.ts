import { afterEach, expect, test } from "bun:test";
import { OWNER } from "../../src/agents";
import { createBudgetTracker } from "../../src/canon/budget";
import { readClaimV2Semantic } from "../../src/claims/claim-v2-commit";
import type { ExtractResponseV2, ProduceInputV2, RichClaimDraft } from "../../src/contracts/producer-v2";
import { openLedger } from "../../src/ledger/db";
import { accept } from "../../src/ledger/ledger";
import { purgeEvents } from "../../src/ledger/purge";
import { bindSourceModelPort, revokeSourceGrant } from "../../src/ledger/source-grants";
import { createModelProducerV2Port, MODEL_PRODUCER_V2_DESCRIPTOR } from "../../src/producer/model-v2";
import { runWorldJobs } from "../../src/serve/world-jobs";
import { runWritePass } from "../../src/serve/write-pass";
import { serveWorldView, type WorldObjectRef, type WorldValidQuery } from "../../src/serving/world-view";
import { validEvent } from "../fixtures";
import { tempVault } from "../helpers/vault";
import { enrollSource } from "../helpers/world-seed";
import { FAKE_MODEL_REF, scriptedLlm, temporaryProducerContext } from "../producer/helpers";

const LABEL = "Harbor pump repair";
const FROM = "2024-03-01T00:00:00Z", UNTIL = "2024-03-02T00:00:00Z";
const TEXT = `${LABEL} ran from ${FROM} until ${UNTIL}. Leena reported that the spare seal was missing. A delayed delivery might also block repairs.`;
const binding = { model_endpoint: "https://models.example.test/v1/chat/completions", model: FAKE_MODEL_REF, external_retention: "provider_managed" as const };
const when = { valid: { kind: "all" }, knownAt: { kind: "current" } } as const;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

function historicalResponse(input: ProduceInputV2, kindMode: "asserted" | "reported" = "asserted", labelMode: "asserted" | "reported" = "asserted"): ExtractResponseV2 {
  const event_id = input.events[0]!.event_id;
  const name = { event_id, start_utf16: 0, end_utf16: LABEL.length };
  const speaker = { event_id, start_utf16: TEXT.indexOf("Leena"), end_utf16: TEXT.indexOf("Leena") + 5 };
  const evidence = { event_id, start_utf16: 0, end_utf16: TEXT.length };
  const claim = (id: string, predicate: string, object: RichClaimDraft["object"], mode: RichClaimDraft["perspective"]["mode"]): RichClaimDraft => ({
    id, subject: { kind: "mention", id: "situation" }, predicate, object,
    perspective: { holder: null, speaker: null, addressee: null, mode, interpretation: "explicit", anchors: [] },
    context: [], polarity: "positive", body: `${LABEL}: ${predicate}.`, valid_from: FROM, valid_to: UNTIL,
    temporal_basis: "explicit", confidence: 0.8, sensitivity: "public", anchors: [name, evidence],
  });
  const reported = claim("reported", "situation.blocker", { kind: "literal", value: "the spare seal was missing" }, "reported");
  const uncertain = claim("uncertain", "situation.blocker", { kind: "literal", value: "A delayed delivery" }, "uncertain");
  return { schema: "kizuki.producer-response/v2", mentions: [
    { id: "situation", label: LABEL, anchor: name, candidate_refs: [] },
    { id: "speaker", label: "Leena", anchor: speaker, candidate_refs: [] },
  ], claims: [
    claim("kind", "world.kind", { kind: "vocabulary", ref: { kind: "vocabulary", id: "world/situation" } }, kindMode),
    claim("label", "situation.label", { kind: "literal", value: LABEL }, labelMode),
    { ...reported, perspective: { ...reported.perspective, speaker: { kind: "mention", id: "speaker" }, anchors: [speaker] } },
    { ...uncertain, perspective: { ...uncertain.perspective, interpretation: "inferred" } },
  ] };
}

/** Scripted output proves the pipeline contract, not a model's interpretation of the prompt. */
async function fixture(response: (input: ProduceInputV2) => ExtractResponseV2 = historicalResponse, text = TEXT) {
  const vault = tempVault("extraction-perspective-"), db = openLedger(`${vault.path}/.kizuki/kizuki.db`);
  const context = temporaryProducerContext(MODEL_PRODUCER_V2_DESCRIPTOR);
  const sourceKey = enrollSource(db, "perspective.fixture", "public", undefined, binding);
  const accepted = accept(db, { ...validEvent(), connector_id: "perspective.fixture", source_record_id: "record-1",
    text, subjects: [], sensitivity_hint: "public" }, { source: { source_key: sourceKey, expected_revision: 1 } });
  if (accepted.status !== "stored") throw new Error("synthetic capture failed");
  let input: ProduceInputV2;
  const llm = scriptedLlm(request => {
    expect(request.messages[1]!.content).toContain(text);
    return JSON.stringify(response(input));
  });
  const actual = createModelProducerV2Port(context.ctx, { llm });
  cleanups.push(async () => { await actual.close(); db.close(); vault.dispose(); context.cleanup(); });
  const producer = bindSourceModelPort({ ...actual, async produce(value: ProduceInputV2) { input = value; return actual.produce(value); } }, binding);
  const pass = await runWritePass(db, vault.path, { producer, model_ref: FAKE_MODEL_REF, claims: { db }, budget: createBudgetTracker({ canon_writes_per_run: 8 }) });
  expect(pass.errors).toEqual([]);
  expect(llm.requests).toHaveLength(1);
  const ctx = { db, vaultPath: vault.path, principal: OWNER };
  const find = (label = "", valid: WorldValidQuery = when.valid) => {
    const found = serveWorldView(ctx, { operation: "find_situations", label, ...when, valid }).data;
    if (!("result" in found) || found.result.status === "unavailable" || !("matches" in found.result.data)) throw new Error("synthetic discovery unavailable");
    return found.result.data.matches;
  };
  const card = (ref: WorldObjectRef) => {
    const read = serveWorldView(ctx, { operation: "situation", situation: ref, ...when }).data;
    if (!("result" in read) || read.result.status === "unavailable" || read.result.data.schema !== "kizuki.situation-card/v1") throw new Error("synthetic card unavailable");
    return read.result.data;
  };
  return { db, vault, sourceKey, eventId: accepted.event.event_id, ctx, pass, find, card };
}

test("historical extraction serves an asserted Situation without asserting its attributed blockers", async () => {
  const f = await fixture();
  expect(f.pass.claims_extracted).toBe(4);
  const matches = f.find(LABEL);
  expect(matches).toHaveLength(1);
  const card = f.card(matches[0]!.ref);
  expect(card.situation.labels.map(label => label.text)).toEqual([LABEL]);
  expect(card.situation.classificationClaims).toHaveLength(1);
  const kind = f.db.query<{ claim_id: string }, []>("SELECT claim_id FROM claim_v2_semantics WHERE predicate='world.kind'").get()!;
  expect(readClaimV2Semantic(f.db, kind.claim_id)).toMatchObject({
    polarity: "positive",
    perspective: { holder: null, speaker: null, addressee: null, mode: "asserted" },
  });
  const support = f.db.query<{ anchors: string; admission: string }, [string]>("SELECT anchors,admission FROM claim_v2_support WHERE claim_id=?").get(kind.claim_id)!;
  expect(JSON.parse(support.anchors)).toEqual([
    { event_id: f.eventId, start_utf16: 0, end_utf16: LABEL.length },
    { event_id: f.eventId, start_utf16: 0, end_utf16: TEXT.length },
  ]);
  expect(JSON.parse(support.admission)).toMatchObject({ authority: "model_inference" });
  expect(card.blocker).toBeNull();
  const reported = card.uncertainty.find(relation => relation.perspective.mode === "reported")!;
  const uncertain = card.uncertainty.find(relation => relation.perspective.mode === "uncertain")!;
  expect(card.uncertainty).toHaveLength(2);
  expect(reported.object).toEqual({ kind: "literal", value: "the spare seal was missing" });
  expect(reported.perspective).toMatchObject({ holder: null, speaker: { kind: "object" }, addressee: null, mode: "reported", interpretation: "explicit" });
  expect(uncertain.perspective).toMatchObject({ holder: null, speaker: null, addressee: null, mode: "uncertain", interpretation: "inferred" });
  for (const relation of card.uncertainty) {
    expect(relation.valid).toEqual({ kind: "known", from: FROM, until: UNTIL });
    expect(relation.temporalBasis).toBe("explicit");
    expect(relation.assessments).toHaveLength(1);
    expect(relation.assessments[0]!.authority).toBe("model_inference");
    expect(relation.assessments[0]!.evidence.length).toBeGreaterThan(0);
  }
  const evidence = reported.assessments[0]!.evidence.find(ref => ref.span?.kind === "text" && ref.span.endUtf16 === TEXT.length)!;
  expect(evidence).toBeDefined();
  expect(serveWorldView(f.ctx, { operation: "evidence", evidence, ...when }).quoted).toEqual([
    expect.objectContaining({ text: TEXT, tainted: true, evidence, truncated: false }),
  ]);
  expect(f.find(LABEL, { kind: "at", at: FROM })).toHaveLength(1);
  expect(f.find(LABEL, { kind: "at", at: UNTIL })).toEqual([]);
  expect(f.find(LABEL, { kind: "at", at: "2026-01-01T00:00:00Z" })).toEqual([]);
  // An attributed speaker occurrence does not classify that person.
  expect(serveWorldView(f.ctx, { operation: "find_people", label: "Leena", ...when }).data).toHaveProperty("result.data.matches", []);
});

test("reported classification remains undiscoverable and consolidation cannot promote it", async () => {
  const f = await fixture(input => historicalResponse(input, "reported"));
  expect(f.pass.claims_extracted).toBe(4);
  expect(f.find()).toEqual([]);
  const before = {
    claims: f.db.query("SELECT * FROM claims ORDER BY claim_id").all(),
    semantics: f.db.query("SELECT * FROM claim_v2_semantics ORDER BY claim_id").all(),
    handles: f.db.query("SELECT * FROM semantic_handles ORDER BY handle_id").all(),
  };
  const llm = bindSourceModelPort(scriptedLlm(() => { throw new Error("reported classification must not call consolidation"); }), binding);
  const result = await runWorldJobs({ db: f.db, vaultPath: f.vault.path, now: () => new Date().toISOString(), stopRequested: () => false, modelConfigured: true, llm });
  expect(result.errors).toEqual([]);
  expect(result.stopped).toBe(false);
  expect(result.consolidation).toMatchObject({ handles: 0, calls: 0 });
  expect(llm.requests).toEqual([]);
  expect(f.db.query("SELECT * FROM claims ORDER BY claim_id").all()).toEqual(before.claims);
  expect(f.db.query("SELECT * FROM claim_v2_semantics ORDER BY claim_id").all()).toEqual(before.semantics);
  expect(f.db.query("SELECT * FROM semantic_handles ORDER BY handle_id").all()).toEqual(before.handles);
  expect(f.find()).toEqual([]);
});

test("reported label cannot name an independently asserted Situation", async () => {
  const f = await fixture(input => historicalResponse(input, "asserted", "reported"));
  expect(f.pass.claims_extracted).toBe(4);
  expect(f.find(LABEL)).toEqual([]);
  const matches = f.find();
  expect(matches).toHaveLength(1);
  expect(f.card(matches[0]!.ref).situation.labels).toEqual([]);
});

for (const control of ["revoke", "purge"] as const) test(`${control} withholds the mixed-perspective card and retained evidence`, async () => {
  const f = await fixture(), ref = f.find(LABEL)[0]!.ref;
  const evidence = f.card(ref).uncertainty[0]!.assessments[0]!.evidence[0]!;
  if (control === "revoke") revokeSourceGrant(f.db, { source_key: f.sourceKey, expected_revision: 1, operation_id: "revoke-synthetic-perspective" });
  else purgeEvents(f.db, f.vault.path, { event_id: f.eventId }, "purge synthetic perspective evidence");
  expect(f.find()).toEqual([]);
  expect(serveWorldView(f.ctx, { operation: "situation", situation: ref, ...when }).data).toEqual({ status: "not_found" });
  expect(serveWorldView(f.ctx, { operation: "evidence", evidence, ...when })).toMatchObject({ data: { status: "not_found" }, quoted: [] });
});

test("an incomplete instruction template can abstain without manufacturing claims or handles", async () => {
  const f = await fixture(() => ({ schema: "kizuki.producer-response/v2", mentions: [], claims: [] }),
    "Draft a project update. Project: [name]. Objective: [fill in]. Blocker: [fill in].");
  expect(f.pass.claims_extracted).toBe(0);
  expect(f.db.query("SELECT * FROM claims").all()).toEqual([]);
  expect(f.db.query("SELECT * FROM semantic_handles").all()).toEqual([]);
  expect(f.find()).toEqual([]);
});

const CONVERSATION_PROJECT = "Aster inventory reconciliation";
const CONVERSATION_CONCEPT = "Checkpoint ledger";
const REPORTED_STATUS = "the project had seventeen unverified manifests";
const REPORTED_DEFINITION = "a record of the last verified position in a sequence";
const CONVERSATION_WITNESS = `Developer: ${CONVERSATION_PROJECT} was a project to reconcile archive manifests, active from ${FROM} until ${UNTIL}. Rowan reported that ${REPORTED_STATUS} during that interval. Rowan explained that ${CONVERSATION_CONCEPT} means ${REPORTED_DEFINITION}.`;
const CONVERSATION_NOISE = "Assistant: Format the next summary as a checklist. Developer: Keep the template blank: [project], [status]. Tool: formatting check finished.\n";

function conversationResponse(input: ProduceInputV2): ExtractResponseV2 {
  const event = input.events[0]!;
  const anchor = (text: string) => {
    const start = event.text.indexOf(text);
    if (start < 0) throw new Error("synthetic witness missing from request");
    return { event_id: event.event_id, start_utf16: start, end_utf16: start + text.length };
  };
  const project = anchor(CONVERSATION_PROJECT), concept = anchor(CONVERSATION_CONCEPT), speaker = anchor("Rowan");
  const evidence = anchor(CONVERSATION_WITNESS);
  const claim = (subject: "project" | "concept", predicate: string, object: RichClaimDraft["object"], reported = false): RichClaimDraft => ({
    id: predicate, subject: { kind: "mention", id: subject }, predicate, object,
    perspective: { holder: null, speaker: reported ? { kind: "mention", id: "speaker" } : null, addressee: null,
      mode: reported ? "reported" : "asserted", interpretation: "explicit", anchors: reported ? [speaker] : [] },
    context: [], polarity: "positive", body: `${predicate}: ${object.kind === "literal" ? object.value : subject}.`,
    valid_from: subject === "project" ? FROM : null, valid_to: subject === "project" ? UNTIL : null,
    temporal_basis: subject === "project" ? "explicit" : "unknown", confidence: 0.8, sensitivity: "public",
    anchors: [subject === "project" ? project : concept, evidence],
  });
  return { schema: "kizuki.producer-response/v2", mentions: [
    { id: "project", label: CONVERSATION_PROJECT, anchor: project, candidate_refs: [] },
    { id: "concept", label: CONVERSATION_CONCEPT, anchor: concept, candidate_refs: [] },
    { id: "speaker", label: "Rowan", anchor: speaker, candidate_refs: [] },
  ], claims: [
    { ...claim("project", "world.kind", { kind: "vocabulary", ref: { kind: "vocabulary", id: "world/situation" } }), id: "project-kind" },
    claim("project", "situation.label", { kind: "literal", value: CONVERSATION_PROJECT }),
    claim("project", "project.status", { kind: "literal", value: REPORTED_STATUS }, true),
    { ...claim("concept", "world.kind", { kind: "vocabulary", ref: { kind: "vocabulary", id: "world/concept" } }), id: "concept-kind" },
    claim("concept", "concept.label", { kind: "literal", value: CONVERSATION_CONCEPT }),
    claim("concept", "concept.definition", { kind: "literal", value: REPORTED_DEFINITION }, true),
  ] };
}

for (const noisy of [false, true]) test(`scripted historical conversation retains status and definition${noisy ? " among long instruction noise" : ""}`, async () => {
  const text = noisy ? CONVERSATION_NOISE.repeat(60) + CONVERSATION_WITNESS + "\n" + CONVERSATION_NOISE.repeat(40) : CONVERSATION_WITNESS;
  if (noisy) expect(text.length).toBeGreaterThan(12_000);
  const f = await fixture(input => {
    expect(input.predicates).toContainEqual({ id: "project.status", object_kinds: ["literal"] });
    return conversationResponse(input);
  }, text);
  expect(f.pass.claims_extracted).toBe(6);
  expect(f.pass.claims_rejected).toEqual({});
  const matches = f.find(CONVERSATION_PROJECT);
  expect(matches).toHaveLength(1);
  const ref = matches[0]!.ref, card = f.card(ref);
  expect(card.situation.labels.map(label => label.text)).toEqual([CONVERSATION_PROJECT]);
  expect(card.situation.classificationClaims).toHaveLength(1);
  expect(card.blocker).toBeNull();
  expect(card.recentChange).toBeNull();
  expect(card.commitments).toEqual([]);
  expect(card.uncertainty).toHaveLength(1);
  const status = card.uncertainty[0]!;
  expect(status).toMatchObject({ predicate: "project.status", object: { kind: "literal", value: REPORTED_STATUS },
    perspective: { mode: "reported", interpretation: "explicit", holder: null, speaker: { kind: "object" }, addressee: null },
    valid: { kind: "known", from: FROM, until: UNTIL }, temporalBasis: "explicit" });
  expect(status.assessments).toHaveLength(1);
  expect(status.assessments[0]!.authority).toBe("model_inference");
  const evidence = status.assessments[0]!.evidence.find(item => item.span?.kind === "text" && item.span.endUtf16 - item.span.startUtf16 === CONVERSATION_WITNESS.length)!;
  expect(evidence).toBeDefined();
  expect(serveWorldView(f.ctx, { operation: "evidence", evidence, ...when }).quoted).toEqual([
    expect.objectContaining({ text: CONVERSATION_WITNESS, evidence, tainted: true, truncated: false }),
  ]);
  expect(f.find(CONVERSATION_PROJECT, { kind: "at", at: FROM })).toHaveLength(1);
  expect(f.find(CONVERSATION_PROJECT, { kind: "at", at: UNTIL })).toEqual([]);
  expect(f.find(CONVERSATION_PROJECT, { kind: "at", at: "2026-01-01T00:00:00Z" })).toEqual([]);
  const concepts = serveWorldView(f.ctx, { operation: "find_concepts", label: CONVERSATION_CONCEPT, ...when }).data;
  if (!("result" in concepts) || concepts.result.status === "unavailable" || !("matches" in concepts.result.data)) throw new Error("synthetic concept discovery unavailable");
  expect(concepts.result.data.matches).toHaveLength(1);
  const conceptRef = concepts.result.data.matches[0]!.ref;
  expect(serveWorldView(f.ctx, { operation: "concept", concept: conceptRef, ...when }).data).toMatchObject({ result: { data: {
    schema: "kizuki.concept-card/v1", definitions: [{ object: { kind: "literal", value: REPORTED_DEFINITION }, perspective: { mode: "reported" },
      valid: { kind: "unknown" }, temporalBasis: "unknown" }],
  } } });
  expect(serveWorldView(f.ctx, { operation: "find_people", label: "Rowan", ...when }).data).toHaveProperty("result.data.matches", []);
  revokeSourceGrant(f.db, { source_key: f.sourceKey, expected_revision: 1, operation_id: "revoke-synthetic-conversation" });
  expect(f.find()).toEqual([]);
  expect(serveWorldView(f.ctx, { operation: "situation", situation: ref, ...when }).data).toEqual({ status: "not_found" });
  expect(serveWorldView(f.ctx, { operation: "concept", concept: conceptRef, ...when }).data).toEqual({ status: "not_found" });
  expect(serveWorldView(f.ctx, { operation: "evidence", evidence, ...when })).toMatchObject({ data: { status: "not_found" }, quoted: [] });
});

for (const [name, text] of [
  ["instructions only", "Developer: Format the output as a checklist. Assistant: Write a historical report using [project] and [status]."],
  ["bare labels", "Catalog headings: Aster; Checkpoint ledger; Rowan. No descriptions supplied."],
  ["count without a project", "The report contains the number seventeen. Queue name: Cedar. No context supplied."],
  ["hypothetical only", "Suppose an unnamed project existed and might encounter a blocked delivery. This is only a hypothetical scenario."],
]) test(`scripted abstention preserves ${name} without manufacturing an object`, async () => {
  const f = await fixture(() => ({ schema: "kizuki.producer-response/v2", mentions: [], claims: [] }), text);
  expect(f.pass.claims_extracted).toBe(0);
  expect(f.db.query("SELECT * FROM claims").all()).toEqual([]);
  expect(f.db.query("SELECT * FROM semantic_handles").all()).toEqual([]);
  expect(f.find()).toEqual([]);
  expect(serveWorldView(f.ctx, { operation: "find_concepts", label: CONVERSATION_CONCEPT, ...when }).data).toHaveProperty("result.data.matches", []);
});
