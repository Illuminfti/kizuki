import { DEFAULT_QUALIFICATION_INPUT_POLICY, qualificationInputPlanning, qualificationProducerInputOverhead, validateQualificationInputPolicy, type QualificationInputPolicy } from "./input-planning";
import { INVALID_HISTORICAL_QUALIFICATIONS, REVIEWED_QUALIFICATIONS } from "./approvals";
import { verifyCoreSemanticReport } from "./verify-core-semantic";
import { describe, expect, test } from "bun:test";
import { parseExtractResponseV2, type DraftRef, type ExtractResponseV2, type RichClaimDraft, type TextAnchor } from "../../packages/core/src/contracts/producer-v2";
import { WORLD_VOCABULARY_MODULES } from "./candidate-modules";
import { candidateRegistry, checkOfferedQualification, registryDigest, verifyQualificationReceipt } from "./registry";
import { canonicalJson, sha256 } from "../evaluate-extraction";
import { coreSemanticCaseInput, coreSemanticContract, coreSemanticCorpus, expectedCoreSemanticReview, scoreCoreSemanticRun as actualScoreCoreSemanticRun, prepareCoreSemanticObservation, validateCoreSemanticAssets, verifyCoreSemanticReview, type CoreSemanticCase } from "./core-semantic";
import type { Observation } from "./score";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runQualification } from "./run";
import { RUNNER_FILES, runnerDigest } from "./fingerprint";
import { extractionV2SystemContent } from "../../packages/core/src/producer/prompt-v2";
import { createModelProducerV2Port, planModelExtractionV2 } from "../../packages/core/src/producer/model-v2";
import { inheritModelProducerIdentity } from "../../packages/core/src/producer/fingerprint";
import { createOpenAiCompatibleLlmPort } from "../../packages/llm/src/openai-compatible";
import type { PortContext } from "../../packages/core/src/contracts/ports";
import { RESPONSE_GAP_MS } from "./pacing";
import { modelWireAdapterIdentity, type CoreSemanticWireEvidence } from "./wire-custody";
import { MODEL_EXTRACTION_WIRE_SCHEMA, type ModelExtractionWireReceipt } from "../../packages/core/src/producer/model-v2-wire";
import { startFakeEndpoint } from "../../packages/llm/test/fake-endpoint";

// Scripted development controls only; no historical observed campaign is rescored.
const registry = candidateRegistry(WORLD_VOCABULARY_MODULES, ["concept", "situation"]);
type Rule = (typeof coreSemanticContract.cases)[number];
type ExtractRule = Extract<Rule, { expectation: "extract" }>;

function selectedCase(kind: CoreSemanticCase["kind"], category: CoreSemanticCase["category"]): CoreSemanticCase {
  const item = coreSemanticCorpus.cases.find(row => row.kind === kind && row.category === category);
  if (!item) throw new Error("missing authored method-control category");
  return item;
}
function extractionRule(item: CoreSemanticCase): ExtractRule {
  const rule = coreSemanticContract.cases.find(row => row.case_id === item.id);
  if (rule?.expectation !== "extract") throw new Error("missing authored extraction contract");
  return rule;
}

function uniqueSpan(item: CoreSemanticCase, quote: string): TextAnchor {
  const index = item.records.findIndex(record => record.text.includes(quote)), record = item.records[index]!;
  const start = record.text.indexOf(quote);
  if (start < 0 || record.text.indexOf(quote, start + 1) >= 0) throw new Error("ambiguous test span");
  return { event_id: String(index + 1).padStart(26, "0"), start_utf16: start, end_utf16: start + quote.length };
}

function scripted(item: CoreSemanticCase, policy: QualificationInputPolicy = DEFAULT_QUALIFICATION_INPUT_POLICY): Observation {
  const input = coreSemanticCaseInput(item, registry, policy), rule = coreSemanticContract.cases.find(row => row.case_id === item.id)!;
  if (rule.expectation === "abstain") return { case_id: item.id, input, status: "ok", response: { schema: "kizuki.producer-response/v2", mentions: [], claims: [] }, dropped: 0,
    usage: { calls: 1, input_tokens: 100, output_tokens: 10 } };
  const targetAnchor = uniqueSpan(item, rule.target.quote), target: DraftRef = { kind: "mention", id: "m-target" };
  const mentionSources = new Map<string, { ref: DraftRef; anchor: TextAnchor; attributionAnchor: TextAnchor; label: string }>();
  for (const contract of [rule.classification, ...rule.details]) if (contract.source !== undefined && typeof contract.source !== "string") {
    const key = canonicalJson(contract.source), anchor = uniqueSpan(item, contract.source.quote);
    if (!mentionSources.has(key)) mentionSources.set(key, { ref: { kind: "mention", id: `m-source-${mentionSources.size + 1}` }, anchor,
      attributionAnchor: uniqueSpan(item, contract.source.attribution_witness), label: contract.source.label });
  }
  const proposition = (id: string, predicate: string, object: RichClaimDraft["object"], contract: NonNullable<ExtractRule["label_alternatives"]>[number], body: string): RichClaimDraft => {
    const source = contract.source === undefined ? null : typeof contract.source === "string" ? ({ kind: "supplied", id: contract.source } as const) : mentionSources.get(canonicalJson(contract.source))!.ref;
    const perspective = contract.perspective === "direct"
      ? { holder: null, speaker: null, addressee: null, mode: "asserted" as const, interpretation: "explicit" as const, anchors: [] }
      : contract.perspective === "person_statement"
        ? { holder: null, speaker: source, addressee: null, mode: "reported" as const, interpretation: "explicit" as const, anchors: typeof contract.source === "string" ? input.supplied_refs.find(row => row.id === contract.source)!.anchors
          : [mentionSources.get(canonicalJson(contract.source!))!.anchor, mentionSources.get(canonicalJson(contract.source!))!.attributionAnchor] }
        : { holder: source, speaker: null, addressee: null, mode: "reported" as const, interpretation: "explicit" as const, anchors: typeof contract.source === "string" ? input.supplied_refs.find(row => row.id === contract.source)!.anchors
          : [mentionSources.get(canonicalJson(contract.source!))!.anchor, mentionSources.get(canonicalJson(contract.source!))!.attributionAnchor] };
    const time = contract.time === "unknown" ? { valid_from: null, valid_to: null, temporal_basis: "unknown" as const }
      : { valid_from: contract.time.valid_from, valid_to: contract.time.valid_to, temporal_basis: contract.time.temporal_basis };
    const witness = uniqueSpan(item, contract.witness), timeWitness = contract.time === "unknown" ? null : uniqueSpan(item, contract.time.witness);
    const roleWitness = contract.attribution_witness ?? (typeof contract.source === "object" ? contract.source.attribution_witness : undefined);
    const anchors = [targetAnchor, witness, ...(timeWitness === null ? [] : [timeWitness]), ...(roleWitness === undefined ? [] : [uniqueSpan(item, roleWitness)])];
    return { id, subject: target, predicate, object, perspective, context: [], polarity: "positive", body, ...time, confidence: 0.8, sensitivity: "personal",
      anchors: [...new Map(anchors.map(anchor => [canonicalJson(anchor), anchor])).values()] };
  };
  const claims: RichClaimDraft[] = [
    proposition("c1", "world.kind", { kind: "vocabulary", ref: { kind: "vocabulary", id: rule.classification.kind } }, rule.classification, `${rule.classification.label} is classified as ${rule.classification.kind}.`),
    proposition("c2", `${item.kind}.label`, { kind: "literal", value: rule.classification.label }, rule.label_alternatives?.[0] ?? rule.classification, `The source names it ${rule.classification.label}.`),
    ...rule.details.map((detail, index) => { const literal = detail.witness; return proposition(`c${index + 3}`, detail.predicate, { kind: "literal", value: literal }, detail, literal); }),
  ];
  const mentions = [{ id: "m-target", label: rule.target.quote, anchor: targetAnchor, candidate_refs: [] },
    ...[...mentionSources.values()].map(source => ({ id: source.ref.id, label: source.label, anchor: source.anchor, candidate_refs: [] }))];
  return { case_id: item.id, input, status: "ok", response: { schema: "kizuki.producer-response/v2", mentions, claims } as ExtractResponseV2, dropped: 0,
    usage: { calls: 1, input_tokens: 100, output_tokens: 100 } };
}

