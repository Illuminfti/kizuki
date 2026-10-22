import { readFileSync } from "node:fs";
import { parseExtractResponseV2, type ProduceInputV2, type RichClaimDraft } from "../../packages/core/src/contracts/producer-v2";
import type { WorldRegistry } from "../../packages/core/src/contracts/world-kinds";
import { withWorldRegistry } from "../../packages/core/src/contracts/world-vocabulary";
import { worldProduceInput } from "../../packages/core/src/serve/extract-v2";
import { PREDICATE_REGISTRY } from "../../packages/core/src/claims/predicates";
import { canonicalJson, sha256 } from "../evaluate-extraction";
import corpusJson from "./core-semantic-corpus.json";
import contractJson from "./core-semantic-contract.json";
import freeze from "./core-semantic-freeze.json";
import type { Observation } from "./score";

export const CORE_SEMANTIC_PROTOCOL = "core-semantic-v1" as const;
type Category = "positive" | "reported" | "historical" | "name_negative" | "template_negative" | "hypothetical_negative";
type SourceType = "direct_record" | "person_statement" | "document_report";
export interface CoreSemanticRecord { id: string; text: string; subjects: { id: string; quote: string }[] }
export interface CoreSemanticCase { id: string; kind: "concept" | "situation"; category: Category; source_type: SourceType; records: CoreSemanticRecord[] }
interface CoreSemanticCorpus { schema: string; synthetic: true; split: "held_out"; version: string; cases: CoreSemanticCase[] }
type TimeRule = "unknown" | { valid_from: string; valid_to: string; temporal_basis: "explicit"; witness: string };
type PerspectiveRule = "direct" | "person_statement" | "document_report";
interface MentionRule { mode: "mention"; record: string; quote: string; label: string; attribution_witness: string }
type SourceRule = string | MentionRule;
interface PropositionRule { witness: string; perspective: PerspectiveRule; source?: SourceRule; time: TimeRule }
interface DetailRule extends PropositionRule { predicate: string; object_kind: "literal"; required_atoms: string[] }
interface TargetRule { mode: "mention"; record: string; quote: string }
interface ExtractRule {
  case_id: string; expectation: "extract"; target: TargetRule;
  classification: PropositionRule & { kind: "world/concept" | "world/situation"; label: string };
  details: DetailRule[]; forbidden_assertions: string[];
}
interface AbstainRule { case_id: string; expectation: "abstain"; forbidden_assertions: string[] }
interface CoreSemanticContract { schema: string; corpus_version: string; legacy_extra_policy: { forbidden_predicates: string[] }; cases: (ExtractRule | AbstainRule)[] }

export const coreSemanticCorpus = corpusJson as CoreSemanticCorpus;
export const coreSemanticContract = contractJson as CoreSemanticContract;
export const coreSemanticCorpusSha256 = freeze.files["core-semantic-corpus.json"].sha256;
export const coreSemanticContractSha256 = freeze.files["core-semantic-contract.json"].sha256;
const eventId = (index: number) => String(index + 1).padStart(26, "0");
const normalized = (value: string) => value.normalize("NFC").trim().replace(/\s+/g, " ");
const legacyPredicates = new Set(PREDICATE_REGISTRY.map(row => row.id));
const forbiddenLegacyPredicates = ["identity.same_as", "project.owns"] as const;

function span(record: CoreSemanticRecord, quote: string) {
  const start = record.text.indexOf(quote);
  if (start < 0 || record.text.indexOf(quote, start + 1) >= 0) throw new Error("ambiguous core semantic witness");
  return { event_id: "", start_utf16: start, end_utf16: start + quote.length };
}

