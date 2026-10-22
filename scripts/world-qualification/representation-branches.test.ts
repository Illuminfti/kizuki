import { expect, test } from "bun:test";
import { coreSemanticBranchRule, coreSemanticBranches, coreSemanticCaseInput, coreSemanticContract, coreSemanticCorpus,
  expectedCoreSemanticReview, prepareCoreSemanticObservation, scoreCoreSemanticCase, scoreCoreSemanticRepresentations,
  scoreCoreSemanticRun, validateCoreSemanticContract, verifyCoreSemanticReview,
  type CoreSemanticCase, type CoreSemanticExtractBranch, type PropositionRule } from "./core-semantic";
import { candidateRegistry } from "./registry";
import { WORLD_VOCABULARY_MODULES } from "./candidate-modules";
import { DEFAULT_QUALIFICATION_INPUT_POLICY as policy, qualificationInputPlanning } from "./input-planning";
import { canonicalJson, sha256 } from "../evaluate-extraction";
import type { Observation } from "./score";
import type { ExtractResponseV2, RichClaimDraft, TextAnchor } from "../../packages/core/src/contracts/producer-v2";
import { planModelExtractionV2 } from "../../packages/core/src/producer/model-v2";
import { MODEL_EXTRACTION_WIRE_SCHEMA, resolveModelExtractionWire } from "../../packages/core/src/producer/model-v2-wire";
import { emptyWireBinding, modelWireAdapterIdentity } from "./wire-custody";

const registry = candidateRegistry(WORLD_VOCABULARY_MODULES, ["concept", "situation"]);
// Independent method controls, never a campaign case or an observed model response.
const phrase = "pump verification unresolved", role = "Maintenance record MR-28 reports a dated maintenance observation";
const interval = "from 2010-02-03T00:00:00.000Z until 2010-03-04T00:00:00.000Z";
const action = "Replace the chipped valve so pump verification can proceed.";
const obstruction = "The chipped valve blocks pump verification.";
const corroboration = "Maintenance record MR-29 confirms the same condition, requested replacement, enablement and obstruction for the same interval.";
const item: CoreSemanticCase = { id: "method-control-reported-pump", kind: "situation", category: "historical", source_type: "document_report",
  records: [{ id: "record", text: `${role} ${interval}: it describes the condition ${phrase}. ${action} ${obstruction} ${corroboration}`,
    subjects: [{ id: "report", quote: "Maintenance record MR-28" }, { id: "corroborating-report", quote: "Maintenance record MR-29" }] }] };
const time = { valid_from: "2010-02-03T00:00:00.000Z", valid_to: "2010-03-04T00:00:00.000Z", temporal_basis: "explicit" as const, witness: interval };
const reported = { perspective: "document_report" as const, source: "report", attribution_witness: role, time };
const branch = (id: string, predicate: string, witness: string): CoreSemanticExtractBranch => ({ id,
  target: { mode: "mention", record: "record", quote: phrase },
  classification: { kind: "world/situation", label: phrase, witness: phrase, perspective: "direct", time },
  label_rule: { value: phrase, naming: "source_description", witness: phrase, ...reported },
  details: [{ predicate, object_kind: "literal", witness, ...reported,
    required_atoms: ["The record requests replacement of the chipped valve.", "Replacement enables pump verification.", "The chipped valve obstructs pump verification."] }], forbidden_assertions: ["The verification is completed."] });