const observations = () => coreSemanticCorpus.cases.map(item => scripted(item));
function wireControl(row: Observation, transport = "b".repeat(64), policy = DEFAULT_QUALIFICATION_INPUT_POLICY): { evidence: CoreSemanticWireEvidence; rawText: string } {
  const adapter = modelWireAdapterIdentity();
  const plan = planModelExtractionV2(row.input, policy.input_token_overhead);
  if (plan.status !== "ready" || row.response === null) throw new Error("wire evidence control requires a ready response");
  const anchors = [
    ...row.response.mentions.map((mention, index) => ({ path: `mentions[${index}].anchor`, anchor: mention.anchor })),
    ...row.response.claims.flatMap((claim, index) => [
      ...claim.anchors.map((anchor, anchorIndex) => ({ path: `claims[${index}].anchors[${anchorIndex}]`, anchor })),
      ...claim.perspective.anchors.map((anchor, anchorIndex) => ({ path: `claims[${index}].perspective.anchors[${anchorIndex}]`, anchor })),
    ]),
  ];
  const resolutions = anchors.map(({ path, anchor }) => {
    const text = plan.outbound.events.find(event => event.event_id === anchor.event_id)?.text;
    const selected = text?.slice(anchor.start_utf16, anchor.end_utf16) ?? "";
    const quote = text !== undefined && selected.length > 0 && text.indexOf(selected) === anchor.start_utf16 && text.indexOf(selected, anchor.start_utf16 + 1) < 0
      ? selected
      : "unbound-control-anchor";
    return { path, descriptor: { event_id: anchor.event_id, quote }, anchor };
  });
  const descriptor = new Map(resolutions.map(row => [row.path, row.descriptor]));
  const rawText = JSON.stringify({ ...row.response, schema: MODEL_EXTRACTION_WIRE_SCHEMA,
    mentions: row.response.mentions.map((mention, index) => ({ ...mention, anchor: descriptor.get(`mentions[${index}].anchor`)! })),
    claims: row.response.claims.map((claim, index) => ({ ...claim,
      anchors: claim.anchors.map((_anchor, anchorIndex) => descriptor.get(`claims[${index}].anchors[${anchorIndex}]`)!),
      perspective: { ...claim.perspective, anchors: claim.perspective.anchors.map((_anchor, anchorIndex) => descriptor.get(`claims[${index}].perspective.anchors[${anchorIndex}]`)!) } })) });
  const receipt: ModelExtractionWireReceipt = { schema: adapter.receipt_schema, wire_schema: adapter.wire_schema,
    raw_response_sha256: sha256(rawText), outbound_sha256: sha256(canonicalJson(plan.outbound)),
    events: plan.outbound.events.map(event => ({ event_id: event.event_id, text_sha256: sha256(event.text), utf16_length: event.text.length })),
    resolutions, translated_response_sha256: sha256(canonicalJson(row.response)) };
  return { rawText, evidence: { case_id: row.case_id, producer_input_token_overhead: policy.input_token_overhead, input_planning: qualificationInputPlanning(row.input, policy), transport_response_sha256: transport, adapter_source_sha256: adapter.source_sha256,
    resolution_receipt_sha256: sha256(canonicalJson(receipt)), receipt } };
}
const wireEvidence = (rows: readonly Observation[], transport = "b".repeat(64), policy = DEFAULT_QUALIFICATION_INPUT_POLICY) => rows.map(row => wireControl(row, transport, policy).evidence);
const coreEvidence = (rows: readonly Observation[], traces?: { case_id: string; response_sha256: string | null; model_response_sha256: string | null; input_planning_sha256?: string }[], policy = DEFAULT_QUALIFICATION_INPUT_POLICY) => {
  const wireReceipts = wireEvidence(rows, "b".repeat(64), policy);
  return { source_commit: "a".repeat(40), input_policy: policy, traces: traces ?? rows.map((row, index) => ({ case_id: row.case_id, response_sha256: "b".repeat(64),
    model_response_sha256: wireReceipts[index]!.receipt.raw_response_sha256, input_planning_sha256: wireReceipts[index]!.input_planning.planning_sha256 })), wire_adapter: modelWireAdapterIdentity(), wire_receipts: wireReceipts };
};
const scoreCoreSemanticRun = (rows: readonly Observation[], selected: ReturnType<typeof candidateRegistry>) => actualScoreCoreSemanticRun(rows, selected, coreEvidence(rows));
const mutate = (rows: Observation[], id: string, change: (response: ExtractResponseV2) => ExtractResponseV2) => rows.map(row => row.case_id === id ? { ...row, response: change(structuredClone(row.response!)) } : row);
const parsedObservation = (rows: Observation[], id: string) => {
  const row = rows.find(candidate => candidate.case_id === id)!;
  const { budget: _budget, ...input } = row.input;
  return parseExtractResponseV2(JSON.stringify(row.response), input);
};

