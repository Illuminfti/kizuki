import { expect, test } from "bun:test";
import { coreSemanticAssets, coreSemanticCaseInput, coreSemanticBranches, coreSemanticRulePredicates, scoreCoreSemanticRepresentations, prepareCoreSemanticObservation, validateCoreSemanticAssets, type GeneralExtractBranch } from "./core-semantic";
import { candidateRegistry } from "./registry";
import { WORLD_VOCABULARY_MODULES } from "./candidate-modules";
import { DEFAULT_QUALIFICATION_INPUT_POLICY } from "./input-planning";
import type { Observation } from "./score";
import { parseExtractResponseV2, type DraftRef, type ExtractResponseV2, type RichClaimDraft } from "../../packages/core/src/contracts/producer-v2";

type Mutable<T> = { -readonly [K in keyof T]: T[K] extends object ? Mutable<T[K]> : T[K] };
const policy = { ...DEFAULT_QUALIFICATION_INPUT_POLICY, max_input_tokens: 32_000, input_token_overhead: 24_000 };
const registry = candidateRegistry(WORLD_VOCABULARY_MODULES, ["concept", "situation"]);
function fixture(index: number) {
  const assets = coreSemanticAssets("offered17"), item = assets.corpus.cases[index + 13]!;
  const rule = assets.contract.cases[index + 13]!;
  if (rule.expectation !== "extract") throw Error("positive case expected");
  const branch = coreSemanticBranches(rule)[0] as GeneralExtractBranch;
  const input = coreSemanticCaseInput(item, registry, policy);
  const mentions = branch.entities.map((entity, i) => ({ id: `m${i}`, label: entity.label,
    anchor: { event_id: input.events[0]!.event_id, ...entity.allowed_occurrence_spans[0]! }, candidate_refs: [] }));
  const ref = (selector: GeneralExtractBranch["propositions"][number]["subject"]): DraftRef => selector.mode === "source_occurrence"
    ? { kind: "mention", id: mentions.find(row => row.label === selector.label)!.id }
    : { kind: "supplied", id: input.supplied_refs.find(row => row.anchors.some(a => input.events[0]!.text.slice(a.start_utf16, a.end_utf16) === item.records[0]!.structured_subjects!.find(s => s.subject_id === selector.subject_id)!.display_name))!.id };
  const claims: RichClaimDraft[] = branch.propositions.map((prop, i) => {
    const start = item.records[0]!.text.indexOf(prop.witness), anchor = { event_id: input.events[0]!.event_id, start_utf16: start, end_utf16: start + prop.witness.length };
    const object: RichClaimDraft["object"] = prop.object.kind === "subject" ? { kind: "subject", ref: ref(prop.object.entity) }
      : prop.object.kind === "vocabulary" ? { kind: "vocabulary", ref: { kind: "vocabulary", id: prop.object.value } }
      : { kind: "literal", value: prop.predicate.endsWith(".label") && prop.subject.mode === "source_occurrence" ? prop.subject.label : prop.witness };
    const endpoints = [ref(prop.subject), ...(prop.object.kind === "subject" ? [ref(prop.object.entity)] : []), ...prop.context.map(ref)];
    const suppliedAnchors = endpoints.flatMap(endpoint => endpoint.kind === "supplied" ? input.supplied_refs.find(s => s.id === endpoint.id)!.anchors : []);
    return { id: `c${i}`, subject: ref(prop.subject), predicate: prop.predicate, object,
      perspective: { ...prop.perspective, anchors: [] }, context: prop.context.map(ref), polarity: prop.polarity,
      ...prop.time, body: prop.witness, confidence: 0.8, sensitivity: "personal", anchors: [anchor, ...suppliedAnchors] };
  });
  const observed: Observation = { case_id: item.id, input, status: "ok", response: { schema: "kizuki.producer-response/v2", mentions, claims }, dropped: 0, usage: { calls: 1, input_tokens: 100, output_tokens: 100 } };
  const { budget: _budget, ...parseInput } = input;
  const parsed = parseExtractResponseV2(JSON.stringify(observed.response), parseInput);
  if (!parsed.ok || parsed.dropped.length) throw Error("scripted response must parse without drops");
  observed.response = parsed.response;
  return { item, rule, branch, observed };
}
function score(index: number, change?: (response: Mutable<ExtractResponseV2>) => void) {
  const f = fixture(index); if (change) change(f.observed.response! as Mutable<ExtractResponseV2>);
  return scoreCoreSemanticRepresentations(f.item, f.rule, f.observed, registry, policy);
}
test("fixed offered17 assets preserve the original13 and cover all four coherent records", () => {
  validateCoreSemanticAssets("offered17");
  const original = coreSemanticAssets(), all = coreSemanticAssets("offered17");
  expect(all.corpus.cases.slice(0, 13)).toEqual(original.corpus.cases);
  expect(all.contract.cases.slice(0, 13)).toEqual(original.contract.cases);
  expect(all.corpus.cases).toHaveLength(17);
  expect([...new Set(all.contract.cases.flatMap(coreSemanticRulePredicates))].sort()).toEqual(registry.offered.vocabulary.map(row => row.predicate).sort());
  for (let index = 0; index < 4; index++) {
    const f = fixture(index), result = score(index), prepared = prepareCoreSemanticObservation(f.observed, registry, f.item);
    expect(result.gates).toEqual(expect.objectContaining({ structure: [], schema: [], attribution: [], time: [] }));
    expect(result.automated_passed).toBe(true);
    expect(prepared.errors).toEqual([]);
    expect(prepared.drafts).toHaveLength(f.branch.propositions.length);
  }
});
test("closed proposition rules deny wrong endpoints, direction, contexts, vocabulary, missing and extra claims", () => {
  expect(score(0, r => { const c = r.claims.find(c => c.predicate === "concept.requires")!; if (c.object.kind === "subject") [c.subject, c.object.ref] = [c.object.ref, c.subject]; }).automated_passed).toBe(false);
  expect(score(3, r => { r.claims.find(c => c.predicate === "learning.application")!.context = []; }).automated_passed).toBe(false);
  expect(score(3, r => { r.claims.find(c => c.predicate === "learning.assistance")!.object = { kind: "vocabulary", ref: { kind: "vocabulary", id: "learning/unassisted" } }; }).automated_passed).toBe(false);
  expect(score(2, r => { const c = r.claims.find(c => c.predicate === "situation.participant")!; if (c.object.kind === "subject") c.object.ref = c.subject; }).automated_passed).toBe(false);
  expect(score(0, r => { r.claims.pop(); }).automated_passed).toBe(false);
  expect(score(0, r => { r.claims.push({ ...structuredClone(r.claims[0]!), id: "extra" }); }).automated_passed).toBe(false);
  expect(score(0, r => { r.claims.push({ ...structuredClone(r.claims.find(c => c.predicate === "concept.requires")!), id: "extra", predicate: "concept.same_as" }); }).automated_passed).toBe(false);
  expect(score(0, r => { r.mentions.push({ ...structuredClone(r.mentions[0]!), id: "other-occurrence", anchor: { ...r.mentions[0]!.anchor, start_utf16: 176, end_utf16: 188 } }); }).automated_passed).toBe(false);
});
test("only the two authored symmetric relations allow reversed endpoint orientation", () => {
  expect(score(1, r => { for (const c of r.claims.filter(c => ["concept.same_as", "concept.distinguished_from"].includes(c.predicate))) if (c.object.kind === "subject") [c.subject, c.object.ref] = [c.object.ref, c.subject]; }).automated_passed).toBe(true);
});