const objective = branch("requested-action", "situation.objective", `${action} ${obstruction}`), blocker = branch("obstructing-condition", "situation.blocker", `${action} ${obstruction}`);
const rule = (branches = [objective, blocker]) => ({ case_id: item.id, expectation: "extract" as const, branches: structuredClone(branches) });
function anchor(quote: string): TextAnchor {
  const text = item.records[0]!.text, start = text.indexOf(quote);
  if (start < 0 || text.indexOf(quote, start + 1) >= 0) throw new Error("ambiguous control anchor");
  return { event_id: "00000000000000000000000001", start_utf16: start, end_utf16: start + quote.length };
}
function observation(selected: CoreSemanticExtractBranch): Observation {
  const input = coreSemanticCaseInput(item, registry, policy), target = { kind: "mention" as const, id: "condition" };
  const claim = (id: string, predicate: string, object: RichClaimDraft["object"], proposition: PropositionRule): RichClaimDraft => ({
    id, predicate, subject: target, object, polarity: "positive", context: [], body: proposition.witness, confidence: 0.8, sensitivity: "personal",
    valid_from: time.valid_from, valid_to: time.valid_to, temporal_basis: "explicit",
    anchors: [...new Map([anchor(phrase), anchor(proposition.witness), anchor(interval), anchor(role)].map(row => [canonicalJson(row), row])).values()],
    perspective: proposition.perspective === "direct" ? { mode: "asserted", interpretation: "explicit", holder: null, speaker: null, addressee: null, anchors: [] }
      : { mode: "reported", interpretation: "explicit", holder: { kind: "supplied", id: "report" }, speaker: null, addressee: null,
        anchors: [anchor("Maintenance record MR-28"), anchor(role)] },
  });
  return { case_id: item.id, input, status: "ok", dropped: 0, usage: { calls: 1, input_tokens: 100, output_tokens: 100 },
    response: { schema: "kizuki.producer-response/v2", mentions: [{ id: "condition", label: phrase, anchor: anchor(phrase), candidate_refs: [] }], claims: [
      claim("c1", "world.kind", { kind: "vocabulary", ref: { kind: "vocabulary", id: "world/situation" } }, selected.classification),
      claim("c2", "situation.label", { kind: "literal", value: phrase }, selected.label_rule!),
      ...selected.details.map((detail, index) => claim(`c${index + 3}`, detail.predicate, { kind: "literal", value: detail.witness }, detail)),
    ] } };
}
function withClaim(observed: Observation, index: number, change: (claim: RichClaimDraft) => RichClaimDraft): Observation {
  return { ...observed, response: { ...observed.response!, claims: observed.response!.claims.map((claim, at) => at === index ? change(claim) : claim) } };
}
function staticControls() {
  const corpus = structuredClone(coreSemanticCorpus), contract = structuredClone(coreSemanticContract);
  contract.schema = "kizuki.core-semantic-contract/v2";
  contract.cases = contract.cases.map(authored => {
    if (authored.expectation === "abstain") return authored;
    const branches = coreSemanticBranches(authored).map((candidate, index) => {
      const { label_alternatives: _alternatives, ...fields } = candidate;
      const { kind: _kind, label: _label, ...labelRule } = fields.classification;
      return { ...fields, id: `control-${index}`, label_rule: fields.label_rule ?? { ...labelRule,
        value: fields.classification.label, naming: "explicit" as const, naming_witness: fields.target.quote } };
    });
    return { case_id: authored.case_id, expectation: "extract", branches };
  });
  const index = corpus.cases.findIndex(candidate => candidate.kind === "situation" && candidate.category === "historical");
  corpus.cases[index] = structuredClone(item); contract.cases[index] = rule();
  return { corpus, contract, index };
}

test("authored branches have bounded complete distinct contracts and source-grounded labels", () => {
  const controls = staticControls();
  expect(() => validateCoreSemanticContract(controls.corpus, controls.contract)).not.toThrow();
  for (const mutate of [
    (branches: CoreSemanticExtractBranch[]) => { branches.push(...structuredClone(branches)); },
    (branches: CoreSemanticExtractBranch[]) => { branches[1]!.id = branches[0]!.id; },
    (branches: CoreSemanticExtractBranch[]) => { branches[0]!.details = []; },
    (branches: CoreSemanticExtractBranch[]) => { branches[0]!.details[0]!.required_atoms = []; },
    (branches: CoreSemanticExtractBranch[]) => { branches[0]!.details[0]!.required_atoms = Array(17).fill("unbounded atom"); },
    (branches: CoreSemanticExtractBranch[]) => { branches[0]!.label_rule!.value = "invented condition title"; },
    (branches: CoreSemanticExtractBranch[]) => { branches[0]!.label_rule!.perspective = "direct"; },
    (branches: CoreSemanticExtractBranch[]) => { branches[0]!.label_rule!.time = "unknown"; },
    (branches: CoreSemanticExtractBranch[]) => { branches[0]!.label_rule!.naming = "explicit"; },
    (branches: CoreSemanticExtractBranch[]) => { branches[0]!.forbidden_assertions = []; },
  ]) {
    const changed = structuredClone(controls), authored = changed.contract.cases[changed.index]!;
    if (authored.expectation !== "extract" || !("branches" in authored)) throw new Error("bad control");
    mutate(authored.branches);
    expect(() => validateCoreSemanticContract(changed.corpus, changed.contract)).toThrow();
  }
});

