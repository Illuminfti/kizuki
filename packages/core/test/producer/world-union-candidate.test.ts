import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createWorldUnionCandidateRegistry, WORLD_UNION_CANDIDATE_KINDS, WORLD_UNION_CANDIDATE_EXTENSIONS } from "../../src/contracts/world-union-profile";
import { WORLD_REGISTRY, WORLD_VOCABULARY_MODULES, activeWorldRegistry, withWorldRegistry } from "../../src/contracts/world-vocabulary";
import { EXTRACT_RESPONSE_V2_SCHEMA, parseExtractResponseV2, type RichClaimDraft, type DraftRef } from "../../src/contracts/producer-v2";
import type { SubjectRef } from "../../src/contracts/event";
import type { Claim } from "../../src/contracts/proposal";
import { candidateRegistry, checkOfferedQualification, registryDigest } from "../../../../scripts/world-qualification/registry";
import { worldProduceInput } from "../../src/serve/extract-v2";
import { worldSuppliedReferences } from "../../src/serve/world-supplied";
import { extractionV2SystemContent } from "../../src/producer/prompt-v2";
import { planModelExtractionV2 } from "../../src/producer/model-v2";
import { prepareWorldDrafts } from "../../src/producer/world-drafts";
import { worldAssertionViolation, notePendingClassification } from "../../src/world/registry-check";
import { accept } from "../../src/ledger/ledger";
import { purgeEvents } from "../../src/ledger/purge";
import { insertClaim } from "../../src/claims/store";
import { applyCanonWrite } from "../../src/canon/apply";
import { worldCanonTarget } from "../../src/canon/world-materialization";
import { serveWorldView } from "../../src/serving/world-view";
import type { PersonCard } from "../../src/contracts/person-card";
import type { SituationCardV2 } from "../../src/contracts/situation-card-v2";
import { canonicalJson } from "../../src/util/hash";
import { ulid } from "../../src/util/ulid";
import { validEvent } from "../fixtures";
import { cardFixture } from "../world/card-fixture";
import { personFixture } from "../helpers/person-fixture";
import { budget } from "../canon/helpers";
import { createModelProducerV2Port, MODEL_PRODUCER_V2_DESCRIPTOR } from "../../src/producer/model-v2";
import { modelProducerFingerprint } from "../../src/producer/fingerprint";
import { scriptedLlm, temporaryProducerContext } from "./helpers";

const WORLD_UNION_CANDIDATE_REGISTRY = createWorldUnionCandidateRegistry(WORLD_VOCABULARY_MODULES);
const WHEN = { valid: { kind: "all" }, knownAt: { kind: "current" } } as const;
const literal = (value: string) => ({ kind: "literal" as const, value });
const vocabulary = (id: string) => ({ kind: "vocabulary" as const, ref: { kind: "vocabulary" as const, id } });
type Fixture = Awaited<ReturnType<typeof cardFixture>>;