/** Frozen before calls; no observed answer can add an atom, alternative, or case. */
export function validateCoreSemanticAssets(): void {
  for (const name of ["core-semantic-corpus.json", "core-semantic-contract.json", "core-semantic.md"] as const) {
    const bytes = readFileSync(new URL(name, import.meta.url)), pin = freeze.files[name];
    if (bytes.length !== pin.bytes || sha256(bytes) !== pin.sha256) throw new Error("core semantic asset changed");
  }
  const categories: Category[] = ["positive", "reported", "historical", "name_negative", "template_negative", "hypothetical_negative"];
  if (coreSemanticCorpus.schema !== "kizuki.core-semantic-corpus/v1" || coreSemanticCorpus.synthetic !== true || coreSemanticCorpus.split !== "held_out" ||
      coreSemanticContract.schema !== "kizuki.core-semantic-contract/v1" || coreSemanticContract.corpus_version !== coreSemanticCorpus.version ||
      canonicalJson(coreSemanticContract.legacy_extra_policy.forbidden_predicates) !== canonicalJson(forbiddenLegacyPredicates) ||
      coreSemanticCorpus.cases.length !== 12 || coreSemanticContract.cases.length !== 12 ||
      canonicalJson(coreSemanticCorpus.cases.map(row => row.id)) !== canonicalJson(coreSemanticContract.cases.map(row => row.case_id))) throw new Error("invalid core semantic assets");
  for (const kind of ["concept", "situation"] as const) if (canonicalJson(coreSemanticCorpus.cases.filter(row => row.kind === kind).map(row => row.category)) !== canonicalJson(categories)) throw new Error("invalid core semantic coverage");
  for (const item of coreSemanticCorpus.cases) {
    if (!/^[a-z0-9-]{1,80}$/.test(item.id) || item.records.length !== 1 || item.records[0]!.text.length > 8_000 || new Set(item.records[0]!.subjects.map(row => row.id)).size !== item.records[0]!.subjects.length) throw new Error("invalid core semantic case");
    for (const subject of item.records[0]!.subjects) span(item.records[0]!, subject.quote);
    const rule = coreSemanticContract.cases.find(row => row.case_id === item.id)!;
    if ((item.category.endsWith("negative")) !== (rule.expectation === "abstain")) throw new Error("core semantic expectation mismatch");
    if (rule.expectation === "extract") {
      const subjectIds = new Set(item.records[0]!.subjects.map(row => row.id));
      const targetRecord = item.records.find(record => record.id === rule.target.record);
      if (rule.target.mode !== "mention" || targetRecord === undefined || targetRecord.subjects.some(subject => subject.quote === rule.target.quote) || span(targetRecord, rule.target.quote).end_utf16 <= 0 ||
          rule.details.length < 1 || rule.details.length > 4 || new Set(rule.details.map(row => row.predicate)).size !== rule.details.length ||
          rule.classification.kind !== `world/${item.kind}` || rule.details.some(row => row.object_kind !== "literal" || row.required_atoms.length < 1)) throw new Error("invalid core semantic extraction rule");
      for (const proposition of [rule.classification, ...rule.details]) {
        span(item.records[0]!, proposition.witness);
        if (proposition.perspective === "direct") { if (proposition.source !== undefined) throw new Error("invalid core semantic attribution rule"); }
        else if (proposition.source === undefined) throw new Error("invalid core semantic attribution rule");
        else if (typeof proposition.source === "string") { if (!subjectIds.has(proposition.source)) throw new Error("invalid core semantic attribution rule"); }
        else {
          const source = proposition.source, sourceRecord = item.records.find(record => record.id === source.record);
          if (source.mode !== "mention" || sourceRecord === undefined || sourceRecord.subjects.some(subject => subject.quote === source.quote) ||
              span(sourceRecord, source.quote).end_utf16 <= 0 || span(sourceRecord, source.attribution_witness).end_utf16 <= 0 ||
              normalized(source.label).length === 0) throw new Error("invalid core semantic attribution rule");
        }
        if (proposition.time !== "unknown" && (!(Date.parse(proposition.time.valid_from) < Date.parse(proposition.time.valid_to)) || proposition.time.temporal_basis !== "explicit" ||
            new Date(proposition.time.valid_from).toISOString() !== proposition.time.valid_from || new Date(proposition.time.valid_to).toISOString() !== proposition.time.valid_to ||
            span(item.records[0]!, proposition.time.witness).end_utf16 <= 0)) throw new Error("invalid core semantic time rule");
      }
      const expectedPerspective = item.category === "reported" ? "person_statement" : item.category === "historical" ? "document_report" : "direct";
      if (rule.classification.perspective !== "direct" || rule.details.some(row => row.perspective !== expectedPerspective)) throw new Error("core semantic source role mismatch");
    }
  }
}