test("each complete representation independently passes and executes its own polarity, role and time guards", () => {
  for (const selected of [objective, blocker]) {
    const observed = observation(selected), prepared = prepareCoreSemanticObservation(observed, registry);
    expect(prepared.errors).toEqual([]);
    const scored = scoreCoreSemanticRepresentations(item, rule(), observed, registry, policy);
    expect(scored.automated_passed).toBe(true);
    expect(scored.selected_branch_id).toBe(selected.id);
    for (const change of [
      (claim: RichClaimDraft) => ({ ...claim, polarity: "negative" as const }),
      (claim: RichClaimDraft) => ({ ...claim, perspective: { ...claim.perspective, mode: "asserted" as const, holder: null } }),
      (claim: RichClaimDraft) => ({ ...claim, valid_to: "2010-03-05T00:00:00.000Z" }),
    ]) {
      const changed = withClaim(observed, 2, change);
      const failure = scoreCoreSemanticRepresentations(item, rule(), changed, registry, policy);
      expect(failure.automated_passed).toBe(false);
      expect(failure.selected_branch_id).toBeNull();
      const own = failure.branch_results.find(candidate => candidate.branch_id === selected.id)!;
      expect(own.automated_passed).toBe(false);
      expect([...own.gates.structure, ...own.gates.attribution, ...own.gates.time].length).toBeGreaterThan(0);
      if (changed.response!.claims[2]!.perspective.mode === "asserted") expect(own.gates.attribution).toContain(`${selected.details[0]!.predicate}:perspective`);
      if (changed.response!.claims[2]!.valid_to !== time.valid_to) expect(own.gates.time).toContain(`${selected.details[0]!.predicate}:time`);
    }
    const other = observation(selected.id === objective.id ? blocker : objective).response!.claims[2]!;
    const extra = { ...observed, response: { ...observed.response!, claims: [...observed.response!.claims, { ...other, id: "extra-typed" }] } };
    expect(scoreCoreSemanticRepresentations(item, rule(), extra, registry, policy).automated_passed).toBe(false);
  }
});