describe("predeclared core semantic protocol", () => {
  test("measured input and output bounds are inclusive and preserve honest overflow counts", () => {
    for (const [input, output, errors] of [
      [8_192, 8_192, []], [8_193, 100, ["input_budget_exceeded"]],
      [100, 8_193, ["output_budget_exceeded"]], [19_746, 8_193, ["input_budget_exceeded", "output_budget_exceeded"]],
    ] as const) {
      const rows = observations(), first = rows[0]!;
      rows[0] = { ...first, usage: { calls: 1, input_tokens: input, output_tokens: output } };
      const result = scoreCoreSemanticRun(rows, registry);
      expect(result.cases[0]!.gates.usage).toEqual([...errors]);
      expect(result.automated_passed).toBe(errors.length === 0);
      expect(rows[0]!.usage).toEqual({ calls: 1, input_tokens: input, output_tokens: output });
    }
    const rows = observations(), evidence = coreEvidence(rows), first = rows[0]!;
    rows[0] = { ...first, status: "rejected", response: null, usage: { calls: 1, input_tokens: 19_746, output_tokens: 100 } };
    const rejected = actualScoreCoreSemanticRun(rows, registry, evidence);
    expect(rejected.cases[0]!.gates.usage).toEqual(["input_budget_exceeded"]);
    expect(rejected.automated_passed).toBe(false);
  });

  test("historical Core12 is INVALID and cannot acquire a new active receipt", () => {
    const pin = INVALID_HISTORICAL_QUALIFICATIONS[0]!;
    const bytes = readFileSync(join(import.meta.dir, "../fixtures/world-qualification", pin.file), "utf8");
    const historical = JSON.parse(bytes);
    expect(sha256(bytes)).toBe(pin.sha256);
    expect(historical.observations).toHaveLength(12);
    expect(historical.observations.every((row: Observation) => row.usage.input_tokens! > row.input.budget.max_input_tokens)).toBe(true);
    expect(REVIEWED_QUALIFICATIONS.some(row => row.file === pin.file || row.sha256 === pin.sha256)).toBe(false);
    expect(() => verifyCoreSemanticReport(bytes, pin)).toThrow();
  });

  test("planning is deterministic and validates every reserve, total, and cap", () => {
    const policy = validateQualificationInputPolicy({ ...DEFAULT_QUALIFICATION_INPUT_POLICY, max_input_tokens: 32_000, input_token_overhead: 24_000 });
    const input = coreSemanticCaseInput(coreSemanticCorpus.cases[0]!, registry, policy);
    const planning = qualificationInputPlanning(input, policy), again = qualificationInputPlanning(input, policy);
    expect(planning).toEqual(again);
    expect(planning.input_token_overhead).toBe(24_000);
    expect(planning.reserved_input_tokens).toBe(planning.estimated_input_tokens + 24_000);
    expect(planning.reserved_input_tokens).toBeLessThanOrEqual(32_000);
    for (const value of [-1, 32_001, NaN, Infinity, 1.5, "24000", null])
      expect(() => validateQualificationInputPolicy({ ...policy, input_token_overhead: value })).toThrow("invalid qualification input policy");
    for (const value of [0, -1, 32_001, 1_000_001, NaN, Infinity, 1.5, "32000"])
      expect(() => validateQualificationInputPolicy({ ...policy, max_input_tokens: value })).toThrow("invalid qualification input policy");
    expect(() => validateQualificationInputPolicy({ ...policy, max_output_tokens: 8_193 })).toThrow();
    expect(() => validateQualificationInputPolicy({ ...policy, extra: true })).toThrow();
    expect(() => qualificationInputPlanning(input, { ...policy, max_input_tokens: 31_999 })).toThrow("budget mismatch");
    const under = { ...policy, max_input_tokens: planning.reserved_input_tokens - 1 };
    expect(() => qualificationInputPlanning(coreSemanticCaseInput(coreSemanticCorpus.cases[0]!, registry, under), under)).toThrow("planning rejected");
    const exact = { ...policy, max_input_tokens: planning.reserved_input_tokens };
    expect(qualificationInputPlanning(coreSemanticCaseInput(coreSemanticCorpus.cases[0]!, registry, exact), exact).reserved_input_tokens).toBe(exact.max_input_tokens);
  });

  test("reserve, estimated count, total, cap, outbound and planning hash mutations fail custody", () => {
    const policy = validateQualificationInputPolicy({ ...DEFAULT_QUALIFICATION_INPUT_POLICY, max_input_tokens: 32_000, input_token_overhead: 24_000 });
    const rows = coreSemanticCorpus.cases.map(item => scripted(item, policy)), evidence = coreEvidence(rows, undefined, policy);
    expect(actualScoreCoreSemanticRun(rows, registry, evidence).automated_passed).toBe(true);
    for (const change of [
      { estimated_input_tokens: 1 }, { input_token_overhead: 0 }, { reserved_input_tokens: 1 },
      { max_input_tokens: 32_001 }, { max_output_tokens: 1 }, { outbound_sha256: "0".repeat(64) }, { planning_sha256: "0".repeat(64) },
    ]) {
      const altered = { ...evidence, wire_receipts: evidence.wire_receipts.map((row, index) => index === 0 ? { ...row, input_planning: { ...row.input_planning, ...change } } : row) };
      const result = actualScoreCoreSemanticRun(rows, registry, altered);
      expect(result.automated_passed).toBe(false);
      expect(result.cases[0]!.gates.pipeline).toContain("custody:wire_input_planning_mismatch");
    }
    expect(actualScoreCoreSemanticRun(rows, registry, { ...evidence, input_policy: { ...policy, input_token_overhead: 23_999 } }).automated_passed).toBe(false);
    expect(actualScoreCoreSemanticRun(rows, registry, { ...evidence, traces: evidence.traces.map((row, index) => index === 0 ? { ...row, input_planning_sha256: "0".repeat(64) } : row) }).automated_passed).toBe(false);
  });

  test("qualification checks live factory reserve through wrappers and rejects fabricated or different metadata", async () => {
    const policy = validateQualificationInputPolicy({ ...DEFAULT_QUALIFICATION_INPUT_POLICY, max_input_tokens: 32_000, input_token_overhead: 24_000 });
    const context = (config: Record<string, unknown>): PortContext => ({ config, vault_path: "/nonexistent", data_dir: "/nonexistent",
      secrets: async () => { throw new Error("synthetic control has no secrets"); }, clock: () => "2000-01-01T00:00:00.000Z", logger: () => {} });
    const llm = createOpenAiCompatibleLlmPort(context({ base_url: "http://127.0.0.1:1/v1", model: "synthetic", input_token_overhead: 24_000 }));
    const producer = createModelProducerV2Port(context({}), { llm });
    try {
      expect(qualificationProducerInputOverhead(producer, policy)).toBe(24_000);
      const wrapper = inheritModelProducerIdentity(producer, { ...producer, produce: input => producer.produce(input) });
      expect(qualificationProducerInputOverhead(wrapper, policy)).toBe(24_000);
      expect(() => qualificationProducerInputOverhead(wrapper, { ...policy, input_token_overhead: 23_999 })).toThrow("reservation mismatch");
      expect(() => qualificationProducerInputOverhead({ ...producer, input_token_overhead: 24_000 }, policy)).toThrow("reservation mismatch");
      await producer.close();
      expect(() => qualificationProducerInputOverhead(wrapper, policy)).toThrow("reservation mismatch");
    } finally { await producer.close(); await llm.close(); }
  });

  test("the sealed split and scripted structural controls pass only to pending manual review", () => {
    validateCoreSemanticAssets();
    expect(coreSemanticCorpus.cases).toHaveLength(12);
    const rows = observations();
    for (const row of rows) { const { budget: _budget, ...input } = row.input, parsed = parseExtractResponseV2(JSON.stringify(row.response), input); if (!parsed.ok) throw new Error(`${row.case_id}: ${parsed.detail}`); }
    const result = scoreCoreSemanticRun(rows, registry);
    expect(result.cases.filter(row => !row.automated_passed).map(row => ({ id: row.case_id, gates: row.gates }))).toEqual([]);
    expect(result.automated_passed).toBe(true);
    expect(result.status).toBe("pending_manual_review");
    expect(result.cases.every(row => row.manual_review.status === "pending")).toBe(true);
    const report = "a".repeat(64), review = expectedCoreSemanticReview(report, result);
    expect(() => verifyCoreSemanticReview(report, result, review)).not.toThrow();
    expect(() => verifyCoreSemanticReview(report, result, { ...review, independent: false })).toThrow("review mismatch");
    expect(() => verifyCoreSemanticReview(report, result, { ...review, cases: review.cases.slice(1) })).toThrow("review mismatch");
  });

  test("negative claims, extra predicates, split targets and drops fail closed", () => {
    const negative = selectedCase("concept", "name_negative").id, positive = selectedCase("concept", "positive").id;
    const source = observations(), positiveClaim = source.find(row => row.case_id === positive)!.response!.claims[0]!;
    expect(scoreCoreSemanticRun(mutate(source, negative, response => ({ ...response, claims: [positiveClaim] })), registry).automated_passed).toBe(false);
    expect(scoreCoreSemanticRun(mutate(source, positive, response => ({ ...response, claims: [...response.claims, { ...response.claims[0]!, id: "extra" }] })), registry).automated_passed).toBe(false);
    const item = selectedCase("concept", "positive"), secondQuote = extractionRule(item).details[0]!.witness, secondAnchor = uniqueSpan(item, secondQuote);
    const split = mutate(source, positive, response => ({ ...response,
      mentions: [...response.mentions, { id: "m-target-2", label: secondQuote, anchor: secondAnchor, candidate_refs: [] }],
      claims: response.claims.map((claim, index) => index === 1 ? { ...claim, subject: { kind: "mention", id: "m-target-2" } } : claim) }));
    expect(parsedObservation(split, positive).ok).toBe(true);
    expect(scoreCoreSemanticRun(split, registry).automated_passed).toBe(false);
    expect(scoreCoreSemanticRun(source.map(row => row.case_id === positive ? { ...row, dropped: 1 } : row), registry).automated_passed).toBe(false);
  });

  test("unsupplied target nomination is exact and cannot be replaced, moved, split or omitted from the label evidence", () => {
    const item = selectedCase("concept", "reported"), id = item.id, direct = selectedCase("concept", "positive").id, source = observations();
    const supplied = item.records[0]!.subjects[0]!, suppliedAnchor = uniqueSpan(item, supplied.quote);
    const suppliedTarget = mutate(source, id, response => ({ ...response, claims: response.claims.map(claim => ({ ...claim,
      subject: { kind: "supplied", id: supplied.id },
      anchors: [...new Map([...claim.anchors, suppliedAnchor].map(anchor => [canonicalJson(anchor), anchor])).values()] })) }));
    expect(parsedObservation(suppliedTarget, id).ok).toBe(true);
    expect(scoreCoreSemanticRun(suppliedTarget, registry).automated_passed).toBe(false);

    const directItem = selectedCase("concept", "positive"), wrongSpan = uniqueSpan(directItem, extractionRule(directItem).details[0]!.witness);
    const moved = mutate(source, direct, response => ({ ...response, mentions: response.mentions.map(mention => mention.id === "m-target" ? { ...mention, anchor: wrongSpan } : mention) }));
    expect(parsedObservation(moved, direct).ok).toBe(true);
    expect(scoreCoreSemanticRun(moved, registry).automated_passed).toBe(false);

    const outOfBounds = mutate(source, direct, response => ({ ...response, mentions: response.mentions.map(mention => mention.id === "m-target"
      ? { ...mention, anchor: { ...mention.anchor, end_utf16: directItem.records[0]!.text.length + 1 } } : mention) }));
    const outOfBoundsParsed = parsedObservation(outOfBounds, direct);
    expect(outOfBoundsParsed.ok && outOfBoundsParsed.dropped.length > 0).toBe(true);
    expect(scoreCoreSemanticRun(outOfBounds, registry).automated_passed).toBe(false);

    const wrongEvent = mutate(source, direct, response => ({ ...response, mentions: response.mentions.map(mention => mention.id === "m-target"
      ? { ...mention, anchor: { ...mention.anchor, event_id: "00000000000000000000000002" } } : mention) }));
    const wrongEventParsed = parsedObservation(wrongEvent, direct);
    expect(!wrongEventParsed.ok || wrongEventParsed.dropped.length > 0).toBe(true);
    expect(scoreCoreSemanticRun(wrongEvent, registry).automated_passed).toBe(false);

    const labelWithoutTarget = mutate(source, direct, response => ({ ...response, claims: response.claims.map(claim => claim.predicate === "concept.label"
      ? { ...claim, anchors: claim.anchors.filter(anchor => canonicalJson(anchor) !== canonicalJson(response.mentions.find(mention => mention.id === "m-target")!.anchor)) } : claim) }));
    expect(parsedObservation(labelWithoutTarget, direct).ok).toBe(true);
    expect(scoreCoreSemanticRun(labelWithoutTarget, registry).automated_passed).toBe(false);
  });

  test("zero-ref reported Situation nominates a distinct exact speaker mention", () => {
    const item = selectedCase("situation", "reported"), id = item.id, source = observations(), row = source.find(candidate => candidate.case_id === id)!;
    expect(row.input.supplied_refs).toEqual([]);
    expect(scoreCoreSemanticRun(source, registry).cases.find(candidate => candidate.case_id === id)!.automated_passed).toBe(true);
    const targetAnchor = row.response!.mentions.find(mention => mention.id === "m-target")!.anchor;
    const conflated = mutate(source, id, response => ({ ...response, claims: response.claims.map(claim => claim.predicate.startsWith("situation.") && claim.predicate !== "situation.label"
      ? { ...claim, perspective: { ...claim.perspective, holder: null, speaker: { kind: "mention", id: "m-target" }, anchors: [targetAnchor] } } : claim) }));
    expect(parsedObservation(conflated, id).ok).toBe(true);
    expect(scoreCoreSemanticRun(conflated, registry).automated_passed).toBe(false);

    const wrongSpan = uniqueSpan(item, extractionRule(item).target.quote);
    const wrongSpeaker = mutate(source, id, response => ({ ...response,
      mentions: response.mentions.map(mention => mention.id === "m-source-1" ? { ...mention, anchor: wrongSpan } : mention),
      claims: response.claims.map(claim => claim.predicate.startsWith("situation.") && claim.predicate !== "situation.label"
        ? { ...claim, perspective: { ...claim.perspective, anchors: [wrongSpan] } } : claim) }));
    expect(parsedObservation(wrongSpeaker, id).ok).toBe(true);
    expect(scoreCoreSemanticRun(wrongSpeaker, registry).automated_passed).toBe(false);
  });

  test("an authored equivalent person occurrence preserves attribution without asserting durable identity", () => {
    const item = selectedCase("concept", "reported"), id = item.id, source = observations();
    const equivalent = extractionRule(item).details[0]!.equivalent_mention!;
    const name = uniqueSpan(item, equivalent.quote), role = uniqueSpan(item, equivalent.attribution_witness);
    const changed = mutate(source, id, response => ({ ...response,
      mentions: [...response.mentions, { id: "m-speaker", label: equivalent.label, anchor: name, candidate_refs: [] }],
      claims: response.claims.map(claim => claim.predicate === "concept.definition" ? { ...claim,
        perspective: { ...claim.perspective, speaker: { kind: "mention", id: "m-speaker" }, anchors: [name, role] } } : claim) }));
    expect(parsedObservation(changed, id).ok).toBe(true);
    expect(scoreCoreSemanticRun(changed, registry).automated_passed).toBe(true);
    const wrong = mutate(changed, id, response => ({ ...response,
      mentions: response.mentions.map(mention => mention.id === "m-speaker" ? { ...mention, label: "Unrelated" } : mention) }));
    expect(scoreCoreSemanticRun(wrong, registry).automated_passed).toBe(false);
  });

  test("reported historical details keep document roles and the exact interval", () => {
    const source = observations(), id = selectedCase("concept", "historical").id;
    const changed = mutate(source, id, response => {
      const definition = response.claims.find(claim => claim.predicate === "concept.definition")!;
      return { ...response, claims: response.claims.map(claim => claim.predicate === "concept.definition" ? { ...claim,
        perspective: definition.perspective } : claim) };
    });
    expect(parsedObservation(changed, id).ok).toBe(true);
    expect(scoreCoreSemanticRun(changed, registry).automated_passed).toBe(true);
    const speaker = mutate(changed, id, response => ({ ...response, claims: response.claims.map(claim => claim.predicate === "concept.definition"
      ? { ...claim, perspective: { ...claim.perspective, speaker: claim.perspective.holder, holder: null } } : claim) }));
    expect(scoreCoreSemanticRun(speaker, registry).automated_passed).toBe(false);
    const flattened = mutate(changed, id, response => ({ ...response, claims: response.claims.map(claim => claim.predicate === "concept.definition"
      ? { ...claim, perspective: { holder: null, speaker: null, addressee: null, mode: "asserted", interpretation: "explicit", anchors: [] } } : claim) }));
    expect(parsedObservation(flattened, id).ok).toBe(true);
    expect(scoreCoreSemanticRun(flattened, registry).automated_passed).toBe(false);
  });

  test("raw per-claim role citations remain failed when actual prepared evidence supplies context", () => {
    const source = observations(), item = selectedCase("situation", "reported"), id = item.id, rule = extractionRule(item);
    const detail = rule.details[0]!;
    if (typeof detail.source !== "object") throw new Error("expected authored speaker occurrence");
    const name = uniqueSpan(item, detail.source.quote), target = uniqueSpan(item, rule.target.quote), fact = uniqueSpan(item, detail.witness);
    const changed = mutate(source, id, response => ({ ...response, claims: response.claims.map(claim => claim.predicate === detail.predicate
      ? { ...claim, anchors: [target, fact], perspective: { ...claim.perspective, anchors: [name] } } : claim) }));
    expect(parsedObservation(changed, id).ok).toBe(true);
    const result = scoreCoreSemanticRun(changed, registry), scored = result.cases.find(row => row.case_id === id)!;
    expect(scored.raw_citation_precision.passed).toBe(false);
    expect(scored.raw_model.automated_passed).toBe(false);
    expect(scored.automated_passed).toBe(true);
    expect(result.status).toBe("pending_manual_review");
  });

  test("grounded legacy extras remain pending per-claim review while forbidden and typed extras fail", () => {
    const positive = selectedCase("situation", "positive"), reported = selectedCase("situation", "reported"), source = observations();
    const positiveRow = source.find(row => row.case_id === positive.id)!;
    const target = positiveRow.response!.mentions.find(mention => mention.id === "m-target")!;
    const status: RichClaimDraft = { id: "legacy-target-name", subject: { kind: "mention", id: target.id }, predicate: "identity.display_name",
      object: { kind: "literal", value: target.label }, perspective: { holder: null, speaker: null, addressee: null, mode: "asserted", interpretation: "explicit", anchors: [] },
      context: [], polarity: "positive", body: `The source names it ${target.label}.`, valid_from: null, valid_to: null, temporal_basis: "unknown", confidence: 0.8,
      sensitivity: "personal", anchors: [target.anchor] };
    const withStatus = mutate(source, positive.id, response => ({ ...response, claims: [...response.claims, status] }));
    expect(parsedObservation(withStatus, positive.id).ok).toBe(true);
    const statusResult = scoreCoreSemanticRun(withStatus, registry), statusCase = statusResult.cases.find(row => row.case_id === positive.id)!;
    expect(statusResult.automated_passed).toBe(true);
    expect(statusCase.manual_review.legacy_extras).toEqual([{ claim_id: status.id, predicate: status.predicate, claim_sha256: sha256(canonicalJson(status)) }]);
    const statusReview = expectedCoreSemanticReview("d".repeat(64), statusResult), reviewed = statusReview.cases.find(row => row.case_id === positive.id)!;
    expect("legacy_extras" in reviewed && reviewed.legacy_extras[0]).toMatchObject({ claim_id: status.id, source_entailment: "passed", references_grounded: "passed" });

    const reportedRow = source.find(row => row.case_id === reported.id)!, speaker = reportedRow.response!.mentions.find(mention => mention.id === "m-source-1")!;
    const displayName: RichClaimDraft = { ...status, id: "legacy-speaker-name", subject: { kind: "mention", id: speaker.id }, predicate: "identity.display_name",
      object: { kind: "literal", value: speaker.label }, body: `The grounded speaker is named ${speaker.label}.`, anchors: [speaker.anchor] };
    const withDisplayName = mutate(source, reported.id, response => ({ ...response, claims: [...response.claims, displayName] }));
    expect(parsedObservation(withDisplayName, reported.id).ok).toBe(true);
    expect(scoreCoreSemanticRun(withDisplayName, registry).automated_passed).toBe(true);

    for (const predicate of ["identity.same_as", "project.owns", "concept.definition"]) {
      const changed = mutate(source, positive.id, response => ({ ...response, claims: [...response.claims, { ...status, predicate }] }));
      expect(parsedObservation(changed, positive.id).ok).toBe(true);
      expect(scoreCoreSemanticRun(changed, registry).automated_passed).toBe(false);
    }
    const changedStatus = scoreCoreSemanticRun(mutate(withStatus, positive.id, response => ({ ...response, claims: response.claims.map(claim => claim.id === status.id ? { ...claim, body: `${claim.body} Unsupported.` } : claim) })), registry);
    expect(changedStatus.automated_passed).toBe(true);
    expect(() => verifyCoreSemanticReview("d".repeat(64), changedStatus, statusReview)).toThrow("review mismatch");
  });

  test("historical classification keeps its supported interval for both core kinds", () => {
    const source = observations(), baseline = scoreCoreSemanticRun(source, registry);
    for (const kind of ["concept", "situation"] as const) {
      const item = selectedCase(kind, "historical"), rule = extractionRule(item);
      if (rule.classification.time === "unknown") throw new Error("historical control requires an authored interval");
      const passing = baseline.cases.find(row => row.case_id === item.id)!;
      expect(passing.automated_passed).toBe(true);
      expect(passing.gates.time).toEqual([]);
      const changed = mutate(source, item.id, response => ({ ...response, claims: response.claims.map(claim => claim.predicate === "world.kind"
        ? { ...claim, valid_from: null, valid_to: null, temporal_basis: "unknown" } : claim) }));
      const result = scoreCoreSemanticRun(changed, registry).cases.find(row => row.case_id === item.id)!;
      expect(result.automated_passed).toBe(false);
      expect(result.gates.time).toEqual(["world.kind:time"]);
      expect(result.gates.pipeline).toEqual([]);
      expect(canonicalJson(changed.find(row => row.case_id === item.id)!.response!.claims.filter(claim => claim.predicate !== "world.kind")) ===
        canonicalJson(source.find(row => row.case_id === item.id)!.response!.claims.filter(claim => claim.predicate !== "world.kind"))).toBe(true);
    }
  });

  test("classification, witness, attribution, time and usage mutations are rejected", () => {
    const direct = selectedCase("concept", "positive").id, person = selectedCase("concept", "reported").id, document = selectedCase("concept", "historical").id;
    const source = observations();
    const changed = [
      mutate(source, direct, response => ({ ...response, claims: response.claims.map(claim => claim.predicate === "world.kind" ? { ...claim, perspective: { ...claim.perspective, mode: "reported" } } : claim) })),
      mutate(source, person, response => ({ ...response, claims: response.claims.map(claim => claim.predicate === "concept.definition" ? { ...claim, perspective: { ...claim.perspective, speaker: null, anchors: [] } } : claim) })),
      mutate(source, document, response => ({ ...response, claims: response.claims.map(claim => claim.predicate === "concept.definition" ? { ...claim, perspective: { ...claim.perspective, speaker: claim.perspective.holder } } : claim) })),
      mutate(source, document, response => ({ ...response, claims: response.claims.map(claim => ({ ...claim, valid_to: new Date(Date.parse(claim.valid_to!) + 86_400_000).toISOString() })) })),
      source.map(row => row.case_id === direct ? { ...row, usage: { ...row.usage, output_tokens: null } } : row),
    ];
    for (const observations of changed) expect(scoreCoreSemanticRun(observations, registry).automated_passed).toBe(false);
  });

  test("a changed exact response cannot reuse an independent review", () => {
    const report = "b".repeat(64), first = scoreCoreSemanticRun(observations(), registry), review = expectedCoreSemanticReview(report, first);
    const changed = scoreCoreSemanticRun(mutate(observations(), selectedCase("concept", "positive").id, response => ({ ...response, claims: response.claims.map(claim => claim.predicate === "concept.definition" && claim.object.kind === "literal" ? { ...claim, object: { ...claim.object, value: `${claim.object.value}.` } } : claim) })), registry);
    expect(changed.automated_passed).toBe(true);
    expect(() => verifyCoreSemanticReview(report, changed, review)).toThrow("review mismatch");
  });

  test("parser-valid adjacent anchors cannot bypass the original single-span literal guard", () => {
    const id = selectedCase("concept", "positive").id, source = observations(), item = coreSemanticCorpus.cases.find(row => row.id === id)!, rule = coreSemanticContract.cases.find(row => row.case_id === id)!;
    if (rule.expectation !== "extract") throw new Error("invalid test rule");
    const witness = uniqueSpan(item, rule.details[0]!.witness), midpoint = witness.start_utf16 + Math.floor((witness.end_utf16 - witness.start_utf16) / 2);
    const changed = mutate(source, id, response => ({ ...response, claims: response.claims.map(claim => claim.predicate === rule.details[0]!.predicate
      ? { ...claim, anchors: [claim.anchors[0]!, { ...witness, end_utf16: midpoint }, { ...witness, start_utf16: midpoint }] } : claim) }));
    expect(scoreCoreSemanticRun(changed, registry).automated_passed).toBe(false);
  });

  test("a semantically insufficient but parser-valid anchor change fails before independent review", () => {
    const id = selectedCase("concept", "positive").id, report = "c".repeat(64), source = observations(), first = scoreCoreSemanticRun(source, registry), review = expectedCoreSemanticReview(report, first);
    const changed = scoreCoreSemanticRun(mutate(source, id, response => ({ ...response, claims: response.claims.map(claim => claim.predicate === "concept.definition" ? { ...claim, anchors: claim.anchors.slice(0, 1) } : claim) })), registry);
    expect(changed.automated_passed).toBe(false);
    expect(changed.cases.find(row => row.case_id === id)!.gates.pipeline).toContain("c3:guard_changed_semantics");
    expect(() => verifyCoreSemanticReview(report, changed, review)).toThrow("review mismatch");
  });

  test("prepared evidence may pass while missing raw role words remains failed and immutable", () => {
    const source = observations(), item = selectedCase("concept", "reported");
    const rule = coreSemanticContract.cases.find(row => row.case_id === item.id)!;
    if (rule.expectation !== "extract") throw new Error("test rule");
    const detail = rule.details[0]!, witness = uniqueSpan(item, detail.witness);
    const named = detail.equivalent_mention ?? (typeof detail.source === "object" ? detail.source : undefined);
    if (!named) throw new Error("test requires an already authored equivalent occurrence");
    const roleAnchor = uniqueSpan(item, named.quote);
    const changed = mutate(source, item.id, response => ({ ...response,
      mentions: [...response.mentions, { id: "narrow-role", label: named.label, anchor: roleAnchor, candidate_refs: [] }],
      claims: response.claims.map(claim => claim.predicate === detail.predicate
        ? { ...claim, anchors: [uniqueSpan(item, rule.target.quote), witness], perspective: { ...claim.perspective,
          speaker: { kind: "mention" as const, id: "narrow-role" }, holder: null, anchors: [roleAnchor] } } : claim) }));
    const rawBytes = canonicalJson(changed), result = scoreCoreSemanticRun(changed, registry);
    const row = result.cases.find(row => row.case_id === item.id)!;
    expect(row.raw_citation_precision.passed).toBe(false);
    expect(row.raw_model.automated_passed).toBe(false);
    expect(row.automated_passed).toBe(true);
    expect(result.stage).toBe("prepared_admission");
    expect(row.pipeline!.prepared_admissions).toHaveLength(changed.find(row => row.case_id === item.id)!.response!.claims.length);
    expect(canonicalJson(changed)).toBe(rawBytes);
    expect(scoreCoreSemanticRun(changed, registry)).toEqual(result);
    const review = expectedCoreSemanticReview("d".repeat(64), result);
    expect(() => verifyCoreSemanticReview("d".repeat(64), result, review)).not.toThrow();
    for (const field of ["transport_response_sha256", "input_manifest_sha256", "sent_window_manifest_sha256", "prepared_admissions_sha256",
      "wire_schema", "receipt_schema", "adapter_source_sha256", "raw_model_response_sha256", "outbound_sha256",
      "transport_model_response_sha256", "resolution_receipt_sha256", "translated_response_sha256"] as const) {
      const bad = structuredClone(review); bad.cases[0]![field] = "0".repeat(64);
      expect(() => verifyCoreSemanticReview("d".repeat(64), result, bad)).toThrow("review mismatch");
    }
    expect(() => verifyCoreSemanticReview("d".repeat(64), result, { ...review, source_commit: "0".repeat(40) })).toThrow("review mismatch");
  });

  test("production preparation records a literal guard downgrade without rescuing it from broad context", () => {
    const item = selectedCase("concept", "reported"), observed = scripted(item);
    const original = structuredClone(observed.response!);
    const detail = original.claims.find(claim => claim.object.kind === "literal" && claim.perspective.mode === "reported")!;
    const response = { ...original, claims: original.claims.map(claim => claim.id === detail.id ? { ...claim, anchors: [claim.anchors[0]!] } : claim) };
    const changed = { ...observed, response }, pipeline = prepareCoreSemanticObservation(changed, registry);
    expect(pipeline.errors).toContain(`${detail.id}:guard_changed_semantics`);
    expect(pipeline.correspondence.find(row => row.claim_id === detail.id)!.guard_mode).toBe("uncertain");
    expect(scoreCoreSemanticRun(observations().map(row => row.case_id === item.id ? changed : row), registry).automated_passed).toBe(false);
  });

  test("prepared anchor accounting matches the actual production boundary", () => {
    const item = selectedCase("situation", "reported"), rule = extractionRule(item), observed = scripted(item);
    const detail = rule.details[0]!, original = observed.response!, claim = original.claims.find(row => row.predicate === detail.predicate)!;
    if (typeof detail.source !== "object" || Array.from(detail.witness).length < 7) throw new Error("expected authored grounded detail");
    const fact = uniqueSpan(item, detail.witness), role = uniqueSpan(item, detail.source.quote);
    const extra = Array.from({ length: 6 }, (_, index) => ({ ...fact,
      end_utf16: fact.start_utf16 + Array.from(detail.witness).slice(0, index + 1).join("").length }));
    const response: ExtractResponseV2 = { ...original, claims: Array.from({ length: 26 }, (_, index) => ({ ...claim, id: `boundary-${index}`,
      anchors: [uniqueSpan(item, rule.target.quote), fact], perspective: { ...claim.perspective, anchors: [role, ...extra.slice(0, index < 22 ? 6 : 5)] } })) };
    const { budget: _budget, ...input } = observed.input, parsed = parseExtractResponseV2(JSON.stringify(response), input);
    expect(parsed.ok && parsed.dropped.length === 0).toBe(true);
    const result = prepareCoreSemanticObservation({ ...observed, response }, registry);
    expect(result.errors).toEqual([]);
    expect(result.drafts).toHaveLength(26);
    expect(result.drafts.reduce((sum, draft) => sum + draft.semantic.anchors.length + draft.semantic.perspective.anchors.length, 0)).toBe(256);
    const excess = { ...response, claims: [...response.claims, { ...response.claims[0]!, id: "over-boundary" }] };
    expect(prepareCoreSemanticObservation({ ...observed, response: excess }, registry).errors).toContain("pipeline_drop_or_count");
  });

  test("the actual journal registry callback rejects a contradictory typed endpoint", () => {
    const item = selectedCase("concept", "positive"), observed = scripted(item), original = structuredClone(observed.response!);
    // Parser permits both offered kinds; the first classification must govern
    // the second through the real journal callback's pending map.
    const response: ExtractResponseV2 = { ...original, claims: [original.claims[0]!, { ...original.claims[0]!, id: "contradictory-kind",
      object: { kind: "vocabulary", ref: { kind: "vocabulary", id: "world/situation" } } }, ...original.claims.slice(1)] };
    const changed = { ...observed, response };
    const { budget: _budget, ...input } = changed.input;
    const parsed = parseExtractResponseV2(JSON.stringify(response), input);
    expect(parsed.ok && parsed.dropped.length === 0).toBe(true);
    const pipeline = prepareCoreSemanticObservation(changed, registry);
    expect(pipeline.errors).toContain("pipeline_drop_or_count");
    expect(pipeline.drafts).toHaveLength(observed.response!.claims.length);
    expect(pipeline.drafts.filter(draft => draft.semantic.predicate === "world.kind")).toHaveLength(1);
  });

  test("prepared results require an exact source and one transport binding per case", () => {
    const rows = observations(), custody = coreEvidence(rows), traces = custody.traces;
    for (const evidence of [
      { ...custody, source_commit: "UNFROZEN" },
      { ...custody, traces: traces.slice(1) },
      { ...custody, traces: [...traces, traces[0]!] },
      { ...custody, traces: traces.map((trace, index) => index === 0 ? { ...trace, response_sha256: null } : trace) },
    ]) {
      const result = actualScoreCoreSemanticRun(rows, registry, evidence);
      expect(result.automated_passed).toBe(false);
      expect(result.cases.some(row => row.gates.pipeline.includes("unbound_pipeline_evidence"))).toBe(true);
    }
  });

  test("v3 custody rejects every broken transport-to-public-response link", () => {
    const rows = observations(), baseline = coreEvidence(rows), first = baseline.wire_receipts[0]!;
    const changed: ReturnType<typeof coreEvidence>[] = [];
    changed.push({ ...baseline, wire_receipts: baseline.wire_receipts.map((row, index) => index === 0 ? { ...row, producer_input_token_overhead: 1 } : row) });
    changed.push({ ...baseline, wire_receipts: baseline.wire_receipts.slice(1) });
    changed.push({ ...baseline, wire_receipts: [...baseline.wire_receipts, first] });
    changed.push({ ...baseline, wire_receipts: baseline.wire_receipts.map((row, index) => index === 0 ? { ...row, transport_response_sha256: "0".repeat(64) } : row) });
    changed.push({ ...baseline, wire_receipts: baseline.wire_receipts.map((row, index) => index === 0 ? { ...row, adapter_source_sha256: "0".repeat(64) } : row) });
    changed.push({ ...baseline, traces: baseline.traces.map((row, index) => index === 0 ? { ...row, model_response_sha256: "0".repeat(64) } : row) });
    const mutateReceipt = (change: (receipt: ModelExtractionWireReceipt) => ModelExtractionWireReceipt) => ({ ...baseline,
      wire_receipts: baseline.wire_receipts.map((row, index) => { if (index !== 0) return row; const receipt = change(structuredClone(row.receipt));
        return { ...row, receipt, resolution_receipt_sha256: sha256(canonicalJson(receipt)) }; }) });
    changed.push(mutateReceipt(receipt => ({ ...receipt, outbound_sha256: "0".repeat(64) })));
    changed.push(mutateReceipt(receipt => ({ ...receipt, raw_response_sha256: "0".repeat(64) })));
    changed.push(mutateReceipt(receipt => ({ ...receipt, translated_response_sha256: "0".repeat(64) })));
    changed.push(mutateReceipt(receipt => ({ ...receipt, events: receipt.events.map((event, index) => index === 0 ? { ...event, text_sha256: "0".repeat(64) } : event) })));
    if (first.receipt.resolutions.length === 0) throw new Error("custody control requires a resolved descriptor");
    changed.push(mutateReceipt(receipt => ({ ...receipt, resolutions: receipt.resolutions.map((resolution, index) => index === 0
      ? { ...resolution, anchor: { ...resolution.anchor, start_utf16: resolution.anchor.start_utf16 + 1 } } : resolution) })));
    for (const evidence of changed) {
      const result = actualScoreCoreSemanticRun(rows, registry, evidence);
      expect(result.automated_passed).toBe(false);
      expect(result.cases.some(row => row.gates.pipeline.some(error => error.startsWith("custody:")))).toBe(true);
    }
  });

  test("runner mode fixes the full split and emits only a pending core result without a model", async () => {
    const directory = mkdtempSync(join(tmpdir(), "core-semantic-runner-"));
    try {
      await expect(runQualification({ protocol: "unknown" as never, kinds: ["concept", "situation"] })).rejects.toThrow("unknown qualification protocol");
      await expect(runQualification({ protocol: "core-semantic-v3", kinds: ["concept", "situation"], case_ids: [coreSemanticCorpus.cases[0]!.id] })).rejects.toThrow("fixed core split");
      await expect(runQualification({ protocol: "core-semantic-v3", kinds: ["concept", "situation"],
        input_policy: { ...DEFAULT_QUALIFICATION_INPUT_POLICY, max_input_tokens: 32_001 } })).rejects.toThrow("invalid qualification input policy");
      await expect(runQualification({ kinds: ["concept", "situation"], input_policy: DEFAULT_QUALIFICATION_INPUT_POLICY })).rejects.toThrow("input policy requires core semantic protocol");
      const output = join(directory, "pending.json"), result = await runQualification({ protocol: "core-semantic-v3", kinds: ["concept", "situation"], output });
      expect(result.core_semantic.status).toBe("pending_manual_review");
      expect(result.core_semantic.automated_passed).toBe(false);
      expect(result.traces).toEqual([]);
      expect(result.missing).toContain("model_unconfigured");
      const stored = JSON.parse(readFileSync(output, "utf8"));
      expect(stored.protocol).toBe("core-semantic-v3");
      expect(Object.hasOwn(stored, "score")).toBe(false);
      expect(Object.hasOwn(stored, "supplemental")).toBe(false);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  test("the actual runner binds the decoded ChatCompletion text and rejects a rehashed raw-message substitution", async () => {
    const observed = scripted(coreSemanticCorpus.cases[0]!), control = wireControl(observed);
    const completion = { id: "core-v3-custody-control", object: "chat.completion", created: 1, model: "synthetic",
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: control.rawText } }],
      usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 } };
    let stop = false;
    const server = startFakeEndpoint(() => { stop = true; return Response.json(completion); });
    try {
      const result = await runQualification({ protocol: "core-semantic-v3", kinds: ["concept", "situation"], base_url: server.base_url,
        model: "synthetic", stopped: () => stop });
      expect(server.requests).toHaveLength(1);
      expect(result.observations).toHaveLength(1);
      expect(result.traces).toHaveLength(1);
      expect(result.wire_receipts).toHaveLength(1);
      const trace = result.traces[0]!, receiptRow = result.wire_receipts[0]!;
      expect(trace.response_sha256).toBe(sha256(canonicalJson(completion)));
      expect(trace.model_response_sha256).toBe(sha256(control.rawText));
      expect(receiptRow.receipt.raw_response_sha256).toBe(trace.model_response_sha256!);
      expect(result.core_semantic.cases.find(row => row.case_id === observed.case_id)!.automated_passed).toBe(true);

      const receipt = { ...receiptRow.receipt, raw_response_sha256: "0".repeat(64) };
      const tampered = actualScoreCoreSemanticRun(result.observations, registry, { source_commit: result.source_commit, input_policy: result.input_policy, traces: result.traces,
        wire_adapter: result.wire_adapter, wire_receipts: [{ ...receiptRow, receipt, resolution_receipt_sha256: sha256(canonicalJson(receipt)) }] });
      const changed = tampered.cases.find(row => row.case_id === observed.case_id)!;
      expect(changed.automated_passed).toBe(false);
      expect(changed.gates.pipeline).toContain("custody:wire_raw_response_mismatch");
    } finally { server.stop(); }
  });

  test("actual runner binds the reserve and preserves measured usage inside and outside either cap", async () => {
    const policy = validateQualificationInputPolicy({ ...DEFAULT_QUALIFICATION_INPUT_POLICY, max_input_tokens: 32_000, input_token_overhead: 24_000 });
    const item = coreSemanticCorpus.cases[0]!, observed = scripted(item, policy), control = wireControl(observed, "b".repeat(64), policy);
    for (const [input, output, expectedStatus, usageErrors] of [
      [19_746, 100, "ok", []], [32_001, 100, "rejected", ["input_budget_exceeded"]],
      [19_746, 8_193, "rejected", ["output_budget_exceeded"]],
    ] as const) {
      let stop = false;
      const server = startFakeEndpoint(() => {
        stop = expectedStatus === "ok";
        return Response.json({ id: "synthetic-budget-control", object: "chat.completion", created: 1, model: "synthetic",
          choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: control.rawText } }],
          usage: { prompt_tokens: input, completion_tokens: output, total_tokens: input + output } });
      });
      try {
        const result = await runQualification({ protocol: "core-semantic-v3", kinds: ["concept", "situation"], input_policy: policy,
          base_url: server.base_url, model: "synthetic", stopped: () => stop });
        expect(server.requests).toHaveLength(1);
        expect(result.input_policy).toEqual(policy);
        expect(result.observations[0]!.status).toBe(expectedStatus);
        expect(result.halt_reason).toBe(expectedStatus === "ok" ? "requested_stop" : "automated_failure");
        expect(result.observations[0]!.usage).toEqual({ calls: 1, input_tokens: input, output_tokens: output });
        expect(result.core_semantic.cases[0]!.gates.usage).toEqual([...usageErrors]);
        expect(result.wire_receipts).toHaveLength(expectedStatus === "ok" ? 1 : 0);
        expect(result.traces[0]!.input_planning_sha256).toBe(qualificationInputPlanning(observed.input, policy).planning_sha256);
        if (expectedStatus === "ok") expect(result.wire_receipts[0]!.input_planning).toEqual(qualificationInputPlanning(observed.input, policy));
      } finally { server.stop(); }
    }
  });

  test("the prior 19,746-input over 8,192-budget failure stops before a wire receipt", async () => {
    const control = wireControl(scripted(coreSemanticCorpus.cases[0]!));
    const server = startFakeEndpoint(() => Response.json({ id: "synthetic-prior-budget-control", object: "chat.completion", created: 1, model: "synthetic",
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: control.rawText } }],
      usage: { prompt_tokens: 19_746, completion_tokens: 100, total_tokens: 19_846 } }));
    try {
      const result = await runQualification({ protocol: "core-semantic-v3", kinds: ["concept", "situation"], base_url: server.base_url, model: "synthetic" });
      expect(server.requests).toHaveLength(1);
      expect(result.observations[0]!.input.budget.max_input_tokens).toBe(8_192);
      expect(result.observations[0]!.usage.input_tokens).toBe(19_746);
      expect(result.observations[0]!.status).toBe("rejected");
      expect(result.core_semantic.cases[0]!.gates.usage).toEqual(["input_budget_exceeded"]);
      expect(result.halt_reason).toBe("automated_failure");
      expect(result.wire_receipts).toEqual([]);
    } finally { server.stop(); }
  });

  test("the CLI refuses missing or wrong protocols without a success summary", () => {
    const directory = mkdtempSync(join(tmpdir(), "core-semantic-cli-"));
    try {
      const path = join(directory, "report.json");
      for (const report of [null, {}, { protocol: "core-semantic-v1" }, { protocol: "core-semantic-v2" }, { protocol: "baseline" }]) {
        const bytes = JSON.stringify(report); writeFileSync(path, bytes);
        const result = Bun.spawnSync([process.execPath, join(import.meta.dir, "verify-core-semantic.ts"),
          "--report", path, "--report-sha256", sha256(bytes), "--review-file", "unused.json",
          "--review-sha256", "a".repeat(64), "--endpoint-evidence", "b".repeat(64)]);
        expect(result.exitCode).toBe(1);
        expect(result.stdout.toString()).toBe("");
        expect(result.stderr.toString().trim()).toBe("core semantic verification failed");
      }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  test("registry acceptance requires the exact report and separate hash-bound independent review", () => {
    const directory = mkdtempSync(join(tmpdir(), "core-semantic-review-"));
    try {
      for (const path of RUNNER_FILES) { mkdirSync(dirname(join(directory, path)), { recursive: true }); writeFileSync(join(directory, path), readFileSync(join(import.meta.dir, "../..", path))); }
      const rows = observations(), evidence = coreEvidence(rows), result = actualScoreCoreSemanticRun(rows, registry, evidence), started = Date.UTC(2026, 9, 22);
      const traces = rows.map((row, index) => ({ case_id: row.case_id, prompt_sha256: sha256(extractionV2SystemContent(row.input)), transport: "ok" as const,
        input_planning_sha256: evidence.wire_receipts[index]!.input_planning.planning_sha256, request_sha256: "a".repeat(64), response_sha256: "b".repeat(64), model_response_sha256: evidence.wire_receipts[index]!.receipt.raw_response_sha256,
        origin: "observed_v3" as const, http_status: 200,
        started_at: new Date(started + index * (RESPONSE_GAP_MS + 1_000)).toISOString(), completed_at: new Date(started + index * (RESPONSE_GAP_MS + 1_000) + 1_000).toISOString() }));
      const report = { schema: "kizuki.world-qualification-run/v3" as const, protocol: "core-semantic-v3" as const, evidence: "runner_observed_transport" as const,
        input_policy: DEFAULT_QUALIFICATION_INPUT_POLICY, synthetic: true, source_clean: true, source_commit: "a".repeat(40), runner_sha256: runnerDigest(directory), registry_sha256: registryDigest(registry),
        model: "synthetic-verifier-control", endpoint_host: "127.0.0.1:1", selected_kinds: ["concept", "situation"], selected_extensions: [],
        corpus: coreSemanticCorpus, observations: rows, traces, missing: [], selected_cases: rows.map(row => row.case_id), resumed_from: null, halt_reason: null,
        response_gap_ms: RESPONSE_GAP_MS, attempts: rows.length, case_states: rows.map(row => ({ case_id: row.case_id, status: "observed" as const })),
        prompt_sha256: traces[0]!.prompt_sha256, prompt_sha256_by_case: Object.fromEntries(traces.map(trace => [trace.case_id, trace.prompt_sha256])),
        limitations: ["synthetic verifier control"], wire_adapter: evidence.wire_adapter, wire_receipts: evidence.wire_receipts, core_semantic: result };
      const bytes = JSON.stringify(report), reportSha256 = sha256(bytes), review = JSON.stringify(expectedCoreSemanticReview(reportSha256, result));
      const fixture = join(directory, "scripts/fixtures/world-qualification/core-semantic-review.json");
      mkdirSync(dirname(fixture), { recursive: true }); writeFileSync(fixture, review);
      const approval = { file: "core-semantic-control.json", sha256: reportSha256, endpoint_evidence: "c".repeat(64),
        protocol: "core-semantic-v3" as const, body_review: { file: "core-semantic-review.json", sha256: sha256(review) } };
      expect(() => verifyQualificationReceipt(bytes, { file: approval.file, sha256: approval.sha256, endpoint_evidence: approval.endpoint_evidence,
        protocol: "core-semantic-v3" }, registry, directory)).toThrow("independent review missing");
      const checked = verifyQualificationReceipt(bytes, approval, registry, directory);
      expect(verifyCoreSemanticReport(bytes, approval, directory)).toEqual(checked);
      for (const protocol of [undefined, "core-semantic-v1", "baseline"]) {
        const wrong = JSON.stringify({ ...report, protocol });
        expect(() => verifyCoreSemanticReport(wrong, { ...approval, sha256: sha256(wrong) }, directory)).toThrow("core semantic protocol required");
      }
      expect(() => checkOfferedQualification(registry, [checked])).not.toThrow();
      for (const changed of [
        { ...report, input_policy: undefined },
        { ...report, input_policy: { ...report.input_policy, input_token_overhead: 1 } },
        { ...report, input_policy: { ...report.input_policy, max_input_tokens: 32_000 } },
        { ...report, input_policy: { ...report.input_policy, input_token_overhead: Infinity } },
        { ...report, traces: report.traces.map((row, index) => index === 0 ? { ...row, input_planning_sha256: undefined } : row) },
        { ...report, wire_receipts: report.wire_receipts.map((row, index) => index === 0 ? { ...row, input_planning: undefined } : row) },
        { ...report, wire_adapter: { ...report.wire_adapter, source_sha256: "0".repeat(64) } },
        { ...report, wire_receipts: report.wire_receipts.slice(1) },
        { ...report, wire_receipts: report.wire_receipts.map((row, index) => index === 0 ? { ...row, resolution_receipt_sha256: "0".repeat(64) } : row) },
      ]) {
        const changedBytes = JSON.stringify(changed);
        expect(() => verifyQualificationReceipt(changedBytes, { ...approval, sha256: sha256(changedBytes) }, registry, directory)).toThrow();
      }
      const changedReview = JSON.stringify({ ...JSON.parse(review), independent: false }); writeFileSync(fixture, changedReview);
      expect(() => verifyQualificationReceipt(bytes, { ...approval, body_review: { ...approval.body_review, sha256: sha256(changedReview) } }, registry, directory)).toThrow("review mismatch");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