function capturedBatch(f: Fixture, text: string, subjects: SubjectRef[], build: (ref: (id: string) => DraftRef, claim: (subject: string, predicate: string, object: RichClaimDraft["object"], body: string) => RichClaimDraft) => RichClaimDraft[]) {
  const stored = accept(f.db, { ...validEvent(), connector_id: "card.fixture", source_record_id: ulid(), text, subjects, sensitivity_hint: "public" },
    { source: { source_key: f.sourceKey, expected_revision: 1 } });
  if (stored.status !== "stored") throw new Error("synthetic capture missing");
  const event = stored.event, supplied = worldSuppliedReferences([event], () => f.sourceKey);
  const ref = (id: string): DraftRef => {
    const handle = [...supplied.refs].find(([, raw]) => raw.id === id)?.[0];
    if (handle === undefined) throw new Error("structured source handle missing");
    return { kind: "supplied", id: handle };
  };
  const whole = { event_id: event.event_id, start_utf16: 0, end_utf16: text.length };
  const claim = (subject: string, predicate: string, object: RichClaimDraft["object"], body: string): RichClaimDraft => {
    const endpoints = [ref(subject), ...(object.kind === "subject" ? [object.ref] : [])];
    const anchors = endpoints.flatMap(endpoint => supplied.input.find(row => row.id === endpoint.id)!.anchors);
    return { id: `c${claimsMade++}`, subject: ref(subject), predicate, object, body,
      perspective: { holder: null, speaker: null, addressee: null, mode: "asserted", interpretation: "explicit", anchors: [] },
      context: [], polarity: "positive", valid_from: null, valid_to: null, temporal_basis: "unknown", confidence: 0.8, sensitivity: "public",
      anchors: [...anchors, whole].filter((anchor, index, all) => all.findIndex(row => canonicalJson(row) === canonicalJson(anchor)) === index) };
  };
  let claimsMade = 0;
  const input = withWorldRegistry(WORLD_UNION_CANDIDATE_REGISTRY, () => worldProduceInput([event], supplied.input, { max_input_tokens: 32_000, max_output_tokens: 8_192 }));
  const { budget: _budget, ...parserInput } = input;
  const parsed = parseExtractResponseV2(JSON.stringify({ schema: EXTRACT_RESPONSE_V2_SCHEMA, mentions: [], claims: build(ref, claim) }), parserInput);
  if (!parsed.ok) throw new Error("synthetic producer payload rejected");
  expect(parsed.dropped).toEqual([]);
  const pending = new Map<string, Set<string>>();
  const prepared = prepareWorldDrafts(parsed.response, input, {
    events: [{ ...event, source_key: f.sourceKey,
      accepted_at: f.db.query<{ accepted_at: string }, [string]>("SELECT accepted_at FROM events WHERE event_id=?").get(event.event_id)!.accepted_at,
      subjects: [...supplied.refs.values()] }],
    supplied_refs: supplied.refs, model_ref: "synthetic-union-model",
    admits(semantic) {
      if (worldAssertionViolation(f.db, semantic, { registry: WORLD_UNION_CANDIDATE_REGISTRY, pending }) !== null) return false;
      notePendingClassification(pending, semantic); return true;
    },
  });
  expect(prepared.dropped).toEqual([]);
  return { event, prepared };
}

async function file(f: Fixture, prepared: ReturnType<typeof prepareWorldDrafts>) {
  const groups = new Map<string, { target: ReturnType<typeof worldCanonTarget>; claims: Claim[] }>();
  for (const draft of prepared.drafts) {
    const stored = await insertClaim({ db: f.db }, draft);
    if (stored.outcome !== "stored") throw new Error("synthetic claim not stored");
    const target = worldCanonTarget(f.db, stored.claim.claim_id), key = canonicalJson(target);
    const group = groups.get(key) ?? { target, claims: [] };
    group.claims.push(stored.claim); groups.set(key, group);
  }
  for (const group of groups.values()) applyCanonWrite({ db: f.db, vault_path: f.ctx.vaultPath }, group.claims, group.target, { writer: "loop", budget: budget() });
  expect(f.db.query<{ n: number }, []>("SELECT count(*) n FROM claims WHERE model_ref='synthetic-union-model' AND receipt_id IS NULL").get()!.n).toBe(0);
}

function data(f: Fixture, input: Record<string, unknown>) {
  const result = serveWorldView(f.ctx, { ...WHEN, ...input }).data;
  if (!("result" in result) || !("data" in result.result)) throw new Error("synthetic consumer unavailable");
  return result.result.data;
}