test("partial branches cannot join facts and authored ordering is deterministic", () => {
  const observed = observation(objective), first = { ...objective, id: "first" }, second = { ...objective, id: "second" };
  expect(scoreCoreSemanticRepresentations(item, rule([first, second]), observed, registry, policy).selected_branch_id).toBe("first");
  const wrongRole = structuredClone(objective), wrongTime = structuredClone(objective);
  wrongRole.id = "wrong-role"; wrongRole.details[0]!.perspective = "direct";
  wrongTime.id = "wrong-time";
  if (wrongTime.details[0]!.time === "unknown") throw new Error("dated control required");
  wrongTime.details[0]!.time.valid_to = "2010-03-05T00:00:00.000Z";
  const later = scoreCoreSemanticRepresentations(item, rule([wrongRole, wrongTime, objective]), observed, registry, policy);
  expect(later.selected_branch_id).toBe(objective.id);
  expect(later.branch_results[0]!.gates.attribution).toContain("situation.objective:perspective");
  expect(later.branch_results[1]!.gates.time).toContain("situation.objective:time");
  const roleMismatch = withClaim(observed, 2, claim => ({ ...claim, perspective: { ...claim.perspective, mode: "asserted", holder: null } }));
  const noUnion = scoreCoreSemanticRepresentations(item, rule(), roleMismatch, registry, policy);
  expect(noUnion.selected_branch_id).toBeNull();
  expect(noUnion.gates.representation).toEqual(["no_complete_representation_branch"]);
  expect(noUnion.branch_results[0]!.gates.structure).toEqual([]);
  expect(noUnion.branch_results[0]!.gates.attribution).toContain("situation.objective:perspective");
  expect(noUnion.branch_results[1]!.gates.structure).toContain("situation.blocker:missing");
  // Both branches pass static author validation and preserve all three facts.
  // The response combines the first branch's label with the second's source.
  const alternate = structuredClone(objective); alternate.id = "corroborating-description";
  alternate.target.quote = `the condition ${phrase}`;
  alternate.classification.label = alternate.target.quote; alternate.classification.witness = alternate.target.quote;
  alternate.label_rule = { ...alternate.label_rule!, value: alternate.target.quote, witness: alternate.target.quote,
    source: "corroborating-report", attribution_witness: corroboration };
  alternate.details[0]!.source = "corroborating-report"; alternate.details[0]!.attribution_witness = corroboration;
  const mixed = rule([objective, alternate]), controls = staticControls(); controls.contract.cases[controls.index] = mixed;
  expect(() => validateCoreSemanticContract(controls.corpus, controls.contract)).not.toThrow();
  const partial = withClaim(observed, 2, claim => ({ ...claim, anchors: [...claim.anchors, anchor(corroboration)],
    perspective: { ...claim.perspective, holder: { kind: "supplied", id: "corroborating-report" },
      anchors: [anchor("Maintenance record MR-29"), anchor(corroboration)] } }));
  const rejected = scoreCoreSemanticRepresentations(item, mixed, partial, registry, policy);
  expect(rejected.gates.representation).toEqual(["no_complete_representation_branch"]);
  expect(rejected.branch_results[0]!.gates.attribution).toContain("situation.objective:perspective");
  expect(rejected.branch_results[1]!.gates.structure).toContain("label_mismatch");
});

test("manual review binds the selected complete contract and cannot pass an unsupported literal atom", () => {
  const observed = observation(objective), control = scoreCoreSemanticRepresentations(item, rule(), observed, registry, policy);
  expect(control.manual_review.status).toBe("pending");
  expect(control.selected_branch_sha256).toBe(sha256(canonicalJson(objective)));
  expect(control.manual_review.selected_branch).toEqual(objective);
  // The automated scorer does not invent an NLP entailment check. Independent
  // review must reject a partial literal even when its source words parse.
  const changed = withClaim(observed, 2, claim => ({ ...claim, object: { kind: "literal", value: "Replace the chipped valve" } }));
  const partial = scoreCoreSemanticRepresentations(item, rule(), changed, registry, policy);
  expect(partial.manual_review.status).toBe("pending");
  const template = scoreCoreSemanticRun([], registry, { source_commit: "a".repeat(40), input_policy: policy,
    traces: [], wire_adapter: modelWireAdapterIdentity(), wire_receipts: [] });
  expect(() => expectedCoreSemanticReview("a".repeat(64), template)).toThrow("complete passing branches");
  const first = template.cases[0]!;
  const result: ReturnType<typeof scoreCoreSemanticRun> = { ...template, automated_passed: true, cases: [{ ...first, ...partial,
    gates: { ...partial.gates, pipeline: [] }, stage: "prepared_admission",
    manual_review: { ...partial.manual_review, stage: "prepared_admission", transport_response_sha256: null,
      input_manifest_sha256: null, sent_window_manifest_sha256: null, prepared_admissions_sha256: null, ...emptyWireBinding() } }] };
  const hash = "a".repeat(64), review = expectedCoreSemanticReview(hash, result);
  expect(() => verifyCoreSemanticReview(hash, result, review)).not.toThrow();
  const unsupported = { ...review, cases: review.cases.map(row => ({ ...row, atoms: "atoms" in row ? row.atoms?.map(atom => ({ ...atom, status: "unsupported" })) : [] })) };
  expect(() => verifyCoreSemanticReview(hash, result, unsupported)).toThrow("review mismatch");
  for (const change of [{ selected_branch_id: blocker.id }, { selected_branch_sha256: "0".repeat(64) }, { selected_branch: blocker }])
    expect(() => verifyCoreSemanticReview(hash, result, { ...review, cases: [{ ...review.cases[0], ...change }] })).toThrow("review mismatch");
});