export function coreSemanticCaseInput(item: CoreSemanticCase, registry: WorldRegistry): ProduceInputV2 {
  const events = item.records.map((record, index) => ({ event_id: eventId(index), text: record.text }));
  const supplied = item.records.flatMap((record, index) => record.subjects.map(subject => {
    const anchor = span(record, subject.quote);
    return { id: subject.id, anchors: [{ ...anchor, event_id: eventId(index) }] };
  }));
  return withWorldRegistry(registry, () => worldProduceInput(events as never, supplied, { max_input_tokens: 8_192, max_output_tokens: 8_192 }));
}

function rawRefKey(ref: { kind: "supplied" | "mention"; id: string }): string { return `${ref.kind}:${ref.id}`; }
function exactTime(claim: RichClaimDraft, rule: TimeRule): boolean {
  if (rule === "unknown") return claim.valid_from === null && claim.valid_to === null && claim.temporal_basis === "unknown";
  return claim.valid_from !== null && claim.valid_to !== null && Number.isFinite(Date.parse(claim.valid_from)) && Number.isFinite(Date.parse(claim.valid_to)) &&
    new Date(claim.valid_from).toISOString() === rule.valid_from && new Date(claim.valid_to).toISOString() === rule.valid_to && claim.temporal_basis === rule.temporal_basis;
}

function exactPerspective(claim: RichClaimDraft, rule: PropositionRule, sourceKey: string | null): boolean {
  const perspective = claim.perspective;
  if (perspective.interpretation !== "explicit" || perspective.addressee !== null) return false;
  if (rule.perspective === "direct") return perspective.mode === "asserted" && perspective.holder === null && perspective.speaker === null;
  if (sourceKey === null || (rule.perspective === "document_report" ? perspective.mode !== "reported" : !["reported", "quoted"].includes(perspective.mode))) return false;
  if (rule.perspective === "document_report") return perspective.holder !== null && rawRefKey(perspective.holder) === sourceKey && perspective.speaker === null;
  return perspective.speaker !== null && rawRefKey(perspective.speaker) === sourceKey &&
    (perspective.holder === null || rawRefKey(perspective.holder) === sourceKey);
}

function sourceKey(rule: PropositionRule, item: CoreSemanticCase, response: NonNullable<Observation["response"]>, input: ProduceInputV2): string | null {
  if (rule.source === undefined) return null;
  if (typeof rule.source === "string") return `supplied:${rule.source}`;
  const source = rule.source, recordIndex = item.records.findIndex(record => record.id === source.record), record = item.records[recordIndex];
  if (record === undefined) return null;
  const authored = span(record, source.quote), anchor = { ...authored, event_id: input.events[recordIndex]!.event_id };
  const matches = response.mentions.filter(mention => canonicalJson(mention.anchor) === canonicalJson(anchor) && normalized(mention.label) === normalized(source.label) && mention.candidate_refs.length === 0);
  return matches.length === 1 ? `mention:${matches[0]!.id}` : null;
}

