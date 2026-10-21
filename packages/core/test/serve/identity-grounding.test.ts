import { insertClaim } from "../../src/claims/store";
import { readDurableExtractBatch } from "../../src/serve/extract";
import { parseWorldAdmission } from "../../src/contracts/world-admission";
import { extractionV2SystemContent, IDENTITY_GROUNDING_INSTRUCTION } from "../../src/producer/prompt-v2";
import { mineLiveDrafts, journalExtractBatch } from "../../src/serve/extract";
import { groundedWorldInput } from "../../src/serve/world-grounding";
import { DEFAULT_EXTRACTION_CONFIG } from "../../src/serve/types";
import { purgeEvents } from "../../src/ledger/purge";
import { exportVault, restoreVault } from "../../src/export";
import { expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { OWNER, OWNER_AGENT_GRANT, addAgent, authenticate } from "../../src/agents";
import { collectReadFrames } from "../../src/world/pipeline/frame";
import { createBudgetTracker } from "../../src/canon/budget";
import { EXTRACT_RESPONSE_V2_SCHEMA, PRODUCER_V2_CONTRACT, type ProduceInputV2, type ProducerV2Port, type RichClaimDraft } from "../../src/contracts/producer-v2";
import { openLedger } from "../../src/ledger/db";
import { accept } from "../../src/ledger/ledger";
import { bindSourceModelPort, bindLocalSourcePort, inspectSourceGrant, setSourceGrant, revokeSourceGrant } from "../../src/ledger/source-grants";
import { runWritePass } from "../../src/serve/write-pass";
import { readWorldView } from "../../src/serving/world-view";
import { rebuildWorldLayer } from "../../src/derived";
import { assertWorldState } from "../../src/world/integrity";
import { ulid } from "../../src/util/ulid";
import { validEvent } from "../fixtures";
import { tempVault } from "../helpers/vault";
import { enrollSource, worldSeed } from "../helpers/world-seed";
import { worldData } from "../helpers/world-correct-kit";

setDefaultTimeout(120_000);

async function fixture() {
  const vault = tempVault(), db = openLedger(join(vault.path, ".kizuki/kizuki.db"));
  const alpha = await worldSeed(db, { subject: "concept:alpha", label: "Alpha", connector: "ground.alpha" });
  const beta = await worldSeed(db, { subject: "concept:beta", label: "Beta", connector: "ground.beta", occurrence: true });
  const allowExtract = (source: string) => {
    const grant = inspectSourceGrant(db, source)!;
    setSourceGrant(db, { source_key: source, expected_revision: grant.revision, operation_id: ulid(),
      policy: { ...grant.policy, purposes: [...grant.policy.purposes, "extract"] } });
  };
  allowExtract(alpha.sourceKey); allowExtract(beta.sourceKey);
  const calls: ProduceInputV2[] = [];
  let mutate: ((input: ProduceInputV2) => void) | undefined;
  let changeResponse: ((response: { mentions: any[]; claims: RichClaimDraft[] }, input: ProduceInputV2) => void) | undefined;
  let candidateOverride: ((label: string, current: string) => string) | undefined;
  const producer = bindLocalSourcePort<ProducerV2Port>({
    descriptor: { id: "kizuki.producer.identity-fixture", kind: "producer", contract: PRODUCER_V2_CONTRACT,
      contract_minor: 0, supports: ["model"], requires_lease: false, optional_package: null },
    model_ref: "fixture:identity", health: async () => ({ status: "ready", detail: {} }), close: async () => undefined,
    async produce(input) {
      calls.push(structuredClone(input));
      mutate?.(input);
      const event = input.events.find(e => e.text.startsWith("Witness"));
      const claims: RichClaimDraft[] = [];
      const mentions: { id: string; label: string; anchor: { event_id: string; start_utf16: number; end_utf16: number }; candidate_refs: { kind: "supplied"; id: string }[] }[] = [];
      if (event) {
        for (const [i, label] of ["Alpha", "Beta"].entries()) {
          const refs = input.supplied_refs.filter(ref => ref.anchors.some(a => a.event_id !== event.event_id && input.events.find(e => e.event_id === a.event_id)?.text.startsWith(label)));
          expect(refs).toHaveLength(1);
          mentions.push({ id: `m${i}`, label, anchor: { event_id: event.event_id, start_utf16: event.text.indexOf(label), end_utf16: event.text.indexOf(label) + label.length }, candidate_refs: [{ kind: "supplied", id: candidateOverride?.(label, refs[0]!.id) ?? refs[0]!.id }] });
        }
        claims.push({ id: "identity", subject: { kind: "mention", id: "m0" }, predicate: "concept.same_as",
          object: { kind: "subject", ref: { kind: "mention", id: "m1" } },
          perspective: { holder: null, speaker: null, addressee: null, mode: "asserted", interpretation: "explicit", anchors: [] },
          context: [], polarity: "positive", body: event.text, valid_from: null, valid_to: null, temporal_basis: "unknown", confidence: 0.95,
          sensitivity: "public", anchors: [{ event_id: event.event_id, start_utf16: 0, end_utf16: event.text.length }, ...mentions.map(m => m.anchor)] });
      }
      changeResponse?.({ mentions, claims }, input);
      return { status: "ok", response: { schema: EXTRACT_RESPONSE_V2_SCHEMA, mentions, claims }, usage: { calls: 1, input_tokens: 30, output_tokens: 30 } };
    },
  }, { store_id: "local:identity-fixture" });
  const run = () => runWritePass(db, vault.path, { producer, model_ref: producer.model_ref, claims: { db }, budget: createBudgetTracker({ canon_writes_per_run: 32 }) });
  const matches = () => worldData(readWorldView({ db, vaultPath: vault.path, principal: OWNER }, { operation: "find_concepts", label: "", valid: { kind: "all" }, knownAt: { kind: "current" } })).matches;
  const witness = (text: string, options: { source?: string; copied?: boolean } = {}) => {
    const source = options.source ?? enrollSource(db, "identity.witness", "public");
    if (!inspectSourceGrant(db, source)!.policy.purposes.includes("extract")) allowExtract(source);
    const accepted = accept(db, { ...validEvent(), connector_id: "identity.witness", source_record_id: ulid(), text,
      subjects: [], sensitivity_hint: "public", ...(options.copied ? { metadata: { copied_from: "synthetic-copy" } } : {}) },
      { source: { source_key: source, expected_revision: inspectSourceGrant(db, source)!.revision } });
    if (accepted.status !== "stored") throw new Error("synthetic witness capture failed");
    return { source, event: accepted.event };
  };
  expect((await run()).errors).toEqual([]);
  return { db, vault, alpha, beta, producer, run, matches, witness, calls, mutate(fn: typeof mutate) { mutate = fn; }, candidates(fn: typeof candidateOverride) { candidateOverride = fn; }, response(fn: typeof changeResponse) { changeResponse = fn; }, close() { db.close(); vault.dispose(); } };
}

test("two independent writer-admitted sources converge while shared grounding adds no witness", async () => {
  const f = await fixture();
  try {
    expect(f.matches()).toHaveLength(2);
    f.witness("Witness one states Alpha and Beta designate the same concept.");
    const first = await f.run();
    expect(first.errors).toEqual([]);
    expect(first.claims_extracted).toBe(1);
    expect(f.matches()).toHaveLength(2);
    const card = worldData(readWorldView({ db: f.db, vaultPath: f.vault.path, principal: OWNER },
      { operation: "concept", concept: f.matches()[0].ref, valid: { kind: "all" }, knownAt: { kind: "current" } }));
    expect(card.concept.resolution).toBe("ambiguous");
    f.witness("Witness two independently identifies Beta with Alpha as one idea.");
    const second = await f.run();
    expect(second.errors).toEqual([]);
    expect(f.matches()).toHaveLength(1);
    const supports = f.db.query<{ admission: string }, []>("SELECT admission FROM claim_v2_support WHERE json_extract(admission,'$.schema')='kizuki.world-admission/v2'").all();
    expect(supports).toHaveLength(2);
    expect(supports.every(s => JSON.parse(s.admission).grounding.length === 2)).toBe(true);
    assertWorldState(f.db);
    rebuildWorldLayer(f.db);
    expect(f.matches()).toHaveLength(1);
  } finally { f.close(); }
});


test("copied statements and repeated records of one source never add independent roots", async () => {
  const f = await fixture();
  try {
    const one = f.witness("Witness one identifies Alpha and Beta as the same concept.");
    expect((await f.run()).errors).toEqual([]);
    f.witness("Witness copied account also identifies Alpha with Beta.", { copied: true });
    expect((await f.run()).errors).toEqual([]);
    f.witness("Witness further account equates Beta and Alpha again.", { source: one.source });
    expect((await f.run()).errors).toEqual([]);
    expect(f.matches()).toHaveLength(2);
    f.witness("Witness independent account treats Alpha as another name for Beta.");
    expect((await f.run()).errors).toEqual([]);
    expect(f.matches()).toHaveLength(1);
  } finally { f.close(); }
});

test("witness revoke splits a principal's component and grounding purge erases all dependent admissions", async () => {
  const f = await fixture();
  try {
    f.witness("Witness primary equates Alpha with Beta."); expect((await f.run()).errors).toEqual([]);
    const second = f.witness("Witness secondary calls Beta another name for Alpha."); expect((await f.run()).errors).toEqual([]);
    expect(f.matches()).toHaveLength(1);
    revokeSourceGrant(f.db, { source_key: second.source, expected_revision: inspectSourceGrant(f.db, second.source)!.revision, operation_id: ulid() });
    expect(f.matches()).toHaveLength(2);
    purgeEvents(f.db, f.vault.path, { event_id: f.alpha.eventId }, "synthetic grounding erasure");
    expect(f.db.query("SELECT 1 FROM claim_v2_support WHERE json_extract(admission,'$.schema')='kizuki.world-admission/v2'").get()).toBeNull();
    assertWorldState(f.db); rebuildWorldLayer(f.db);
    expect(f.matches()).toHaveLength(1);
  } finally { f.close(); }
});

test("request-local candidate capabilities cannot be replayed into another witness request", async () => {
  const f = await fixture();
  try {
    f.witness("Witness initial equates Alpha and Beta."); expect((await f.run()).errors).toEqual([]);
    const old = f.calls.at(-1)!.supplied_refs.map(r => r.id);
    f.witness("Witness fresh independently calls Beta the same concept as Alpha.");
    f.candidates((_label, current) => old.find(id => id.endsWith(current.slice(-2)))!);
    const mined = await mineLiveDrafts(f.db, f.producer);
    // Frozen v2 grammar discards unknown nominations. The writer then declines
    // this identity claim because neither endpoint has this request's proof.
    expect(mined.mined.status).toBe("ok");
    expect(journalExtractBatch(f.db, mined, f.producer.model_ref, f.producer).journaled).toBe(false);
    expect(f.matches()).toHaveLength(2);
  } finally { f.close(); }
});

test("grounding denied extraction consent stays outside the request and a mid-call revoke cannot file", async () => {
  const f = await fixture();
  try {
    const witness = f.witness("Witness active equates Alpha and Beta.");
    const before = groundedWorldInput(f.db, [witness.event], DEFAULT_EXTRACTION_CONFIG, f.producer);
    expect(before.grounding.size).toBe(2);
    const grant = inspectSourceGrant(f.db, f.alpha.sourceKey)!;
    setSourceGrant(f.db, { source_key: f.alpha.sourceKey, expected_revision: grant.revision, operation_id: ulid(),
      policy: { ...grant.policy, purposes: grant.policy.purposes.filter(p => p !== "extract") } });
    const denied = groundedWorldInput(f.db, [witness.event], DEFAULT_EXTRACTION_CONFIG, f.producer);
    expect(denied.grounding.size).toBe(0);
    expect(denied.input.events.map(e => e.event_id)).toEqual([witness.event.event_id]);
    const latest = inspectSourceGrant(f.db, f.alpha.sourceKey)!;
    setSourceGrant(f.db, { source_key: f.alpha.sourceKey, expected_revision: latest.revision, operation_id: ulid(), policy: grant.policy });
    f.mutate(() => revokeSourceGrant(f.db, { source_key: f.beta.sourceKey, expected_revision: inspectSourceGrant(f.db, f.beta.sourceKey)!.revision, operation_id: ulid() }));
    const mined = await mineLiveDrafts(f.db, f.producer);
    expect(mined.mined.status).toBe("unavailable");
    expect(f.db.query("SELECT 1 FROM extract_batches").get()).toBeNull();
    expect(f.db.query("SELECT 1 FROM claim_v2_support WHERE json_extract(admission,'$.schema')='kizuki.world-admission/v2'").get()).toBeNull();
  } finally { f.close(); }
});

test("durable grounding survives verified backup restore without reconstructing model authority", async () => {
  const f = await fixture(), output = tempVault(), destination = tempVault();
  try {
    f.witness("Witness first unites Alpha and Beta."); expect((await f.run()).errors).toEqual([]);
    f.witness("Witness second calls Beta identical to Alpha."); expect((await f.run()).errors).toEqual([]);
    const backup = join(output.path, "backup"), restored = join(destination.path, "restored");
    await exportVault(f.db, f.vault.path, backup); restoreVault(backup, restored);
    const copy = openLedger(join(restored, ".kizuki/kizuki.db"));
    try {
      assertWorldState(copy);
      const matches = worldData(readWorldView({ db: copy, vaultPath: restored, principal: OWNER },
        { operation: "find_concepts", label: "", valid: { kind: "all" }, knownAt: { kind: "current" } })).matches;
      expect(matches).toHaveLength(1);
    } finally { copy.close(); }
  } finally { f.close(); output.dispose(); destination.dispose(); }
});


test("grounding quotations and ambiguous candidate mentions cannot activate identity", async () => {
  const f = await fixture();
  try {
    f.witness("Witness nomination equates Alpha with Beta.");
    f.response((response, input) => { response.mentions[0].candidate_refs = input.supplied_refs.map(ref => ({ kind: "supplied", id: ref.id })); });
    const ambiguous = await mineLiveDrafts(f.db, f.producer);
    expect(() => journalExtractBatch(f.db, ambiguous, f.producer.model_ref, f.producer)).toThrow("identity candidate is not a host-issued endpoint");
    expect(f.db.query("SELECT 1 FROM extract_batches").get()).toBeNull();
    f.response((response, input) => {
      const ground = input.events.find(e => e.text.startsWith("Alpha"))!;
      for (const m of response.mentions) m.anchor = { event_id: ground.event_id, start_utf16: 0, end_utf16: 5 };
      response.claims[0] = { ...response.claims[0]!, anchors: [{ event_id: ground.event_id, start_utf16: 0, end_utf16: 5 }] };
    });
    const borrowed = await mineLiveDrafts(f.db, f.producer);
    expect(journalExtractBatch(f.db, borrowed, f.producer.model_ref, f.producer).journaled).toBe(false);
    expect(f.matches()).toHaveLength(2);
    expect(f.db.query("SELECT 1 FROM claim_v2_support WHERE json_extract(admission,'$.schema')='kizuki.world-admission/v2'").get()).toBeNull();
  } finally { f.close(); }
});

test("pending journals erase grounding dependencies and forged durable pins roll back", async () => {
  const f = await fixture();
  try {
    f.witness("Witness durable equates Alpha and Beta.");
    const mined = await mineLiveDrafts(f.db, f.producer);
    expect(journalExtractBatch(f.db, mined, f.producer.model_ref, f.producer).journaled).toBe(true);
    const batch = readDurableExtractBatch(f.db, f.producer)!;
    const draft = structuredClone(batch.drafts[0]!) as any;
    expect(draft.world_admission.schema).toBe("kizuki.world-admission/v2");
    const before = f.db.query<{ n: number }, []>("SELECT count(*) AS n FROM claims").get()!.n;
    draft.world_admission.grounding[0].classification.admission_hash = "0".repeat(64);
    await expect(insertClaim({ db: f.db }, draft)).rejects.toThrow("world identity grounding is unavailable");
    expect(f.db.query<{ n: number }, []>("SELECT count(*) AS n FROM claims").get()!.n).toBe(before);
    expect(parseWorldAdmission({ ...draft.world_admission, authority: "owner_authored" })).toBeNull();
    expect(parseWorldAdmission({ ...draft.world_admission, schema: "kizuki.world-admission/v1" })).toBeNull();
    purgeEvents(f.db, f.vault.path, { event_id: f.alpha.eventId }, "erase pending synthetic grounding");
    expect(JSON.stringify(f.db.query("SELECT drafts FROM extract_batches").all())).not.toContain(f.alpha.eventId);
    expect(f.db.query("SELECT 1 FROM claim_v2_support WHERE json_extract(admission,'$.schema')='kizuki.world-admission/v2'").get()).toBeNull();
  } finally { f.close(); }
});

test("catalog instructions are conditional and denied candidates change no request bytes", async () => {
  const f = await fixture();
  try {
    const witness = f.witness("Witness scoped equates Alpha and Beta.");
    const before = groundedWorldInput(f.db, [witness.event], DEFAULT_EXTRACTION_CONFIG, f.producer);
    expect(extractionV2SystemContent(before.input)).toContain(IDENTITY_GROUNDING_INSTRUCTION);
    expect(extractionV2SystemContent({ predicates: before.input.predicates, vocabulary_refs: before.input.vocabulary_refs })).not.toContain(IDENTITY_GROUNDING_INSTRUCTION);
    // These labels match but their source has never consented to extraction.
    // Neither the catalog's cap nor its deterministic request identity sees them.
    await worldSeed(f.db, { subject: "hidden:alpha", label: "Alpha", connector: "hidden.alpha" });
    await worldSeed(f.db, { subject: "hidden:beta", label: "Beta", connector: "hidden.beta" });
    const after = groundedWorldInput(f.db, [witness.event], DEFAULT_EXTRACTION_CONFIG, f.producer);
    expect(after.input).toEqual(before.input);
    expect([...after.grounding]).toEqual([...before.grounding]);
  } finally { f.close(); }
});


test("grounding model destination and retention are checked before catalog inclusion", async () => {
  const f = await fixture();
  try {
    const witness = f.witness("Witness external equates Alpha and Beta.");
    const remote = bindSourceModelPort({ ...f.producer }, { model_endpoint: "https://models.example.test/v1/chat/completions", model: "fixture", retention: "zero_retention" });
    expect(groundedWorldInput(f.db, [witness.event], DEFAULT_EXTRACTION_CONFIG, remote).grounding.size).toBe(0);
    for (const source of [f.alpha.sourceKey, f.beta.sourceKey, witness.source]) {
      const grant = inspectSourceGrant(f.db, source)!;
      setSourceGrant(f.db, { source_key: source, expected_revision: grant.revision, operation_id: ulid(), policy: { ...grant.policy,
        egress: { model_endpoint: "https://models.example.test/v1/chat/completions", model: "fixture", external_retention: "zero_retention" } } });
    }
    expect(groundedWorldInput(f.db, [witness.event], DEFAULT_EXTRACTION_CONFIG, remote).grounding.size).toBe(2);
    const mismatched = bindSourceModelPort({ ...f.producer }, { model_endpoint: "https://models.example.test/v1/chat/completions", model: "other", retention: "zero_retention" });
    expect(groundedWorldInput(f.db, [witness.event], DEFAULT_EXTRACTION_CONFIG, mismatched).grounding.size).toBe(0);
    const retained = bindSourceModelPort({ ...f.producer }, { model_endpoint: "https://models.example.test/v1/chat/completions", model: "fixture", retention: "logged_and_trained" });
    expect(groundedWorldInput(f.db, [witness.event], DEFAULT_EXTRACTION_CONFIG, retained).grounding.size).toBe(0);
  } finally { f.close(); }
});

test("historical identity cannot borrow a later witness and grounding revoke invalidates retained output", async () => {
  const f = await fixture();
  try {
    f.db.query("UPDATE claim_history_clock SET last_recorded_at='2030-01-09T00:00:00.000Z'").run();
    f.witness("Witness early equates Alpha and Beta."); expect((await f.run()).errors).toEqual([]);
    const input = { operation: "concept", concept: f.alpha.ref, valid: { kind: "all" }, knownAt: { kind: "time", at: "2030-01-09T00:00:00.000Z" } };
    const first = worldData(readWorldView({ db: f.db, vaultPath: f.vault.path, principal: OWNER }, input));
    expect(first.concept.resolution).toBe("ambiguous");
    expect(first.knownAt.kind).toBe("snapshot");
    f.witness("Witness later independently calls Beta another name for Alpha."); expect((await f.run()).errors).toEqual([]);
    const read = (knownAt: unknown) => readWorldView({ db: f.db, vaultPath: f.vault.path, principal: OWNER }, { ...input, knownAt });
    expect(worldData(read({ kind: "current" })).concept.resolution).toBe("resolved");
    expect(worldData(read(first.knownAt)).concept.resolution).toBe("ambiguous");
    revokeSourceGrant(f.db, { source_key: f.alpha.sourceKey, expected_revision: inspectSourceGrant(f.db, f.alpha.sourceKey)!.revision, operation_id: ulid() });
    expect(read(first.knownAt)).toMatchObject({ result: { status: "new_view_required" } });
    const beta = worldData(readWorldView({ db: f.db, vaultPath: f.vault.path, principal: OWNER }, { ...input, concept: f.beta.ref, knownAt: { kind: "current" } }));
    expect(beta.concept.resolution).toBe("distinct");
    expect(beta.concept.labels.map((label: any) => label.text)).toEqual(["Beta"]);
  } finally { f.close(); }
});

test("hidden grounded identity edges change no scoped card bytes or traversal work", async () => {
  const f = await fixture();
  try {
    const policy = inspectSourceGrant(f.db, f.beta.sourceKey)!;
    setSourceGrant(f.db, { source_key: f.beta.sourceKey, expected_revision: policy.revision, operation_id: ulid(), policy: { ...policy.policy, sensitivity_floor: "private" } });
    const agent = addAgent(f.db, "public-grounding-reader", { ...OWNER_AGENT_GRANT, ceiling: "public" });
    const ctx = { db: f.db, vaultPath: f.vault.path, principal: authenticate(f.db, agent.token)! };
    const ref = worldData(readWorldView(ctx, { operation: "find_concepts", label: "Alpha", valid: { kind: "all" }, knownAt: { kind: "current" } })).matches[0].ref;
    const read = () => collectReadFrames(() => readWorldView(ctx, { operation: "concept", concept: ref, valid: { kind: "all" }, knownAt: { kind: "current" } }));
    const before = read();
    f.witness("Witness first equates Alpha and Beta."); expect((await f.run()).errors).toEqual([]);
    f.witness("Witness second independently unites Beta with Alpha."); expect((await f.run()).errors).toEqual([]);
    expect(f.matches()).toHaveLength(1);
    const after = read();
    expect(worldData(after.result)).toEqual(worldData(before.result));
    expect(after.frames.map(frame => frame.stats)).toEqual(before.frames.map(frame => frame.stats));
    expect(after.frames.map(frame => frame.budget.bytes)).toEqual(before.frames.map(frame => frame.budget.bytes));
  } finally { f.close(); }
});