test("the union profile matches evaluation composition without changing defaults or acquiring approval", () => {
  const before = canonicalJson(WORLD_REGISTRY), reference = activeWorldRegistry();
  const evaluated = candidateRegistry(WORLD_VOCABULARY_MODULES, WORLD_UNION_CANDIDATE_KINDS, WORLD_UNION_CANDIDATE_EXTENSIONS);
  expect(canonicalJson(WORLD_UNION_CANDIDATE_REGISTRY)).toBe(canonicalJson(evaluated));
  expect(WORLD_UNION_CANDIDATE_REGISTRY.offered.vocabulary.filter(row => ["situation.has_commitment", "situation.has_decision", "situation.requires", "situation.enables", "situation.blocks", "situation.invalidated_by"].includes(row.predicate))).toHaveLength(6);
  expect(() => checkOfferedQualification(WORLD_UNION_CANDIDATE_REGISTRY, [])).toThrow("unqualified offered vocabulary");
  expect(() => checkOfferedQualification(WORLD_UNION_CANDIDATE_REGISTRY, [{ registry_sha256: registryDigest(WORLD_UNION_CANDIDATE_REGISTRY), report_sha256: "0".repeat(64), kinds: WORLD_UNION_CANDIDATE_KINDS, predicates: WORLD_UNION_CANDIDATE_REGISTRY.offered.vocabulary.map(row => row.predicate) }])).toThrow("unqualified offered vocabulary");
  expect(activeWorldRegistry()).toBe(reference);
  expect(canonicalJson(WORLD_REGISTRY)).toBe(before);
  expect(WORLD_REGISTRY.kinds.filter(row => row.offeredToProducer).map(row => row.id)).toEqual(["situation", "concept"]);
  expect(() => createWorldUnionCandidateRegistry(WORLD_VOCABULARY_MODULES.filter(module => module.kind?.id !== "person"))).toThrow("requires the registered kinds and extensions");
  expect(() => createWorldUnionCandidateRegistry(WORLD_VOCABULARY_MODULES.filter(module => module.kind !== null || module.predicates[0]?.predicate !== "situation.has_commitment"))).toThrow("requires the registered kinds and extensions");
});

