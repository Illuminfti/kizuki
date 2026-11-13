import { afterAll, beforeAll, expect, test } from "bun:test";
import { coreSemanticAssets, coreSemanticCaseInput, expectedCoreSemanticReview, prepareCoreSemanticObservation, scoreCoreSemanticRun, scoreCoreSemanticRepresentations, type CoreSemanticCase } from "./core-semantic";
import { registryDigest, verifyQualificationReceipt } from "./registry";
import { WORLD_VOCABULARY_MODULES } from "./candidate-modules";
import { DEFAULT_QUALIFICATION_INPUT_POLICY } from "./input-planning";
import { parseExtractResponseV2, type DraftRef, type ExtractResponseV2, type RichClaimDraft } from "../../packages/core/src/contracts/producer-v2";
import type { Observation } from "./score";
import { validateScopedBranch, type ScopedExtractBranch } from "./union-propositions";
import { createWorldUnionCandidateRegistry } from "../../packages/core/src/contracts/world-union-profile";
import { WORLD_REGISTRY } from "../../packages/core/src/contracts/world-vocabulary";
import unionCorpus from "./core-semantic-union-corpus.json";
import unionContract from "./core-semantic-union-contract.json";
import { validateUnionContract } from "./union-assets";
import { modelQuoteAnchorForSpan, resolveModelExtractionWire, MODEL_EXTRACTION_WIRE_SCHEMA } from "../../packages/core/src/producer/model-v2-wire";
import { scriptedUnionObservations, scriptedWire } from "./union-test-fixtures";
import { modelWireAdapterIdentity } from "./wire-custody";
import { canonicalJson, sha256 } from "../evaluate-extraction";
import { WORLD_UNION_CANDIDATE_KINDS, WORLD_UNION_CANDIDATE_EXTENSIONS } from "../../packages/core/src/contracts/world-union-profile";
import { extractionV2SystemContent } from "../../packages/core/src/producer/prompt-v2";
import { RESPONSE_GAP_MS } from "./pacing";
import { RUNNER_FILES, runnerDigest } from "./fingerprint";
import { verifyCoreSemanticReport } from "./verify-core-semantic";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { runQualification } from "./run";
import { UNION_INPUT_POLICY } from "./union-assets";

// These are scripted method controls, never model observations or qualifications.
const registry = createWorldUnionCandidateRegistry(WORLD_VOCABULARY_MODULES);
const policy = { ...DEFAULT_QUALIFICATION_INPUT_POLICY, max_input_tokens: 32_000, input_token_overhead: 24_000 };
const direct = { holder: null, speaker: null, addressee: null, mode: "asserted", interpretation: "explicit" } as const;
const unknown = { valid_from: null, valid_to: null, temporal_basis: "unknown" } as const;
test("the active registry uses the canonical nine-kind union composition without attesting qualification", () => {
  expect(registryDigest(WORLD_REGISTRY)).toBe(registryDigest(registry));
  expect(WORLD_REGISTRY.kinds.filter(kind => kind.offeredToProducer).map(kind => kind.id).sort()).toEqual([...WORLD_UNION_CANDIDATE_KINDS].sort());
});
type Selector = { mode: "structured_source_subject"; record: string; subject_id: string } | { mode: "source_occurrence"; record: string; label: string };
type Mutable<T> = { -readonly [K in keyof T]: T[K] extends object ? Mutable<T[K]> : T[K] };
type Perspective = { holder: Selector | null; speaker: Selector | null; addressee: Selector | null; mode: RichClaimDraft["perspective"]["mode"]; interpretation: "explicit" | "inferred" };
type Rule = { rule_id: string; subject: Selector; predicate: string; object: { kind: "literal"; required_atoms: string[] } | { kind: "vocabulary"; value: string } | { kind: "subject"; entity: Selector };
  witness: string; perspective: Perspective; polarity: "positive" | "negative"; time: { valid_from: string | null; valid_to: string | null; temporal_basis: "unknown" | "explicit"; witness?: string }; context: Selector[];
  witness_mode?: "selected_entity_label/v1"; required_relation_atoms?: string[]; attribution_witness?: string };