function scoreCoreSemanticCase(item: CoreSemanticCase, rule: ExtractRule | AbstainRule, observed: Observation | undefined, registry: WorldRegistry) {
  const gates = { observation: [] as string[], schema: [] as string[], usage: [] as string[], abstention: [] as string[], structure: [] as string[], attribution: [] as string[], time: [] as string[] };
  let legacyExtras: RichClaimDraft[] = [];
  if (observed === undefined) gates.observation.push("not_run");
  else {
    const expectedInput = coreSemanticCaseInput(item, registry);
    if (observed.case_id !== item.id || canonicalJson(observed.input) !== canonicalJson(expectedInput)) gates.observation.push("input_mismatch");
    if (observed.status !== "ok" || observed.response === null) gates.observation.push(observed.status);
    if (observed.response !== null) {
      const { budget: _budget, ...parseInput } = observed.input;
      const parsed = parseExtractResponseV2(JSON.stringify(observed.response), parseInput);
      if (!parsed.ok || parsed.dropped.length !== 0) gates.schema.push("invalid_typed_response");
      if (observed.dropped !== 0) gates.schema.push("dropped_claims");
      if (rule.expectation === "abstain") {
        if (observed.response.claims.length !== 0) gates.abstention.push("claims_present");
      } else if (parsed.ok && parsed.dropped.length === 0) {
        const claims = observed.response.claims, labelPredicate = `${item.kind}.label`, expectedPredicates = ["world.kind", labelPredicate, ...rule.details.map(row => row.predicate)];
        const typedClaims = claims.filter(claim => expectedPredicates.includes(claim.predicate));
        legacyExtras = claims.filter(claim => !expectedPredicates.includes(claim.predicate));
        if (expectedPredicates.some(predicate => typedClaims.filter(row => row.predicate === predicate).length !== 1) ||
            legacyExtras.some(claim => !legacyPredicates.has(claim.predicate) || forbiddenLegacyPredicates.includes(claim.predicate as typeof forbiddenLegacyPredicates[number]))) gates.structure.push("predicate_set_mismatch");
        if (typedClaims.some(row => row.context.length !== 0)) gates.structure.push("unsupported_context");
        const targetRecordIndex = item.records.findIndex(record => record.id === rule.target.record), targetRecord = item.records[targetRecordIndex]!, targetSpan = span(targetRecord, rule.target.quote);
        const targetAnchor = { ...targetSpan, event_id: observed.input.events[targetRecordIndex]!.event_id };
        const targetMentions = observed.response.mentions.filter(mention => canonicalJson(mention.anchor) === canonicalJson(targetAnchor) && normalized(mention.label) === normalized(rule.target.quote) && mention.candidate_refs.length === 0);
        const targetMention = targetMentions[0];
        if (targetMentions.length !== 1 || targetMention === undefined || typedClaims.some(claim => claim.subject.kind !== "mention" || claim.subject.id !== targetMention.id) ||
            new Set(typedClaims.map(claim => rawRefKey(claim.subject))).size !== 1) gates.structure.push("target_mismatch");
        const classification = typedClaims.find(row => row.predicate === "world.kind"), label = typedClaims.find(row => row.predicate === labelPredicate);
        if (!classification || classification.object.kind !== "vocabulary" || classification.object.ref.id !== rule.classification.kind || classification.polarity !== "positive") gates.structure.push("classification_mismatch");
        if (!label || label.object.kind !== "literal" || normalized(label.object.value) !== rule.classification.label || label.polarity !== "positive" ||
            !label.anchors.some(anchor => canonicalJson(anchor) === canonicalJson(targetAnchor))) gates.structure.push("label_mismatch");
        for (const claim of [classification, label]) if (claim) {
          if (!exactPerspective(claim, rule.classification, sourceKey(rule.classification, item, observed.response, observed.input))) gates.attribution.push(`${claim.predicate}:perspective`);
          if (!exactTime(claim, rule.classification.time)) gates.time.push(`${claim.predicate}:time`);
        }
        for (const detail of rule.details) {
          const claim = typedClaims.find(row => row.predicate === detail.predicate);
          if (!claim || claim.object.kind !== "literal" || claim.polarity !== "positive") { gates.structure.push(`${detail.predicate}:missing`); continue; }
          if (!exactPerspective(claim, detail, sourceKey(detail, item, observed.response, observed.input))) gates.attribution.push(`${detail.predicate}:perspective`);
          if (!exactTime(claim, detail.time)) gates.time.push(`${detail.predicate}:time`);
        }
      }
      if (observed.usage.calls !== 1 || observed.usage.input_tokens === null || observed.usage.output_tokens === null) gates.usage.push("unmeasured_usage");
      for (const count of [observed.usage.input_tokens, observed.usage.output_tokens]) if (count !== null && (!Number.isSafeInteger(count) || count < 0 || count > 100_000_000)) gates.usage.push("invalid_usage");
      if ((observed.usage.output_tokens ?? 0) > observed.input.budget.max_output_tokens) gates.usage.push("output_budget_exceeded");
    }
  }
  const responseSha256 = observed?.response === null || observed?.response === undefined ? null : sha256(canonicalJson(observed.response));
  return { case_id: item.id, expectation: rule.expectation, automated_passed: Object.values(gates).every(errors => errors.length === 0), gates,
    manual_review: rule.expectation === "abstain" ? { status: "pending" as const, response_sha256: responseSha256, abstention: "confirm_exact_zero_claim_response" as const }
      : { status: "pending" as const, response_sha256: responseSha256,
        required_atoms: rule.details.flatMap(detail => detail.required_atoms.map(atom => ({ predicate: detail.predicate, atom }))),
        legacy_extras: legacyExtras.map(claim => ({ claim_id: claim.id, predicate: claim.predicate, claim_sha256: sha256(canonicalJson(claim)) })),
        forbidden_assertions: rule.forbidden_assertions } };
}