import { canonicalJson, sha256 } from "../evaluate-extraction";
import { scoreCoreSemanticRun, expectedCoreSemanticReview, verifyCoreSemanticReview, validateCoreSemanticContract } from "./core-semantic";
import { planModelExtractionV2 } from "../../packages/core/src/producer/model-v2";
import { modelQuoteAnchorForSpan, MODEL_EXTRACTION_WIRE_SCHEMA, resolveModelExtractionWire } from "../../packages/core/src/producer/model-v2-wire";
import { modelWireAdapterIdentity } from "./wire-custody";
import { qualificationInputPlanning } from "./input-planning";
import { runQualification } from "./run";
import { CORE_SEMANTIC_PROTOCOL } from "./core-semantic";

function evidence(rows: Observation[]) {
  const wire_adapter = modelWireAdapterIdentity();
  const wire_receipts = rows.map(row => {
    const plan = planModelExtractionV2(row.input, policy.input_token_overhead);
    if (plan.status !== "ready" || !row.response) throw Error("ready synthetic observation required");
    const anchor = (a: RichClaimDraft["anchors"][number]) => {
      const value = modelQuoteAnchorForSpan(a, plan.outbound.events);
      if (!value) throw Error("synthetic quote descriptor required"); return value;
    };
    const wire = { ...row.response, schema: MODEL_EXTRACTION_WIRE_SCHEMA,
      mentions: row.response.mentions.map(m => ({ ...m, anchor: anchor(m.anchor) })),
      claims: row.response.claims.map(c => ({ ...c, anchors: c.anchors.map(anchor), perspective: { ...c.perspective, anchors: c.perspective.anchors.map(anchor) } })) };
    const resolved = resolveModelExtractionWire(JSON.stringify(wire), plan.outbound);
    if (!resolved.ok || canonicalJson(JSON.parse(resolved.text)) !== canonicalJson(row.response)) throw Error("synthetic wire must reproduce the exact response");
    return { case_id: row.case_id, input_planning: qualificationInputPlanning(row.input, policy), producer_input_token_overhead: policy.input_token_overhead,
      transport_response_sha256: "b".repeat(64), adapter_source_sha256: wire_adapter.source_sha256,
      resolution_receipt_sha256: sha256(canonicalJson(resolved.receipt)), receipt: resolved.receipt };
  });
  return { input_policy: policy, source_commit: "a".repeat(40), wire_adapter, wire_receipts,
    traces: wire_receipts.map(row => ({ case_id: row.case_id, response_sha256: row.transport_response_sha256,
      model_response_sha256: row.receipt.raw_response_sha256, input_planning_sha256: row.input_planning.planning_sha256 })) };
}
function supplementRun(rows = Array.from({ length: 4 }, (_, index) => fixture(index).observed)) {
  const assets = coreSemanticAssets("offered17");
  // A local four-record control exercises the common evaluator without making a
  // runnable subset. The actual runner accepts only the fixed 17-case assets.
  const control = { ...assets, corpus: { ...assets.corpus, cases: assets.corpus.cases.slice(13) }, contract: { ...assets.contract, cases: assets.contract.cases.slice(13) } };
  return scoreCoreSemanticRun(rows, registry, evidence(rows), control);
}
test("actual wire, prepared admissions, qualified handle maps and complete rule reviews bind all 34 propositions", () => {
  const result = supplementRun();
  expect(result.automated_passed).toBe(true);
  expect(result.cases.flatMap(row => row.proposition_matches ?? [])).toHaveLength(34);
  const learning = result.cases[3]!;
  const application = learning.pipeline!.prepared_admissions.find(row => row.semantic.predicate === "learning.application")!.semantic;
  expect(application.subject).toEqual({ kind: "supplied", id: "person:neri-solven", namespace: { connector_id: "qualification.synthetic", source_key: "00000000000000000000000100" } });
  expect(application.context).toEqual([{ kind: "supplied", id: "task:opaline-seal-trial", namespace: { connector_id: "qualification.synthetic", source_key: "00000000000000000000000100" } }]);
  const review = expectedCoreSemanticReview("d".repeat(64), result);
  expect(() => verifyCoreSemanticReview("d".repeat(64), result, review)).not.toThrow();
  const edited = structuredClone(review) as Mutable<typeof review>;
  edited.cases[3]!.selected_branch_sha256 = "0".repeat(64);
  expect(() => verifyCoreSemanticReview("d".repeat(64), result, edited)).toThrow();
  expect(() => verifyCoreSemanticReview("e".repeat(64), result, review)).toThrow();
});
test("missing semantic atoms cannot borrow body meaning or acquire a prior review", () => {
  const result = supplementRun(), review = expectedCoreSemanticReview("d".repeat(64), result);
  const rows = Array.from({ length: 4 }, (_, index) => fixture(index).observed);
  rows[2] = { ...rows[2]!, response: { ...rows[2]!.response!, claims: rows[2]!.response!.claims.map(c => c.predicate === "situation.commitment"
    ? { ...c, object: { kind: "literal", value: "The crew" } } : c) } };
  // It is legitimate source text and cannot be semantically graded by substring
  // matching. The unchanged independent review must reject this different claim.
  const changed = supplementRun(rows);
  expect(() => verifyCoreSemanticReview("d".repeat(64), changed, review)).toThrow();
  expect("atoms" in review.cases[2]! ? review.cases[2]!.atoms : []).toContainEqual(expect.objectContaining({ predicate: "situation.commitment", atom: "The crew is committed to return the sealed dye trays before the next bell." }));
});
test("wire receipt, reserve, usage, evidence and source namespace mutations fail closed", () => {
  const rows = Array.from({ length: 4 }, (_, index) => fixture(index).observed), assets = coreSemanticAssets("offered17");
  const control = { ...assets, corpus: { ...assets.corpus, cases: assets.corpus.cases.slice(13) }, contract: { ...assets.contract, cases: assets.contract.cases.slice(13) } };
  const bound = evidence(rows);
  for (const bad of [
    { ...bound, wire_receipts: bound.wire_receipts.slice(1) },
    { ...bound, wire_receipts: bound.wire_receipts.map((row, i) => i ? row : { ...row, producer_input_token_overhead: 1 }) },
    { ...bound, wire_receipts: bound.wire_receipts.map((row, i) => i ? row : { ...row, resolution_receipt_sha256: "0".repeat(64) }) },
  ]) expect(scoreCoreSemanticRun(rows, registry, bad, control).automated_passed).toBe(false);
  for (const usage of [{ calls: 1, input_tokens: 32001, output_tokens: 1 }, { calls: 1, input_tokens: 1, output_tokens: 8193 }, { calls: 1, input_tokens: null, output_tokens: null }]) {
    const changed = rows.map((row, i) => i ? row : { ...row, usage });
    expect(scoreCoreSemanticRun(changed, registry, bound, control).automated_passed).toBe(false);
  }
  const wrong = fixture(3);
  wrong.observed.input = { ...wrong.observed.input, supplied_refs: wrong.observed.input.supplied_refs.map(row => ({ ...row, id: `wrong-${row.id}` })) };
  expect(() => prepareCoreSemanticObservation(wrong.observed, registry, wrong.item)).toThrow("mapping mismatch");
  expect(score(3, r => { r.claims.find(c => c.predicate === "learning.exposure")!.subject = { kind: "supplied", id: "person:neri-solven" }; }).automated_passed).toBe(false);
  expect(score(3, r => { r.claims.find(c => c.predicate === "learning.application")!.context = [r.claims.find(c => c.predicate === "learning.application")!.subject]; }).automated_passed).toBe(false);
  expect(score(0, r => { r.claims[0]!.perspective.mode = "suggested"; }).automated_passed).toBe(false);
  expect(score(0, r => { r.claims[0]!.valid_from = "2020-01-01T00:00:00.000Z"; }).automated_passed).toBe(false);
  expect(score(0, r => { r.claims.find(c => c.predicate === "concept.requires")!.anchors = [r.mentions[0]!.anchor]; }).automated_passed).toBe(false);
});
test("static contract rejects incomplete entities, unbound endpoints, duplicate rules and arbitrary symmetry", () => {
  for (const mutate of [
    (b: GeneralExtractBranch) => { b.propositions.pop(); b.propositions.push(b.propositions[0]!); },
    (b: GeneralExtractBranch) => { b.propositions[0]!.subject = { mode: "structured_source_subject", record: "r1", subject_id: "invented" }; },
    (b: GeneralExtractBranch) => { b.propositions.find(p => p.predicate === "concept.requires")!.symmetric = true; },
    (b: GeneralExtractBranch) => { b.entities[0]!.allowed_occurrence_spans.pop(); },
  ]) {
    const assets = structuredClone(coreSemanticAssets("offered17")), rule = assets.contract.cases[13]!;
    if (rule.expectation !== "extract") throw Error("extract rule required");
    mutate(coreSemanticBranches(rule)[0] as GeneralExtractBranch);
    expect(() => validateCoreSemanticContract(assets.corpus, assets.contract)).toThrow();
  }
});
test("fixed combined runner remains not_run without a model and refuses subsets or invalid split", async () => {
  const result = await runQualification({ protocol: CORE_SEMANTIC_PROTOCOL, core_split: "offered17", kinds: ["concept", "situation"] });
  expect(result.selected_cases).toHaveLength(17); expect(result.attempts).toBe(0);
  expect("core_semantic" in result && result.core_semantic.automated_passed).toBe(false);
  expect("core_split" in result && result.core_split).toBe("offered17");
  await expect(runQualification({ protocol: CORE_SEMANTIC_PROTOCOL, core_split: "offered17", kinds: ["concept", "situation"], case_ids: ["offered-learning-assisted-trial"] })).rejects.toThrow();
  expect(() => coreSemanticAssets("unknown" as "offered17")).toThrow();
});

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { REVIEWED_QUALIFICATIONS } from "./approvals";
import { RUNNER_FILES, runnerDigest } from "./fingerprint";
import { registryDigest, verifyQualificationReceipt } from "./registry";
import { extractionV2SystemContent } from "../../packages/core/src/producer/prompt-v2";
import { RESPONSE_GAP_MS } from "./pacing";
import { verifyCoreSemanticReport } from "./verify-core-semantic";