const supplied = (record: string, subject_id: string): Selector => ({ mode: "structured_source_subject", record, subject_id });
const literal = (value: string) => ({ kind: "literal" as const, required_atoms: [value] });
const vocabulary = (value: string) => ({ kind: "vocabulary" as const, value });
function control(records: CoreSemanticCase["records"], rules: Rule[], entities: { record: string; label: string }[] = [], completeEvidence = false, caseId = "union-scripted-control") {
  const item = { id: caseId, kind: "person", category: "positive", source_type: "direct_record", records } as unknown as CoreSemanticCase;
  const input = coreSemanticCaseInput(item, registry, policy);
  const span = (record: string, quote: string, repeated = false) => {
    const index = records.findIndex(r => r.id === record), text = records[index]!.text, start = text.indexOf(quote);
    if (start < 0 || (!repeated && text.indexOf(quote, start + 1) >= 0)) throw Error("control quote must be unique");
    return { event_id: input.events[index]!.event_id, start_utf16: start, end_utf16: start + quote.length };
  };
  const mentions = entities.map((entity, index) => ({ id: `m${index}`, label: entity.label, anchor: span(entity.record, entity.label, true), candidate_refs: [] }));
  const ref = (selector: Selector): DraftRef => {
    if (selector.mode === "source_occurrence") return { kind: "mention", id: mentions.find(m => m.label === selector.label && m.anchor.event_id === input.events[records.findIndex(r => r.id === selector.record)]!.event_id)!.id };
    const name = records.find(r => r.id === selector.record)!.structured_subjects!.find(s => s.subject_id === selector.subject_id)!.display_name!;
    const anchor = span(selector.record, name), handle = input.supplied_refs.find(h => h.anchors.some(a => JSON.stringify(a) === JSON.stringify(anchor)));
    if (!handle) throw Error("genuine structured handle missing");
    return { kind: "supplied", id: handle.id };
  };
  const refAnchor = (value: DraftRef) => value.kind === "mention" ? [mentions.find(m => m.id === value.id)!.anchor] : input.supplied_refs.find(s => s.id === value.id)!.anchors;
  const claims: RichClaimDraft[] = rules.map((rule, index) => {
    const subject = ref(rule.subject), context = rule.context.map(ref);
    const perspective = { ...rule.perspective, holder: rule.perspective.holder && ref(rule.perspective.holder), speaker: rule.perspective.speaker && ref(rule.perspective.speaker),
      addressee: rule.perspective.addressee && ref(rule.perspective.addressee), anchors: [] as RichClaimDraft["anchors"] };
    const name = rule.subject.mode === "source_occurrence" ? rule.subject.label : records.find(r => r.id === rule.subject.record)!.structured_subjects!.find(s => s.subject_id === (rule.subject as { subject_id: string }).subject_id)!.display_name!;
    const source = records.find(r => r.id === rule.subject.record)!.text;
    // A scripted source-copy example, not a normative literal whitelist.
    const literalValue = rule.object.kind !== "literal" ? "" : rule.witness_mode ? name
      : source.includes(rule.object.required_atoms[0]!) ? rule.object.required_atoms[0]! : rule.witness;
    const object: RichClaimDraft["object"] = rule.object.kind === "literal" ? { kind: "literal", value: literalValue }
      : rule.object.kind === "vocabulary" ? { kind: "vocabulary", ref: { kind: "vocabulary", id: rule.object.value } } : { kind: "subject", ref: ref(rule.object.entity) };
    perspective.anchors = [perspective.holder, perspective.speaker, perspective.addressee].flatMap(v => v ? refAnchor(v) : []);
    const evidence = rule.witness_mode ? [] : [span(rule.subject.record, rule.witness)];
    const anchors = [...evidence, ...refAnchor(subject), ...(object.kind === "subject" ? refAnchor(object.ref) : []), ...context.flatMap(refAnchor),
      ...(completeEvidence && rule.time.witness ? [span(rule.subject.record, rule.time.witness)] : []),
      ...(completeEvidence && rule.attribution_witness ? [span(rule.subject.record, rule.attribution_witness)] : [])];
    const unique = <T>(values: readonly T[]): T[] => [...new Map(values.map(v => [JSON.stringify(v), v])).values()];
    perspective.anchors = unique(perspective.anchors);
    return { id: `c${index}`, subject, predicate: rule.predicate, object, perspective, context, polarity: rule.polarity,
      valid_from: rule.time.valid_from, valid_to: rule.time.valid_to, temporal_basis: rule.time.temporal_basis,
      body: rule.required_relation_atoms?.join(" ") ?? (rule.object.kind === "literal" ? literalValue : rule.witness), confidence: 0.5, sensitivity: "personal", anchors: unique(anchors) };
  });
  const branch = { id: "whole-source", scope: "world-union/v1", entities: entities.map(entity => {
    const text = records.find(r => r.id === entity.record)!.text, spans = []; let at = text.indexOf(entity.label);
    while (at >= 0) { spans.push({ start_utf16: at, end_utf16: at + entity.label.length }); at = text.indexOf(entity.label, at + 1); }
    return { ...entity, allowed_occurrence_spans: spans, consistency: "same selected source occurrence" };
  }),
    propositions: rules, forbidden_assertions: ["invented identity, perspective, time, execution or certainty"] };
  const { budget: _, ...parseInput } = input;
  const parsed = parseExtractResponseV2(JSON.stringify({ schema: "kizuki.producer-response/v2", mentions, claims }), parseInput);
  if (!parsed.ok || parsed.dropped.length) throw Error("scripted control must parse without drops");
  const observed: Observation = { case_id: item.id, input, status: "ok", response: parsed.response, dropped: 0, usage: { calls: 1, input_tokens: 100, output_tokens: 100 } };
  const score = () => scoreCoreSemanticRepresentations(item, { case_id: item.id, expectation: "extract", branches: [branch] } as never, observed, registry, policy);
  return { item, branch, observed, response: parsed.response as Mutable<ExtractResponseV2>, score, ref };
}
function roles() {
  const text = 'The catalogue identifies Uma as a person and as the sole referent of "the catalogue subject" in both quotations. The structured person Vesa states: "The catalogue subject\'s role is navigation instructor." The structured person Daro states: "The catalogue subject\'s role is not navigation instructor."';
  const record = { id: "r1", text, subjects: [], structured_subjects: [
    { subject_id: "target", role: "about" as const, display_name: "Uma" }, { subject_id: "affirm", role: "from" as const, display_name: "Vesa" }, { subject_id: "deny", role: "from" as const, display_name: "Daro" }] };
  const rules: Rule[] = record.structured_subjects.flatMap(s => [
    { rule_id: `${s.subject_id}-kind`, subject: supplied("r1", s.subject_id), predicate: "world.kind", object: vocabulary("world/person"), witness: text, perspective: direct, polarity: "positive", time: unknown, context: [] },
    { rule_id: `${s.subject_id}-label`, subject: supplied("r1", s.subject_id), predicate: "person.label", object: literal(s.display_name), witness: s.display_name, perspective: direct, polarity: "positive", time: unknown, context: [], witness_mode: "selected_entity_label/v1" },
  ]);
  for (const [speaker, polarity] of [["affirm", "positive"], ["deny", "negative"]] as const) rules.push({ rule_id: `role-${speaker}`, subject: supplied("r1", "target"), predicate: "person.role", object: literal("navigation instructor"), witness: text,
    perspective: { ...direct, holder: supplied("r1", speaker), speaker: supplied("r1", speaker), mode: "quoted" }, attribution_witness: text, polarity, time: unknown, context: [] });
  return control([record], rules);
}
test("union scoped roles preselect exact speakers and opposite polarity before cardinality", () => {
  const f = roles();
  expect(prepareCoreSemanticObservation(f.observed, registry, f.item).errors).toEqual([]);
  expect(f.score().automated_passed).toBe(true);
  const negative = f.response.claims.find(c => c.predicate === "person.role" && c.polarity === "negative")!;
  negative.perspective.speaker = f.ref(supplied("r1", "affirm"));
  expect(f.score().automated_passed).toBe(false);
});
test("union labels require the selected genuine Person's own exact name witness", () => {
  const f = roles();
  expect(f.score().automated_passed).toBe(true);
  const labels = f.response.claims.filter(c => c.predicate === "person.label");
  labels[0]!.anchors = labels[1]!.anchors;
  expect(f.score().automated_passed).toBe(false);
});
test("union rejects erased polarity, asserted quote, omitted attribution, duplicate and missing role", () => {
  for (const change of [
    (r: Mutable<ExtractResponseV2>) => { r.claims.find(c => c.polarity === "negative")!.polarity = "positive"; },
    (r: Mutable<ExtractResponseV2>) => { r.claims.find(c => c.predicate === "person.role")!.perspective.mode = "asserted"; },
    (r: Mutable<ExtractResponseV2>) => { r.claims.find(c => c.predicate === "person.role")!.perspective.speaker = null; },
    (r: Mutable<ExtractResponseV2>) => { const c = r.claims.find(c => c.predicate === "person.role")!; r.claims.push({ ...structuredClone(c), id: "duplicate" }); },
    (r: Mutable<ExtractResponseV2>) => { r.claims.pop(); },
  ]) { const f = roles(); change(f.response); expect(f.score().automated_passed).toBe(false); }
});
test("union literal source copying has no case normalizer or finite value whitelist", () => {
  const f = roles(), c = f.response.claims.find(c => c.predicate === "person.role" && c.polarity === "positive")!;
  c.object = { kind: "literal", value: "navigation instructor." };
  expect(f.score().automated_passed).toBe(true);
  c.object.value = "NAVIGATION INSTRUCTOR";
  expect(f.score().automated_passed).toBe(false);
});
test("union validates its original32 proposition and8 local-entity bounds", () => {
  const f = roles(); validateScopedBranch(f.item, f.branch as ScopedExtractBranch, registry);
  const many = structuredClone(f.branch) as ScopedExtractBranch;
  while (many.propositions.length < 33) many.propositions.push({ ...structuredClone(many.propositions.at(-1)!), rule_id: `extra-${many.propositions.length}` });
  expect(() => validateScopedBranch(f.item, many, registry)).toThrow("invalid union branch");
  const entities = structuredClone(f.branch) as ScopedExtractBranch;
  while (entities.entities.length < 9) entities.entities.push({ record: "r1", label: `entity-${entities.entities.length}`, allowed_occurrence_spans: [], consistency: "synthetic bound mutant" });
  expect(() => validateScopedBranch(f.item, entities, registry)).toThrow("invalid union branch");
});