test("prepared branch selection never switches the raw diagnostic to an easier branch", () => {
  const original = observation(objective), shortRole = "Maintenance record MR-28 reports";
  const short = structuredClone(objective); short.id = "short-report-witness";
  short.details[0]!.attribution_witness = shortRole;
  const observed = withClaim(original, 2, detail => ({ ...detail,
    anchors: [anchor(phrase), anchor(`${action} ${obstruction}`), anchor(interval), anchor(shortRole)],
    perspective: { ...detail.perspective, anchors: [anchor("Maintenance record MR-28"), anchor(shortRole)] } }));
  expect(scoreCoreSemanticCase(item, coreSemanticBranchRule(item.id, short), observed, registry, policy).automated_passed).toBe(true);
  expect(scoreCoreSemanticCase(item, coreSemanticBranchRule(item.id, objective), observed, registry, policy).automated_passed).toBe(false);
  const plan = planModelExtractionV2(observed.input);
  if (plan.status !== "ready") throw new Error("control plan rejected");
  const descriptor = (value: TextAnchor) => ({ event_id: value.event_id, quote: item.records[0]!.text,
    select: item.records[0]!.text.slice(value.start_utf16, value.end_utf16) });
  const response = observed.response!;
  const raw = JSON.stringify({ ...response, schema: MODEL_EXTRACTION_WIRE_SCHEMA,
    mentions: response.mentions.map(mention => ({ ...mention, anchor: descriptor(mention.anchor) })),
    claims: response.claims.map(claim => ({ ...claim, anchors: claim.anchors.map(descriptor),
      perspective: { ...claim.perspective, anchors: claim.perspective.anchors.map(descriptor) } })) });
  const resolved = resolveModelExtractionWire(raw, plan.outbound);
  if (!resolved.ok) throw new Error("control wire rejected");
  const index = coreSemanticCorpus.cases.findIndex(candidate => candidate.kind === "situation" && candidate.category === "historical");
  const originalItem = coreSemanticCorpus.cases[index]!, originalRule = coreSemanticContract.cases[index]!;
  try {
    coreSemanticCorpus.cases[index] = item; coreSemanticContract.cases[index] = rule([objective, short]);
    const planning = qualificationInputPlanning(observed.input, policy), adapter = modelWireAdapterIdentity(), transport = "b".repeat(64);
    const result = scoreCoreSemanticRun([observed], registry, { source_commit: "a".repeat(40), input_policy: policy,
      traces: [{ case_id: item.id, response_sha256: transport, model_response_sha256: sha256(raw), input_planning_sha256: planning.planning_sha256 }], wire_adapter: adapter,
      wire_receipts: [{ case_id: item.id, input_planning: planning, producer_input_token_overhead: 0, transport_response_sha256: transport,
        adapter_source_sha256: adapter.source_sha256, resolution_receipt_sha256: sha256(canonicalJson(resolved.receipt)), receipt: resolved.receipt }] });
    const selected = result.cases[index]!;
    expect(selected.automated_passed).toBe(true);
    expect(selected.selected_branch_id).toBe(objective.id);
    expect(selected.raw_model.diagnostic_branch_id).toBe(objective.id);
    expect(selected.raw_model.automated_passed).toBe(false);
    expect(selected.raw_citation_precision.passed).toBe(false);
  } finally { coreSemanticCorpus.cases[index] = originalItem; coreSemanticContract.cases[index] = originalRule; }
});