test("the exact fixed17 verifier accepts a complete synthetic control and rejects split or review substitution", () => {
  const directory = mkdtempSync(join(tmpdir(), "offered17-verifier-"));
  try {
    for (const path of RUNNER_FILES) { mkdirSync(dirname(join(directory, path)), { recursive: true }); writeFileSync(join(directory, path), readFileSync(join(import.meta.dir, "../..", path))); }
    // Public frozen observations are regression fixtures only. All transport
    // evidence below is newly scripted, never a qualification or an approval.
    const old = JSON.parse(readFileSync(join(import.meta.dir, "../fixtures/world-qualification", REVIEWED_QUALIFICATIONS[0]!.file), "utf8")) as { observations: Observation[] };
    const rows = [...old.observations, ...Array.from({ length: 4 }, (_, index) => fixture(index).observed)];
    const assets = coreSemanticAssets("offered17"), bound = evidence(rows), result = scoreCoreSemanticRun(rows, registry, bound, assets);
    expect(result.automated_passed).toBe(true); expect(result.cases).toHaveLength(17);
    const traces = rows.map((row, index) => ({ ...bound.traces[index]!, prompt_sha256: sha256(extractionV2SystemContent(row.input)), transport: "ok", request_sha256: "c".repeat(64),
      origin: "observed_v3", http_status: 200, started_at: new Date(Date.UTC(2026, 9, 23) + index * (RESPONSE_GAP_MS + 1000)).toISOString(),
      completed_at: new Date(Date.UTC(2026, 9, 23) + index * (RESPONSE_GAP_MS + 1000) + 1000).toISOString() }));
    const report = { schema: "kizuki.world-qualification-run/v3", protocol: CORE_SEMANTIC_PROTOCOL, core_split: "offered17", evidence: "runner_observed_transport", synthetic: true,
      input_policy: policy, source_clean: true, source_commit: bound.source_commit, runner_sha256: runnerDigest(directory), registry_sha256: registryDigest(registry),
      model: "synthetic-method-control", endpoint_host: "127.0.0.1:1", selected_kinds: ["concept", "situation"], selected_extensions: [],
      corpus: assets.corpus, observations: rows, traces, missing: [], selected_cases: rows.map(row => row.case_id), resumed_from: null, halt_reason: null,
      response_gap_ms: RESPONSE_GAP_MS, attempts: 17, case_states: rows.map(row => ({ case_id: row.case_id, status: "observed" })),
      prompt_sha256: traces[0]!.prompt_sha256, prompt_sha256_by_case: Object.fromEntries(traces.map(trace => [trace.case_id, trace.prompt_sha256])),
      wire_adapter: bound.wire_adapter, wire_receipts: bound.wire_receipts, core_semantic: result };
    const bytes = JSON.stringify(report), hash = sha256(bytes), review = JSON.stringify(expectedCoreSemanticReview(hash, result));
    const path = join(directory, "scripts/fixtures/world-qualification/offered17-control-review.json");
    mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, review);
    const approval = { file: "offered17-control.json", sha256: hash, endpoint_evidence: "d".repeat(64), protocol: CORE_SEMANTIC_PROTOCOL,
      body_review: { file: "offered17-control-review.json", sha256: sha256(review) } };
    const checked = verifyQualificationReceipt(bytes, approval, registry, directory);
    expect(checked.predicates.toSorted()).toEqual(registry.offered.vocabulary.map(row => row.predicate).sort());
    expect(() => verifyCoreSemanticReport(bytes, approval, directory, "offered17")).not.toThrow();
    expect(() => verifyCoreSemanticReport(bytes, approval, directory)).toThrow("split required");
    for (const changed of [{ ...report, core_split: undefined }, { ...report, observations: rows.slice(0, 13), attempts: 13 }, { ...report, runner_sha256: "0".repeat(64) }]) {
      const changedBytes = JSON.stringify(changed);
      expect(() => verifyQualificationReceipt(changedBytes, { ...approval, sha256: sha256(changedBytes) }, registry, directory)).toThrow();
    }
    writeFileSync(path, JSON.stringify({ ...JSON.parse(review), cases: JSON.parse(review).cases.slice(0, 13) }));
    const wrongReview = readFileSync(path, "utf8");
    expect(() => verifyQualificationReceipt(bytes, { ...approval, body_review: { ...approval.body_review, sha256: sha256(wrongReview) } }, registry, directory)).toThrow("review mismatch");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