function qualified() {
  const records = [
    { id: "r1", text: "The structured person Inez has a relationship with the structured person Siv in Copper Trial from 2027-06-02T08:00:00Z until 2027-06-09T17:00:00Z, with the end excluded.", subjects: [],
      structured_subjects: [{ subject_id: "item", role: "about" as const, display_name: "Inez" }, { subject_id: "other", role: "about" as const, display_name: "Siv" }, { subject_id: "trial", role: "about" as const, display_name: "Copper Trial" }] },
    { id: "r2", text: "The separate structured person Inez viewed one page about Letter spacing. Letter spacing means the distance between adjacent letters. The single view is a weak signal of possible interest only.", subjects: [],
      structured_subjects: [{ subject_id: "item", role: "about" as const, display_name: "Inez" }] },
  ];
  // Select one exact occurrence, while acknowledging every authored occurrence.
  records[1]!.text = "The separate structured person Inez viewed one page. Letter spacing is a concept meaning the distance between adjacent letters. The page view concerned that concept and is a weak signal of possible interest only.";
  const rules: Rule[] = [];
  for (const [record, id, name] of [["r1", "item", "Inez"], ["r1", "other", "Siv"], ["r2", "item", "Inez"]]) rules.push(
    { rule_id: `${record}-${id}-kind`, subject: supplied(record!, id!), predicate: "world.kind", object: vocabulary("world/person"), witness: records.find(r => r.id === record)!.text, perspective: direct, polarity: "positive", time: unknown, context: [] },
    { rule_id: `${record}-${id}-label`, subject: supplied(record!, id!), predicate: "person.label", object: literal(name!), witness: name!, perspective: direct, polarity: "positive", time: unknown, context: [], witness_mode: "selected_entity_label/v1" },
  );
  const concept: Selector = { mode: "source_occurrence", record: "r2", label: "Letter spacing" };
  const definition = "Letter spacing is a concept meaning the distance between adjacent letters.";
  rules.push(
    { rule_id: "concept-kind", subject: concept, predicate: "world.kind", object: vocabulary("world/concept"), witness: definition, perspective: direct, polarity: "positive", time: unknown, context: [] },
    { rule_id: "concept-label", subject: concept, predicate: "concept.label", object: literal("Letter spacing"), witness: "Letter spacing", perspective: direct, polarity: "positive", time: unknown, context: [], witness_mode: "selected_entity_label/v1" },
    { rule_id: "concept-definition", subject: concept, predicate: "concept.definition", object: literal("the distance between adjacent letters"), witness: definition, perspective: direct, polarity: "positive", time: unknown, context: [] },
    { rule_id: "interest", subject: supplied("r2", "item"), predicate: "person.interest", object: { kind: "subject", entity: concept }, required_relation_atoms: ["possible interest from one page view"], witness: records[1]!.text,
      perspective: { ...direct, mode: "uncertain", interpretation: "inferred" }, polarity: "positive", time: unknown, context: [] },
    { rule_id: "relationship", subject: supplied("r1", "item"), predicate: "relationship.with", object: { kind: "subject", entity: supplied("r1", "other") }, required_relation_atoms: ["the first Inez has the stated relationship with Siv in Copper Trial"], witness: records[0]!.text,
      perspective: direct, polarity: "positive", time: { valid_from: "2027-06-02T08:00:00.000Z", valid_to: "2027-06-09T17:00:00.000Z", temporal_basis: "explicit", witness: records[0]!.text }, context: [supplied("r1", "trial")] },
  );
  return control(records, rules, [{ record: "r2", label: "Letter spacing" }]);
}
test("union preserves genuine source namespaces, inferred interest and exact interval/context", () => {
  const f = qualified();
  validateScopedBranch(f.item, f.branch as ScopedExtractBranch, registry);
  expect(f.ref(supplied("r1", "item"))).not.toEqual(f.ref(supplied("r2", "item")));
  expect(prepareCoreSemanticObservation(f.observed, registry, f.item).errors).toEqual([]);
  expect(f.score().automated_passed).toBe(true);
  const c = f.response.claims.find(c => c.predicate === "relationship.with")!;
  c.valid_from = "2027-06-02T08:00:00Z";
  expect(f.score().automated_passed).toBe(true);
});
test("union refuses namespace swap, inferred-interest certainty, changed time/context and endpoint direction", () => {
  for (const change of [
    (f: ReturnType<typeof qualified>) => { f.response.claims.find(c => c.predicate === "person.interest")!.subject = f.ref(supplied("r1", "item")); },
    (f: ReturnType<typeof qualified>) => { f.response.claims.find(c => c.predicate === "person.interest")!.perspective.mode = "asserted"; },
    (f: ReturnType<typeof qualified>) => { f.response.claims.find(c => c.predicate === "person.interest")!.perspective.interpretation = "explicit"; },
    (f: ReturnType<typeof qualified>) => { f.response.claims.find(c => c.predicate === "relationship.with")!.valid_to = "2027-06-09T17:00:00.001Z"; },
    (f: ReturnType<typeof qualified>) => { f.response.claims.find(c => c.predicate === "relationship.with")!.context = []; },
    (f: ReturnType<typeof qualified>) => { const c = f.response.claims.find(c => c.predicate === "relationship.with")!; if (c.object.kind === "subject") [c.subject, c.object.ref] = [c.object.ref, c.subject]; },
  ]) { const f = qualified(); change(f); expect(f.score().automated_passed).toBe(false); }
  const f = qualified();
  const interest = f.response.claims.find(c => c.predicate === "person.interest")!;
  interest.perspective.mode = "asserted";
  expect(prepareCoreSemanticObservation(f.observed, registry, f.item).errors).toContain(`${interest.id}:guard_changed_semantics`);
});
test("union historical label exception does not waive the claim's temporal evidence", () => {
  const text = "The structured person Inez used this name throughout the interval from 2021-07-06T09:00:00Z until 2021-07-09T18:00:00Z, with the end excluded.";
  const record = { id: "r1", text, subjects: [], structured_subjects: [{ subject_id: "dated-owner", role: "about" as const, display_name: "Inez" }] };
  const time = { valid_from: "2021-07-06T09:00:00.000Z", valid_to: "2021-07-09T18:00:00.000Z", temporal_basis: "explicit" as const, witness: text };
  const f = control([record], [
    { rule_id: "kind", subject: supplied("r1", "dated-owner"), predicate: "world.kind", object: vocabulary("world/person"), witness: text, perspective: direct, polarity: "positive", time, context: [] },
    { rule_id: "label", subject: supplied("r1", "dated-owner"), predicate: "person.label", object: literal("Inez"), witness: "Inez", witness_mode: "selected_entity_label/v1", perspective: direct, polarity: "positive", time, context: [] },
  ]);
  expect(f.score().automated_passed).toBe(false);
  f.response.claims[1]!.anchors.push(f.response.claims[0]!.anchors[0]!);
  expect(f.score().automated_passed).toBe(true);
});
function wireResponse(f: ReturnType<typeof control>) {
  const descriptor = (anchor: RichClaimDraft["anchors"][number]) => {
    const d = modelQuoteAnchorForSpan(anchor, f.observed.input.events); if (!d) throw Error("scripted wire descriptor unavailable");
    if (!d.select) return d;
    // Author one compact legal synthetic answer. Production resolution still
    // verifies every quote/select byte; no real response is rewritten here.
    const text = f.observed.input.events.find(e => e.event_id === anchor.event_id)!.text;
    for (let extra = 1; extra <= 80; extra++) for (let left = 0; left <= extra; left++) {
      const start = anchor.start_utf16 - left, end = anchor.end_utf16 + extra - left;
      if (start < 0 || end > text.length) continue;
      const quote = text.slice(start, end);
      if (text.indexOf(quote) === start && text.indexOf(quote, start + 1) < 0 && quote.indexOf(d.select) === left && quote.indexOf(d.select, left + 1) < 0)
        return { event_id: anchor.event_id, quote, select: d.select };
    }
    return d;
  };
  return JSON.stringify({ ...f.response, schema: MODEL_EXTRACTION_WIRE_SCHEMA,
    mentions: f.response.mentions.map(m => ({ ...m, anchor: descriptor(m.anchor) })),
    claims: f.response.claims.map(c => ({ ...c, anchors: c.anchors.map(descriptor), perspective: { ...c.perspective, anchors: c.perspective.anchors.map(descriptor) } })) });
}
test("every added union positive admits through the real parser, guards and wire resolver", () => {
  validateUnionContract(unionCorpus as never, unionContract as never, registry);
  for (let index = 17; index < unionCorpus.cases.length; index++) {
    const item = unionCorpus.cases[index]!, rule = unionContract.cases[index]!;
    if (rule.expectation === "abstain") continue;
    const branch = (rule as unknown as { branches: ScopedExtractBranch[] }).branches[0]!;
    const f = control(item.records as CoreSemanticCase["records"], branch.propositions, branch.entities, true);
    validateScopedBranch(f.item, f.branch as ScopedExtractBranch, registry);
    expect(f.score().gates).toEqual(expect.objectContaining({ structure: [], schema: [], attribution: [], time: [] }));
    expect(f.score().automated_passed).toBe(true);
    const prepared = prepareCoreSemanticObservation(f.observed, registry, f.item);
    expect(prepared.errors).toEqual([]);
    expect(prepared.drafts).toHaveLength(branch.propositions.length);
    const raw = wireResponse(f), { budget: _, ...input } = f.observed.input;
    const resolved = resolveModelExtractionWire(raw, input);
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(JSON.parse(resolved.text)).toEqual(f.observed.response);
    // Output sizing is a scripted-example feasibility check, never measured model usage.
    expect(Math.ceil(raw.length / 4)).toBeLessThanOrEqual(policy.max_output_tokens);
  }
});
test("v4 local alias alternatives use the real dispatcher and admit only the declared same-record peer", () => {
  const index = unionCorpus.cases.findIndex(item => item.id === "offered-concept-cutting-relations");
  const item = unionCorpus.cases[index]! as CoreSemanticCase, rule = unionContract.cases[index]! as never as { expectation: "extract"; branches: ScopedExtractBranch[] };
  const score = (response: ExtractResponseV2, input: ReturnType<typeof coreSemanticCaseInput>) => scoreCoreSemanticRepresentations(item, rule as never, {
    case_id: item.id, input, status: "ok", response, dropped: 0, usage: { calls: 1, input_tokens: 100, output_tokens: 100 },
  }, registry, policy);
  const complete = control(item.records, rule.branches[0]!.propositions, rule.branches[0]!.entities, true, item.id);
  expect(score(complete.response, complete.observed.input).selected_branch_id).toBe("complete-local-alias");
  const mutableComplete = complete.response as any, alias = mutableComplete.mentions.find((mention: { label: string }) => mention.label === "Ochre Cutreserve")!, canonical = mutableComplete.mentions.find((mention: { label: string }) => mention.label === "Thistle Spareband")!;
  alias.candidate_refs = [{ kind: "mention", id: canonical.id }];
  expect(score(alias === undefined ? complete.response : complete.response, complete.observed.input).selected_branch_id).toBe("complete-local-alias");
  for (const mutate of [
    (response: any) => { response.mentions.find((mention: { label: string }) => mention.label === "Ochre Cutreserve")!.candidate_refs = [{ kind: "mention", id: response.mentions.find((mention: { label: string }) => mention.label === "Quartz Sidecast")!.id }]; },
    (response: any) => { const mentions = response.mentions; [mentions[0], mentions[1]] = [mentions[1], mentions[0]]; },
    (response: any) => { response.mentions.find((mention: { label: string }) => mention.label === "Ochre Cutreserve")!.candidate_refs = [{ kind: "mention", id: canonical.id }, { kind: "mention", id: canonical.id }]; },
  ]) { const response = structuredClone(complete.response) as any; mutate(response); expect(score(response, complete.observed.input).automated_passed).toBe(false); }
  const partial = control(item.records, rule.branches[1]!.propositions, rule.branches[1]!.entities, true, item.id);
  expect(score(partial.response, partial.observed.input).selected_branch_id).toBe("partial-local-alias");
  for (const mutate of [
    (branch: ScopedExtractBranch) => { delete (branch as Partial<ScopedExtractBranch>).scope; },
    (branch: ScopedExtractBranch) => { delete branch.local_alias_nomination; },
  ]) { const branch = structuredClone(rule.branches[1]!); mutate(branch); expect(() => validateScopedBranch(item, branch, registry)).toThrow(); }
});
test("union due is a closed world row even when its ID overlaps the legacy registry", () => {
  const item = unionCorpus.cases[20]!, rule = unionContract.cases[20]! as unknown as { branches: ScopedExtractBranch[] };
  const branch = rule.branches[0]!, f = control(item.records as CoreSemanticCase["records"], branch.propositions, branch.entities, true);
  expect(f.score().automated_passed).toBe(true);
  const claim = structuredClone(f.response.claims.find(c => c.predicate === "skill.last_validated")!);
  claim.id = "uncontracted-due"; claim.predicate = "commitment.due"; claim.subject = f.ref(supplied("guide", "panel"));
  claim.anchors.push(...structuredClone(f.observed.input.supplied_refs.find(s => s.id === claim.subject.id)!.anchors));
  f.response.claims.push(claim);
  expect(f.score().automated_passed).toBe(false);
});
let fixedUnion: any;
beforeAll(() => {
  const directory = mkdtempSync(join(tmpdir(), "kizuki-union-verifier-"));
  for (const path of RUNNER_FILES) { mkdirSync(dirname(join(directory, path)), { recursive: true }); writeFileSync(join(directory, path), readFileSync(join(import.meta.dir, "../..", path))); }
  const rows = scriptedUnionObservations(policy), wire = rows.map(row => scriptedWire(row, policy)), started = Date.UTC(2026, 9, 23);
  const traces = rows.map((row, index) => ({ case_id: row.case_id, prompt_sha256: sha256(extractionV2SystemContent(row.input)), transport: "ok" as const,
    input_planning_sha256: wire[index]!.evidence.input_planning.planning_sha256, request_sha256: "a".repeat(64), response_sha256: "b".repeat(64), model_response_sha256: wire[index]!.evidence.receipt.raw_response_sha256,
    origin: "observed_v3" as const, http_status: 200, started_at: new Date(started + index * (RESPONSE_GAP_MS + 1_000)).toISOString(), completed_at: new Date(started + index * (RESPONSE_GAP_MS + 1_000) + 1_000).toISOString() }));
  const evidence = { source_commit: "a".repeat(40), input_policy: policy, traces, wire_adapter: modelWireAdapterIdentity(), wire_receipts: wire.map(w => w.evidence) };
  const assets = coreSemanticAssets("union22"), result = scoreCoreSemanticRun(rows, registry, evidence, assets);
  const report = { schema: "kizuki.world-qualification-run/v4" as const, protocol: "core-semantic-v4" as const, core_split: "union22" as const,
    evidence: "runner_observed_transport" as const, synthetic: true, source_clean: true, ...evidence, runner_sha256: runnerDigest(directory), registry_sha256: registryDigest(registry),
    model: "synthetic-union-verifier-control", endpoint_host: "127.0.0.1:1", selected_kinds: [...WORLD_UNION_CANDIDATE_KINDS], selected_extensions: [...WORLD_UNION_CANDIDATE_EXTENSIONS],
    corpus: assets.corpus, observations: rows, missing: [], selected_cases: rows.map(row => row.case_id), resumed_from: null, halt_reason: null,
    response_gap_ms: RESPONSE_GAP_MS, attempts: rows.length, case_states: rows.map(row => ({ case_id: row.case_id, status: "observed" as const })),
    prompt_sha256: traces[0]!.prompt_sha256, prompt_sha256_by_case: Object.fromEntries(traces.map(trace => [trace.case_id, trace.prompt_sha256])), limitations: ["scripted verifier controls only, never model qualification"], core_semantic: result };
  const bytes = JSON.stringify(report), review = JSON.stringify(expectedCoreSemanticReview(sha256(bytes), result));
  const path = join(directory, "scripts/fixtures/world-qualification/union-control-review.json"); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, review, { mode: 0o600 });
  fixedUnion = { directory, rows, result, report, bytes, review, path, approval: { file: "union-control.json", sha256: sha256(bytes), endpoint_evidence: "c".repeat(64), protocol: "core-semantic-v4" as const, body_review: { file: "union-control-review.json", sha256: sha256(review) } } };
});
afterAll(() => { if (fixedUnion) rmSync(fixedUnion.directory, { recursive: true, force: true }); });
test("fixed union report accepts the complete 22-case source control", () => {
  const f = fixedUnion, checked = verifyCoreSemanticReport(f.bytes, f.approval, f.directory, "union22");
  expect(f.result.cases.filter((row: { automated_passed: boolean }) => !row.automated_passed)).toEqual([]);
  expect(checked.predicates).toHaveLength(70);
  expect(() => verifyCoreSemanticReport(f.bytes, f.approval, f.directory, "offered17")).toThrow();
});
test.each([
  ["missing observation", (r: any) => { r.attempts--; r.observations.pop(); r.traces.pop(); }], ["resume marker", (r: any) => { r.resumed_from = {}; }],
  ["halt marker", (r: any) => { r.halt_reason = "transport_refused"; }], ["extensions", (r: any) => { r.selected_extensions = []; }],
  ["input budget", (r: any) => { r.input_policy.input_token_overhead = 0; }], ["input usage", (r: any) => { r.observations[0].usage.input_tokens = 32001; }],
  ["output usage", (r: any) => { r.observations[0].usage.output_tokens = 8193; }], ["wire receipt", (r: any) => { r.wire_receipts.pop(); }], ["source cleanliness", (r: any) => { r.source_clean = false; }],
])("fixed union report rejects %s", (_name, mutate) => { const f = fixedUnion, changed = structuredClone(f.report); mutate(changed); const text = JSON.stringify(changed); expect(() => verifyQualificationReceipt(text, { ...f.approval, sha256: sha256(text) }, registry, f.directory)).toThrow(); });
test("fixed union report rejects an altered independent review", () => { const f = fixedUnion, changed = JSON.stringify({ ...JSON.parse(f.review), independent: false }); writeFileSync(f.path, changed); expect(() => verifyQualificationReceipt(f.bytes, { ...f.approval, body_review: { ...f.approval.body_review, sha256: sha256(changed) } }, registry, f.directory)).toThrow("review mismatch"); writeFileSync(f.path, f.review); });