export function scoreCoreSemanticRun(observations: readonly Observation[], registry: WorldRegistry) {
  if (new Set(observations.map(row => row.case_id)).size !== observations.length || observations.some(row => !coreSemanticCorpus.cases.some(item => item.id === row.case_id))) throw new Error("unknown or duplicate core semantic observation");
  const cases = coreSemanticCorpus.cases.map(item => scoreCoreSemanticCase(item, coreSemanticContract.cases.find(row => row.case_id === item.id)!, observations.find(row => row.case_id === item.id), registry));
  return { schema: "kizuki.core-semantic-result/v1" as const, protocol: CORE_SEMANTIC_PROTOCOL, corpus_sha256: coreSemanticCorpusSha256,
    contract_sha256: coreSemanticContractSha256, automated_passed: cases.every(row => row.automated_passed), status: "pending_manual_review" as const, cases };
}

export function expectedCoreSemanticReview(reportSha256: string, result: ReturnType<typeof scoreCoreSemanticRun>) {
  return { schema: "kizuki.core-semantic-review/v1" as const, independent: true, status: "passed" as const, report_sha256: reportSha256,
    corpus_sha256: result.corpus_sha256, contract_sha256: result.contract_sha256,
    cases: result.cases.map(row => { const rule = coreSemanticContract.cases.find(candidate => candidate.case_id === row.case_id)!;
      return rule.expectation === "abstain"
        ? { case_id: row.case_id, response_sha256: row.manual_review.response_sha256, status: "passed" as const, abstention: "confirmed" as const }
        : { case_id: row.case_id, response_sha256: row.manual_review.response_sha256, status: "passed" as const,
          atoms: rule.details.flatMap(detail => detail.required_atoms.map(atom => ({ predicate: detail.predicate, atom, status: "supported" as const }))), literal_consistency: "passed" as const,
          body_fidelity: "passed" as const,
          evidence: ["world.kind", `${coreSemanticCorpus.cases.find(item => item.id === row.case_id)!.kind}.label`, ...rule.details.map(detail => detail.predicate)]
            .map(predicate => ({ predicate, anchors_jointly_support_claim: "passed" as const })), unsupported_additions: [],
          legacy_extras: (row.manual_review.legacy_extras ?? []).map(extra => ({ ...extra, literal_supported: "passed" as const, body_fidelity: "passed" as const,
            references_grounded: "passed" as const, anchors_jointly_support_claim: "passed" as const, role_and_time_supported: "passed" as const,
            source_entailment: "passed" as const, unsupported_additions: "absent" as const })),
          forbidden_assertions: rule.forbidden_assertions.map(assertion => ({ assertion, status: "absent" as const })) }; }) };
}

export function verifyCoreSemanticReview(reportSha256: string, result: ReturnType<typeof scoreCoreSemanticRun>, review: unknown): void {
  if (!result.automated_passed || canonicalJson(review) !== canonicalJson(expectedCoreSemanticReview(reportSha256, result))) throw new Error("core semantic review mismatch");
}