test("the prospective production initializer has the same actual prompt and factory fingerprint without a runtime registry swap", async () => {
  const root = resolve(import.meta.dir, "../../../.."), temp = mkdtempSync(join(tmpdir(), "kizuki-union-activation-"));
  const context = temporaryProducerContext(MODEL_PRODUCER_V2_DESCRIPTOR);
  const llm = scriptedLlm(() => { throw new Error("a source-only identity check must not call a model"); });
  const port = createModelProducerV2Port(context.ctx, { llm });
  const snapshot = () => {
    const input = worldProduceInput([{ event_id: "00000000000000000000000001", text: "Neutral source." }] as never);
    return { registry: registryDigest(activeWorldRegistry()), prompt: extractionV2SystemContent(input), fingerprint: modelProducerFingerprint(port) };
  };
  const before = snapshot(), expected = withWorldRegistry(WORLD_UNION_CANDIDATE_REGISTRY, snapshot);
  try {
    const entry = join(temp, "entry.ts"), output = join(temp, "bundle.js");
    // This compiles the exact future source delta in a disposable bundle. The
    // checked-out initializer and every live/default registry remain unchanged.
    writeFileSync(entry, `
      import { activeWorldRegistry } from ${JSON.stringify(join(root, "packages/core/src/contracts/world-vocabulary.ts"))};
      import { worldProduceInput } from ${JSON.stringify(join(root, "packages/core/src/serve/extract-v2.ts"))};
      import { extractionV2SystemContent } from ${JSON.stringify(join(root, "packages/core/src/producer/prompt-v2.ts"))};
      import { createModelProducerV2Port } from ${JSON.stringify(join(root, "packages/core/src/producer/model-v2.ts"))};
      import { modelProducerFingerprint } from ${JSON.stringify(join(root, "packages/core/src/producer/fingerprint.ts"))};
      import { canonicalJson, sha256Hex } from ${JSON.stringify(join(root, "packages/core/src/util/hash.ts"))};
      const registry=activeWorldRegistry();
      const port=createModelProducerV2Port({config:{}}, {llm:{descriptor:{contract_minor:1},input_token_overhead:24000,model_ref:"source-only",complete(){throw Error("no model call");}}});
      const input=worldProduceInput([{event_id:"00000000000000000000000001",text:"Neutral source."}]);
      console.log(JSON.stringify({registry:sha256Hex(canonicalJson({kinds:registry.kinds.filter(row=>row.offeredToProducer),offered:registry.offered})),prompt:extractionV2SystemContent(input),fingerprint:modelProducerFingerprint(port)}));
    `);
    const built = await Bun.build({ entrypoints: [entry], target: "bun", outdir: temp, naming: "bundle.js", plugins: [{
      name: "prospective-source-initializer",
      setup(build) {
        build.onLoad({ filter: /[/\\]contracts[/\\]world-vocabulary\.ts$/ }, args => {
          const source = readFileSync(args.path, "utf8"), initializer = "export const WORLD_REGISTRY: WorldRegistry = createWorldRegistry(WORLD_VOCABULARY_MODULES);";
          expect(source.split(initializer)).toHaveLength(2);
          return { loader: "ts", contents: `import { createWorldUnionCandidateRegistry } from "./world-union-profile";\n` + source.replace(initializer, "export const WORLD_REGISTRY: WorldRegistry = createWorldUnionCandidateRegistry(WORLD_VOCABULARY_MODULES);") };
        });
      },
    }] });
    expect(built.success).toBe(true);
    const result = Bun.spawnSync([process.execPath, output], { env: { PATH: "/usr/bin:/bin" }, stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toEqual(expected);
    expect(snapshot()).toEqual(before);
    expect(expected.fingerprint).not.toBe(before.fingerprint);
    expect(llm.requests).toEqual([]);
  } finally { await port.close(); context.cleanup(); rmSync(temp, { recursive: true, force: true }); }
}, 120_000);

test("the actual union prompt retains Person safeguards and planner reservations fail before a call", () => {
  const result = withWorldRegistry(WORLD_UNION_CANDIDATE_REGISTRY, () => {
    const input = worldProduceInput([{ event_id: "00000000000000000000000001", text: "Neutral source." }] as never, [], { max_input_tokens: 32_000, max_output_tokens: 8_192 });
    return { input, prompt: extractionV2SystemContent(input), plan: planModelExtractionV2(input, 24_000) };
  });
  expect(result.prompt).toContain("Person subjects require direct supplied refs");
  expect(result.prompt).toContain("use mode uncertain and interpretation inferred");
  expect(result.plan.status).toBe("ready");
  if (result.plan.status !== "ready") throw new Error("union plan missing");
  expect(result.plan.reserved_input_tokens).toBe(result.plan.input_tokens + 24_000);
  withWorldRegistry(WORLD_UNION_CANDIDATE_REGISTRY, () => {
    expect(planModelExtractionV2({ ...result.input, budget: { ...result.input.budget, max_input_tokens: result.plan.status === "ready" ? result.plan.reserved_input_tokens - 1 : 0 } }, 24_000)).toMatchObject({ status: "rejected", diagnostic: { stage: "budget", rule: "max_input_tokens" } });
  });
});

test("the authorized 1000-unit window fits genuine supplied handles and additional input fails closed", () => {
  withWorldRegistry(WORLD_UNION_CANDIDATE_REGISTRY, () => {
    const names = ["Ada", "Ben", "Launch", "Prepare map", "Map format"];
    const text = (names.join("; ") + ". " + "Neutral source. ".repeat(100)).slice(0, 1000);
    const event = { ...validEvent(), event_id: "00000000000000000000000001", text,
      subjects: names.map((display_name, index) => ({ subject_id: `synthetic:${index}`, display_name, role: "about" as const })) };
    const supplied = worldSuppliedReferences([event], () => "00000000000000000000000002");
    expect(text).toHaveLength(1000);
    expect(supplied.input).toHaveLength(5);
    const input = worldProduceInput([event] as never, supplied.input, { max_input_tokens: 32_000, max_output_tokens: 8_192 });
    const plan = planModelExtractionV2(input, 24_000);
    expect(plan.status).toBe("ready");
    if (plan.status !== "ready") throw new Error("authorized neutral window did not fit");
    expect(plan.reserved_input_tokens).toBeLessThanOrEqual(32_000);
    const manyNames = Array.from({ length: 200 }, (_, index) => `P${String(index).padStart(3, "0")}`);
    const crowdedEvent = { ...event, text: (manyNames.join(" ") + " ").padEnd(1000, "."),
      subjects: manyNames.map((display_name, index) => ({ subject_id: `synthetic:${index}`, display_name, role: "about" as const })) };
    const crowdedSupplied = worldSuppliedReferences([crowdedEvent], () => "00000000000000000000000002");
    expect(crowdedSupplied.input).toHaveLength(200);
    const crowded = worldProduceInput([crowdedEvent] as never, crowdedSupplied.input, input.budget);
    expect(planModelExtractionV2(crowded, 24_000)).toMatchObject({ status: "rejected", diagnostic: { stage: "budget", rule: "max_input_tokens", limit: 32_000 } });
  });
});

test("genuine supplied attention survives parser, preparation, receipted writer and Person evidence as an uncertain inference", async () => {
  const f = await personFixture();
  try {
    const batch = capturedBatch(f, "Ada viewed one page about Bayesian updating.", [
      { subject_id: "person:ada", role: "about", display_name: "Ada" },
      { subject_id: "topic:bayes", role: "about", display_name: "Bayesian updating" },
    ], (ref, claim) => [claim("person:ada", "person.interest", { kind: "subject", ref: ref("topic:bayes") }, "Ada may be interested in Bayesian updating.")]);
    expect(batch.prepared.drafts[0]!.semantic.perspective).toMatchObject({ mode: "uncertain", interpretation: "inferred" });
    await file(f, batch.prepared);
    const card = data(f, { operation: "person", person: f.personRef }) as PersonCard;
    const interest = card.perspectives.flatMap(group => group.relations).find(relation => relation.predicate === "person.interest")!;
    expect(interest.perspective).toMatchObject({ mode: "uncertain", interpretation: "inferred" });
    expect(interest.assessments[0]).toMatchObject({ epistemicKind: "model_inference", authority: "model_inference", confidence: { kind: "known", value: 0.5 } });
    expect(interest.assessments[0]!.evidence.some(evidence => serveWorldView(f.ctx, { operation: "evidence", evidence, ...WHEN }).quoted.some(row => row.text === batch.event.text))).toBe(true);
    const prior = f.db.query("SELECT count(*) n FROM claims").get();
    const original = batch.prepared.drafts[0]!;
    const semantic = { ...original.semantic, subject: { ...original.semantic.subject, namespace: { connector_id: "card.fixture", source_key: ulid() } } };
    await expect(insertClaim({ db: f.db }, { ...original, semantic, world_admission: { ...original.world_admission, semantic } })).rejects.toThrow();
    expect(f.db.query("SELECT count(*) n FROM claims").get()).toEqual(prior);
    purgeEvents(f.db, f.ctx.vaultPath, { event_id: batch.event.event_id }, "synthetic-union-purge");
    expect(f.readPerson().perspectives.flatMap(group => group.relations).filter(relation => relation.predicate === "person.interest")).toEqual([]);
  } finally { f.dispose(); }
}, 120_000);

test("a typed episode preserves supplied parties, claimed completion, dependency endpoints and source evidence", async () => {
  const f = await cardFixture();
  try {
    const text = "The structured person Ada owes the structured person Ben the commitment Prepare map. The source claims that commitment is done and due on 2027-06-02. Map format is a reversed decision. Launch is a situation with that commitment and that decision; it requires that commitment and blocks that decision. Bayesian updating is a separate concept.";
    const names = [["person:ada", "Ada"], ["person:ben", "Ben"], ["commitment:map", "Prepare map"], ["decision:map", "Map format"], ["project:launch", "Launch"], ["topic:bayes", "Bayesian updating"]] as const;
    const batch = capturedBatch(f, text, names.map(([subject_id, display_name]) => ({ subject_id, display_name, role: "about" as const })), (ref, claim) => {
      const claims = names.slice(0, 5).flatMap(([id, label]) => {
        const kind = id.split(":")[0] === "project" ? "situation" : id.split(":")[0]!;
        return [claim(id, "world.kind", vocabulary(`world/${kind}`), `${label} is a ${kind}.`), claim(id, `${kind}.label`, literal(label), `The name is ${label}.`)];
      });
      claims.push(claim("commitment:map", "commitment.debtor", { kind: "subject", ref: ref("person:ada") }, "Ada owes the commitment."));
      claims.push(claim("commitment:map", "commitment.creditor", { kind: "subject", ref: ref("person:ben") }, "Ben is owed the commitment."));
      claims.push({ ...claim("commitment:map", "commitment.status", vocabulary("commitment/done"), "The source reports the commitment done."), perspective: { holder: null, speaker: null, addressee: null, mode: "reported", interpretation: "explicit", anchors: [] } });
      claims.push(claim("commitment:map", "commitment.due", literal("2027-06-02"), "The commitment is due on 2027-06-02."));
      claims.push(claim("decision:map", "decision.status", vocabulary("decision/reversed"), "The decision is reversed."));
      for (const [predicate, endpoint] of [["situation.has_commitment", "commitment:map"], ["situation.has_decision", "decision:map"], ["situation.requires", "commitment:map"], ["situation.blocks", "decision:map"]]) claims.push(claim("project:launch", predicate!, { kind: "subject", ref: ref(endpoint!) }, `Launch ${predicate} ${endpoint}.`));
      return claims;
    });
    await file(f, batch.prepared);
    const matches = data(f, { operation: "find_situations", label: "Launch" });
    if (!("matches" in matches)) throw new Error("situation discovery missing");
    const card = data(f, { operation: "situation", situation: matches.matches[0]!.ref, card: "kizuki.situation-card/v2" }) as SituationCardV2;
    expect(card.commitments).toHaveLength(1);
    expect(card.commitments[0]).toMatchObject({ status: "claimed_done", due: [{ object: literal("2027-06-02") }] });
    expect(card.commitments[0]!.debtor).toHaveLength(1);
    expect(card.commitments[0]!.creditor).toHaveLength(1);
    expect(card.decisions).toMatchObject([{ status: "reversed" }]);
    expect(card.dependencies.map(row => row.predicate).sort()).toEqual(["situation.blocks", "situation.requires"]);
    const party = card.commitments[0]!.debtor[0]!;
    expect(party.assessments[0]!.evidence.some(evidence => serveWorldView(f.ctx, { operation: "evidence", evidence, ...WHEN }).quoted.some(row => row.text === text))).toBe(true);
    const original = batch.prepared.drafts.find(draft => draft.semantic.predicate === "commitment.debtor")!;
    const semantic = { ...original.semantic, object: { kind: "subject" as const, ref: f.ref("topic:bayes") } };
    const count = f.db.query("SELECT count(*) n FROM claims").get();
    await expect(insertClaim({ db: f.db }, { ...original, semantic, world_admission: { ...original.world_admission, semantic } })).rejects.toMatchObject({ code: "world_endpoint_kind" });
    expect(f.db.query("SELECT count(*) n FROM claims").get()).toEqual(count);
    purgeEvents(f.db, f.ctx.vaultPath, { event_id: batch.event.event_id }, "synthetic-union-episode-purge");
    expect(data(f, { operation: "find_situations", label: "Launch" })).toMatchObject({ matches: [] });
  } finally { f.dispose(); }
}, 120_000);