test("v4 dry runner is explicit, fixed, and preserves pending review without transport", async () => {
  await expect(runQualification({ protocol: "core-semantic-v4", kinds: WORLD_UNION_CANDIDATE_KINDS, extensions: WORLD_UNION_CANDIDATE_EXTENSIONS })).rejects.toThrow();
  for (const changed of [{ case_ids: ["union-direct-question-person"] }, { resume_from: "/nonexistent", resume_sha256: "a".repeat(64) }, { core_split: "offered17" as const }])
    await expect(runQualification({ protocol: "core-semantic-v4", kinds: WORLD_UNION_CANDIDATE_KINDS, extensions: WORLD_UNION_CANDIDATE_EXTENSIONS, input_policy: UNION_INPUT_POLICY, ...changed })).rejects.toThrow();
  const result = await runQualification({ protocol: "core-semantic-v4", core_split: "union22", kinds: WORLD_UNION_CANDIDATE_KINDS, extensions: WORLD_UNION_CANDIDATE_EXTENSIONS, input_policy: UNION_INPUT_POLICY });
  expect(result.protocol).toBe("core-semantic-v4"); expect(result.attempts).toBe(0); expect(result.traces).toEqual([]); expect(result.core_semantic.automated_passed).toBe(false);
  expect(result.selected_cases).toHaveLength(22); expect(result.core_semantic.status).toBe("pending_manual_review");
});
