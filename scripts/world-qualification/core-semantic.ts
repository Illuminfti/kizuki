import { readFileSync } from "node:fs";
import { MAX_V2_ANCHORS, MAX_V2_ANCHORS_PER_ITEM, parseExtractResponseV2, type ProduceInputV2, type RichClaimDraft, type TextAnchor, type DraftRef } from "../../packages/core/src/contracts/producer-v2";
import { prepareWorldDrafts, type WorldDraftContext, type WorldDraftInsert } from "../../packages/core/src/producer/world-drafts";
import { mintOccurrenceId } from "../../packages/core/src/claims/occurrences";
import { LEDGER_SCHEMA_VERSION, openLedger } from "../../packages/core/src/ledger/db";
import { notePendingClassification, worldAssertionViolation, type PendingClassifications } from "../../packages/core/src/world/registry-check";
import { CLAIM_V2_SCHEMA, rawSubjectRefKey, type RawSubjectRef, type ClaimV2Assertion } from "../../packages/core/src/contracts/claim-v2";
import type { WorldRegistry } from "../../packages/core/src/contracts/world-kinds";
import { withWorldRegistry } from "../../packages/core/src/contracts/world-vocabulary";
import { worldProduceInput } from "../../packages/core/src/serve/extract-v2";
import { PREDICATE_REGISTRY } from "../../packages/core/src/claims/predicates";
import { isPlainObject } from "../../packages/core/src/util/validate";
import { canonicalJson, sha256 } from "../evaluate-extraction";
import corpusJson from "./core-semantic-corpus.json";
import contractJson from "./core-semantic-contract.json";
import freeze from "./core-semantic-freeze.json";
import offeredCorpusJson from "./core-semantic-offered-corpus.json";
import offeredContractJson from "./core-semantic-offered-contract.json";
import offeredFreeze from "./core-semantic-offered-freeze.json";
import { worldSuppliedReferences } from "../../packages/core/src/serve/world-supplied";
import type { SubjectRef as EventSubject } from "../../packages/core/src/contracts/event";
import type { Observation } from "./score";
import { inspectCoreSemanticWireEvidence, type CoreSemanticWireEvidence, type ModelWireAdapterIdentity } from "./wire-custody";
import { matchScopedPropositions, UNION_SEMANTIC_PROTOCOL, type ScopedExtractBranch } from "./union-propositions";
import { unionSemanticAssets, validateUnionContract } from "./union-assets";

import { DEFAULT_QUALIFICATION_INPUT_POLICY, validateQualificationInputPolicy, type QualificationInputPolicy } from "./input-planning";

export const CORE_SEMANTIC_PROTOCOL = "core-semantic-v3" as const;
export const LEGACY_CORE_SEMANTIC_PROTOCOL = "core-semantic-v2" as const;
type Category = "positive" | "reported" | "historical" | "maintenance_outline" | "name_negative" | "template_negative" | "hypothetical_negative";
type SourceType = "direct_record" | "person_statement" | "document_report";
export interface CoreSemanticRecord { id: string; text: string; subjects: { id: string; quote: string }[]; structured_subjects?: EventSubject[] }
export interface CoreSemanticCase { id: string; kind: "concept" | "situation" | "mixed"; category: Category; source_type: SourceType; records: CoreSemanticRecord[] }
export interface CoreSemanticCorpus { schema: string; synthetic: true; split: "held_out" | "regression" | "prospective_offered17" | "prospective_union22"; version: string; cases: CoreSemanticCase[] }
type TimeRule = "unknown" | { valid_from: string; valid_to: string; temporal_basis: "explicit"; witness: string };
type PerspectiveRule = "direct" | "person_statement" | "document_report" | "document_suggestion";
interface MentionRule { mode: "mention"; record: string; quote: string; label: string; attribution_witness: string }
type SourceRule = string | MentionRule;
export interface PropositionRule { witness: string; perspective: PerspectiveRule; source?: SourceRule; equivalent_mention?: MentionRule; attribution_witness?: string; time: TimeRule }
export interface DetailRule extends PropositionRule { predicate: string; object_kind: "literal"; required_atoms: string[] }
interface TargetRule { mode: "mention"; record: string; quote: string }
export interface LegacyExtractRule {
  case_id: string; expectation: "extract"; target: TargetRule;
  classification: PropositionRule & { kind: "world/concept" | "world/situation"; label: string };
  label_alternatives?: PropositionRule[];
  label_rule?: LabelRule;
  details: DetailRule[]; forbidden_assertions: string[];
}
export interface LabelRule extends PropositionRule { value: string; naming: "explicit" | "source_description"; naming_witness?: string }
export interface CoreSemanticExtractBranch extends Omit<LegacyExtractRule, "case_id" | "expectation"> { id: string }
interface BranchedExtractRule { case_id: string; expectation: "extract"; branches: CoreSemanticExtractBranch[] }
type ExtractRule = LegacyExtractRule | BranchedExtractRule;
export interface AbstainRule { case_id: string; expectation: "abstain"; forbidden_assertions: string[] }
export interface CoreSemanticContract { schema: string; protocol: string; corpus_version: string; legacy_extra_policy: { forbidden_predicates: string[] }; cases: (ExtractRule | AbstainRule)[] }

export type EntitySelector = { mode: "source_occurrence"; record: string; label: string } |
  { mode: "structured_source_subject"; record: string; subject_id: string };
export interface GeneralPropositionRule {
  rule_id: string; subject: EntitySelector; predicate: string;
  object: { kind: "literal"; required_atoms: string[] } | { kind: "subject"; entity: EntitySelector } | { kind: "vocabulary"; value: string };
  witness: string; perspective: { holder: null; speaker: null; addressee: null; mode: "asserted"; interpretation: "explicit" };
  witness_mode?: "selected_entity_label/v1";
  polarity: "positive"; time: { valid_from: null; valid_to: null; temporal_basis: "unknown" };
  context: EntitySelector[]; required_relation_atoms?: string[]; symmetric?: true;
}
export interface GeneralExtractBranch {
  id: string;
  entities: { label: string; record: string; allowed_occurrence_spans: { start_utf16: number; end_utf16: number }[]; consistency: string }[];
  propositions: GeneralPropositionRule[]; forbidden_assertions: string[];
}
interface GeneralExtractRule { case_id: string; expectation: "extract"; branches: GeneralExtractBranch[] }
interface ScopedExtractRule { case_id: string; expectation: "extract"; branches: ScopedExtractBranch[] }
export type AnyExtractBranch = CoreSemanticExtractBranch | GeneralExtractBranch | ScopedExtractBranch;
type AnyExtractRule = ExtractRule | GeneralExtractRule | ScopedExtractRule;
type GeneralCaseRule = (Omit<GeneralExtractBranch, "id"> | Omit<ScopedExtractBranch, "id">) & { case_id: string; expectation: "extract" };
export interface CoreSemanticAssetSet {
  split: "regression13" | "offered17" | "union22"; corpus: CoreSemanticCorpus;
  contract: Omit<CoreSemanticContract, "cases"> & { cases: (AnyExtractRule | AbstainRule)[] };
  corpus_sha256: string; contract_sha256: string;
}
export function coreSemanticAssets(split: CoreSemanticAssetSet["split"] = "regression13"): CoreSemanticAssetSet {
  if (split === "union22") return unionSemanticAssets();
  if (split !== "regression13" && split !== "offered17") throw new Error("unsupported core semantic split");
  return split === "regression13" ? { split, corpus: coreSemanticCorpus, contract: coreSemanticContract,
    corpus_sha256: coreSemanticCorpusSha256, contract_sha256: coreSemanticContractSha256 }
    : { split, corpus: offeredCorpusJson as CoreSemanticCorpus, contract: offeredContractJson as CoreSemanticAssetSet["contract"],
      corpus_sha256: offeredFreeze.files["core-semantic-offered-corpus.json"].sha256,
      contract_sha256: offeredFreeze.files["core-semantic-offered-contract.json"].sha256 };
}
export function coreSemanticBranchPredicates(branch: AnyExtractBranch): readonly string[] {
  return "propositions" in branch ? [...new Set(branch.propositions.map(rule => rule.predicate))]
    : ["world.kind", `${branch.classification.kind.slice(6)}.label`, ...branch.details.map(detail => detail.predicate)];
}

export const coreSemanticCorpus = corpusJson as CoreSemanticCorpus;
export const coreSemanticContract = contractJson as CoreSemanticContract;
export const coreSemanticCorpusSha256 = freeze.files["core-semantic-corpus.json"].sha256;
export const coreSemanticContractSha256 = freeze.files["core-semantic-contract.json"].sha256;
export const CORE_SEMANTIC_REPRESENTATION_METHOD = "complete-authored-branches/v1" as const;
export function coreSemanticBranches(rule: ExtractRule): readonly CoreSemanticExtractBranch[];
export function coreSemanticBranches(rule: AnyExtractRule): readonly AnyExtractBranch[];
export function coreSemanticBranches(rule: AnyExtractRule): readonly AnyExtractBranch[] {
  if ("branches" in rule) return rule.branches;
  const { case_id: _case, expectation: _expectation, ...branch } = rule;
  return [{ id: "legacy-primary", ...branch }];
}
export function coreSemanticBranchRule(case_id: string, branch: CoreSemanticExtractBranch): LegacyExtractRule;
export function coreSemanticBranchRule(case_id: string, branch: AnyExtractBranch): LegacyExtractRule | GeneralCaseRule;
export function coreSemanticBranchRule(case_id: string, branch: AnyExtractBranch) {
  const { id: _id, ...fields } = branch;
  return { case_id, expectation: "extract", ...fields };
}
export const coreSemanticRulePredicates = (rule: AnyExtractRule | AbstainRule): readonly string[] => rule.expectation === "abstain" ? [] :
  [...new Set(coreSemanticBranches(rule).flatMap(coreSemanticBranchPredicates))];
const eventId = (index: number) => String(index + 1).padStart(26, "0");
const normalized = (value: string) => value.normalize("NFC").trim().replace(/\s+/g, " ");
const legacyPredicates = new Set(PREDICATE_REGISTRY.map(row => row.id));
const forbiddenLegacyPredicates = ["identity.same_as", "project.owns"] as const;

function span(record: CoreSemanticRecord, quote: string) {
  const start = record.text.indexOf(quote);
  if (start < 0 || record.text.indexOf(quote, start + 1) >= 0) throw new Error("ambiguous core semantic witness");
  return { event_id: "", start_utf16: start, end_utf16: start + quote.length };
}

function validateAuthoredBranch(item: CoreSemanticCase, branch: CoreSemanticExtractBranch): void {
  const exact = (value: unknown, required: readonly string[], optional: readonly string[] = []) => isPlainObject(value) &&
    required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => [...required, ...optional].includes(key));
  const text = (value: unknown, max = 1_000): value is string => typeof value === "string" && value.length > 0 && value.length <= max && value.trim() === value;
  const proposition = (value: PropositionRule, extra: readonly string[], optional: readonly string[] = []) => {
    if (!exact(value, ["witness", "perspective", "time", ...extra], ["source", "equivalent_mention", "attribution_witness", ...optional]) ||
        !text(value.witness, 8_000) || !["direct", "person_statement", "document_report", "document_suggestion"].includes(value.perspective) ||
        (value.time !== "unknown" && !exact(value.time, ["valid_from", "valid_to", "temporal_basis", "witness"]))) throw new Error("invalid authored proposition");
    for (const source of [value.source, value.equivalent_mention]) if (source !== undefined && typeof source !== "string" &&
        !exact(source, ["mode", "record", "quote", "label", "attribution_witness"])) throw new Error("invalid authored source");
  };
  if (!exact(branch, ["id", "target", "classification", "label_rule", "details", "forbidden_assertions"]) ||
      !exact(branch.target, ["mode", "record", "quote"]) || !text(branch.target.quote, 8_000) ||
      !Array.isArray(branch.details) || branch.details.length < 1 || branch.details.length > 4 ||
      !Array.isArray(branch.forbidden_assertions) || branch.forbidden_assertions.length < 1 || branch.forbidden_assertions.length > 32 ||
      branch.forbidden_assertions.some(value => !text(value)) || new Set(branch.forbidden_assertions).size !== branch.forbidden_assertions.length)
    throw new Error("invalid authored representation branch");
  proposition(branch.classification, ["kind", "label"]);
  const label = branch.label_rule;
  if (!label || label.perspective === "document_suggestion" || !text(label.value) || label.value !== branch.classification.label || label.value !== branch.target.quote ||
      !["explicit", "source_description"].includes(label.naming)) throw new Error("invalid authored label");
  proposition(label, ["value", "naming"], ["naming_witness"]);
  const record = item.records.find(row => row.id === branch.target.record);
  if (!record || !label.witness.includes(branch.target.quote)) throw new Error("unbound authored label");
  if (label.naming === "explicit") {
    if (!text(label.naming_witness, 8_000) || !label.naming_witness.includes(branch.target.quote)) throw new Error("missing naming witness");
    span(record, label.naming_witness);
  } else if (item.kind !== "situation" || label.naming_witness !== undefined || label.perspective !== "document_report" ||
      label.time === "unknown" || canonicalJson(label.time) !== canonicalJson(branch.classification.time) ||
      branch.details.some(detail => detail.perspective !== "document_report" || canonicalJson(detail.source) !== canonicalJson(label.source) ||
        canonicalJson(detail.time) !== canonicalJson(label.time))) throw new Error("unbound descriptive situation label");
  for (const detail of branch.details) {
    proposition(detail, ["predicate", "object_kind", "required_atoms"]);
    if (!detail.predicate.startsWith(`${item.kind}.`) || detail.predicate === `${item.kind}.label` ||
        !Array.isArray(detail.required_atoms) || detail.required_atoms.length < 1 || detail.required_atoms.length > 16 ||
        detail.required_atoms.some(atom => !text(atom)) || new Set(detail.required_atoms).size !== detail.required_atoms.length)
      throw new Error("invalid authored detail atoms");
  }
}

/** Frozen before calls; no observed answer can add an atom, alternative, or case. */
export function validateCoreSemanticAssets(split: CoreSemanticAssetSet["split"] = "regression13", registry?: WorldRegistry): void {
  if (split === "union22") {
    if (!registry) throw Error("union profile required");
    validateCoreSemanticAssets("offered17");
    const assets = coreSemanticAssets(split);
    validateUnionContract(assets.corpus, assets.contract, registry);
    return;
  }
  for (const name of ["core-semantic-corpus.json", "core-semantic-contract.json", "core-semantic.md"] as const) {
    const bytes = readFileSync(new URL(name, import.meta.url)), pin = freeze.files[name];
    if (bytes.length !== pin.bytes || sha256(bytes) !== pin.sha256) throw new Error("core semantic asset changed");
  }
  validateCoreSemanticContract(coreSemanticCorpus, coreSemanticContract);
  if (split === "offered17") {
    for (const name of ["core-semantic-offered-corpus.json", "core-semantic-offered-contract.json", "core-semantic-offered.md"] as const) {
      const bytes = readFileSync(new URL(name, import.meta.url)), pin = offeredFreeze.files[name];
      if (bytes.length !== pin.bytes || sha256(bytes) !== pin.sha256) throw new Error("offered semantic asset changed");
    }
    const assets = coreSemanticAssets(split);
    validateCoreSemanticContract(assets.corpus, assets.contract);
  } else if (split !== "regression13") throw new Error("unsupported core semantic split");
}

/** Static author checks run before any observation; branches never come from responses. */
export function validateCoreSemanticContract(corpus: CoreSemanticCorpus, contract: CoreSemanticAssetSet["contract"]): void {
  if (corpus.schema === "kizuki.core-semantic-corpus/v3") {
    if (corpus.synthetic !== true || corpus.split !== "prospective_offered17" || corpus.cases.length !== 17 ||
        contract.schema !== "kizuki.core-semantic-contract/v3" || contract.protocol !== CORE_SEMANTIC_PROTOCOL ||
        corpus.version !== contract.corpus_version || contract.cases.length !== 17 ||
        canonicalJson(corpus.cases.slice(0, 13)) !== canonicalJson(coreSemanticCorpus.cases) ||
        canonicalJson(contract.cases.slice(0, 13)) !== canonicalJson(coreSemanticContract.cases) ||
        canonicalJson(contract.legacy_extra_policy) !== canonicalJson(coreSemanticContract.legacy_extra_policy) ||
        canonicalJson(contract.cases.map(row => row.case_id)) !== canonicalJson(corpus.cases.map(row => row.id)) ||
        canonicalJson(corpus.cases.slice(13).map(row => row.id)) !== canonicalJson([
          "offered-concept-filter-pattern", "offered-concept-cutting-relations", "offered-situation-dye-bay", "offered-learning-assisted-trial"])) throw new Error("invalid fixed offered17 assets");
    for (const item of corpus.cases.slice(13)) {
      const rule = contract.cases.find(row => row.case_id === item.id);
      if (!["concept", "situation"].includes(item.kind) || item.category !== "positive" || item.source_type !== "direct_record" || item.records.length !== 1 ||
          item.records[0]!.text.length > 8_000 || item.records[0]!.subjects.length !== 0 || !rule ||
          rule.expectation !== "extract" || !("branches" in rule) || rule.branches.length < 1 || rule.branches.length > 3 ||
          new Set(rule.branches.map(branch => branch.id)).size !== rule.branches.length) throw new Error("invalid offered case");
      for (const branch of rule.branches) {
        if (!("propositions" in branch)) throw new Error("missing complete proposition branch");
        if ("scope" in branch) throw new Error("scoped propositions require union protocol");
        validateGeneralBranch(item, branch);
      }
    }
    return;
  }
  const categories: Category[] = ["positive", "reported", "historical", "name_negative", "template_negative", "hypothetical_negative"];
  const extended = corpus.schema === "kizuki.core-semantic-corpus/v2", count = extended ? 13 : 12;
  if ((!extended && corpus.schema !== "kizuki.core-semantic-corpus/v1") || corpus.synthetic !== true || corpus.split !== (extended ? "regression" : "held_out") ||
      !["kizuki.core-semantic-contract/v1", "kizuki.core-semantic-contract/v2"].includes(contract.schema) || contract.protocol !== CORE_SEMANTIC_PROTOCOL || contract.corpus_version !== corpus.version ||
      canonicalJson(contract.legacy_extra_policy.forbidden_predicates) !== canonicalJson(forbiddenLegacyPredicates) ||
      corpus.cases.length !== count || contract.cases.length !== count || new Set(corpus.cases.map(row => row.id)).size !== count ||
      new Set(contract.cases.map(row => row.case_id)).size !== count ||
      canonicalJson(corpus.cases.map(row => row.id)) !== canonicalJson(contract.cases.map(row => row.case_id))) throw new Error("invalid core semantic assets");
  for (const kind of ["concept", "situation"] as const) if (canonicalJson(corpus.cases.slice(0, 12).filter(row => row.kind === kind).map(row => row.category)) !== canonicalJson(categories)) throw new Error("invalid core semantic coverage");
  if (extended && (corpus.cases[12]!.kind !== "situation" || corpus.cases[12]!.category !== "maintenance_outline" ||
      corpus.cases[12]!.source_type !== "document_report")) throw new Error("invalid maintenance outline coverage");
  for (const item of corpus.cases) {
    if (!/^[a-z0-9-]{1,80}$/.test(item.id) || item.records.length !== 1 || item.records[0]!.text.length > 8_000 || new Set(item.records[0]!.subjects.map(row => row.id)).size !== item.records[0]!.subjects.length) throw new Error("invalid core semantic case");
    for (const subject of item.records[0]!.subjects) span(item.records[0]!, subject.quote);
    const rule = contract.cases.find(row => row.case_id === item.id)!;
    if ((item.category.endsWith("negative")) !== (rule.expectation === "abstain")) throw new Error("core semantic expectation mismatch");
    if (rule.expectation === "extract") {
      const branches = coreSemanticBranches(rule);
      if (branches.length < 1 || branches.length > 3 || new Set(branches.map(branch => branch.id)).size !== branches.length ||
          branches.some(branch => !/^[a-z][a-z0-9-]{0,63}$/.test(branch.id)) ||
          (contract.schema === "kizuki.core-semantic-contract/v2" && (!("branches" in rule) ||
            Object.keys(rule).sort().join() !== ["branches", "case_id", "expectation"].sort().join()))) throw new Error("invalid core semantic representation branches");
      for (const branch of branches) {
        if ("propositions" in branch) throw new Error("unexpected generalized branch");
        const rule = coreSemanticBranchRule(item.id, branch);
        if (contract.schema === "kizuki.core-semantic-contract/v2") validateAuthoredBranch(item, branch);
        const subjectIds = new Set(item.records[0]!.subjects.map(row => row.id));
        const targetRecord = item.records.find(record => record.id === rule.target.record);
        if (rule.target.mode !== "mention" || targetRecord === undefined || targetRecord.subjects.some(subject => subject.quote === rule.target.quote) || span(targetRecord, rule.target.quote).end_utf16 <= 0 ||
            rule.details.length < 1 || rule.details.length > 4 || new Set(rule.details.map(row => row.predicate)).size !== rule.details.length ||
            rule.classification.kind !== `world/${item.kind}` || rule.details.some(row => row.object_kind !== "literal" || row.required_atoms.length < 1)) throw new Error("invalid core semantic extraction rule");
        for (const proposition of [rule.classification, ...(rule.label_alternatives ?? []), ...(rule.label_rule ? [rule.label_rule] : []), ...rule.details]) {
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
          if (proposition.equivalent_mention !== undefined) {
            const source = proposition.equivalent_mention, record = item.records.find(row => row.id === source.record);
            if (typeof proposition.source !== "string" || source.mode !== "mention" || record === undefined ||
                span(record, source.quote).end_utf16 <= 0 || span(record, source.attribution_witness).end_utf16 <= 0 ||
                normalized(source.label).length === 0) throw new Error("invalid equivalent attribution ref");
            const supplied = record.subjects.find(row => row.id === proposition.source);
            const occurrence = span(record, source.quote), suppliedSpan = supplied === undefined ? null : span(record, supplied.quote);
            if (suppliedSpan === null || occurrence.start_utf16 < suppliedSpan.start_utf16 || occurrence.end_utf16 > suppliedSpan.end_utf16) throw new Error("unrelated equivalent attribution ref");
          }
          const roleWitness = proposition.attribution_witness ?? (typeof proposition.source === "object" ? proposition.source.attribution_witness : undefined);
          if (proposition.perspective !== "direct" && roleWitness === undefined) throw new Error("missing attribution role witness");
          if (roleWitness !== undefined) span(item.records[0]!, roleWitness);
          if (proposition.time !== "unknown" && (!(Date.parse(proposition.time.valid_from) < Date.parse(proposition.time.valid_to)) || proposition.time.temporal_basis !== "explicit" ||
              new Date(proposition.time.valid_from).toISOString() !== proposition.time.valid_from || new Date(proposition.time.valid_to).toISOString() !== proposition.time.valid_to ||
              span(item.records[0]!, proposition.time.witness).end_utf16 <= 0)) throw new Error("invalid core semantic time rule");
        }
        const expectedPerspective = item.category === "reported" ? "person_statement" : (item.category === "historical" || item.category === "maintenance_outline") ? "document_report" : "direct";
        const detailPerspectives = (predicate: string) => item.category === "maintenance_outline" && predicate === "situation.objective"
          ? ["document_report", "document_suggestion"] : [expectedPerspective];
        if (rule.classification.perspective !== "direct" || rule.details.some(row => !detailPerspectives(row.predicate).includes(row.perspective))) throw new Error("core semantic source role mismatch");
        if (rule.label_alternatives !== undefined && (item.category !== "historical" || ![1, 2].includes(rule.label_alternatives.length) ||
            (rule.label_alternatives.length === 2 && rule.label_alternatives[0]!.perspective !== "direct") ||
            rule.label_alternatives.at(-1)!.perspective !== "document_report" ||
            rule.label_alternatives.some(row => canonicalJson(row.time) !== canonicalJson(rule.classification.time)))) throw new Error("invalid label alternatives");
      }
    }
  }
}

export function coreSemanticCaseInput(item: CoreSemanticCase, registry: WorldRegistry, rawPolicy: QualificationInputPolicy = DEFAULT_QUALIFICATION_INPUT_POLICY): ProduceInputV2 {
  const policy = validateQualificationInputPolicy(rawPolicy);
  if (item.records.some(record => record.structured_subjects !== undefined)) {
    const fixture = structuredSourceContext(item);
    return withWorldRegistry(registry, () => worldProduceInput(fixture.events as never, fixture.supplied.input,
      { max_input_tokens: policy.max_input_tokens, max_output_tokens: policy.max_output_tokens }));
  }
  const events = item.records.map((record, index) => ({ event_id: eventId(index), text: record.text }));
  const supplied = item.records.flatMap((record, index) => record.subjects.map(subject => {
    const anchor = span(record, subject.quote);
    return { id: subject.id, anchors: [{ ...anchor, event_id: eventId(index) }] };
  }));
  return withWorldRegistry(registry, () => worldProduceInput(events as never, supplied, { max_input_tokens: policy.max_input_tokens, max_output_tokens: policy.max_output_tokens }));
}

/** Derive host-owned handles with the same source namespaces as ordinary extraction. */
function structuredSourceContext(item: CoreSemanticCase) {
  const events = item.records.map((record, index) => ({ event_id: eventId(index), text: record.text,
    connector_id: "qualification.synthetic", subjects: record.structured_subjects ?? [] }));
  const supplied = worldSuppliedReferences(events, id => {
    const index = events.findIndex(event => event.event_id === id);
    return index < 0 ? null : String(index + 100).padStart(26, "0");
  });
  return { events, supplied };
}

function validateGeneralBranch(item: CoreSemanticCase, branch: GeneralExtractBranch): void {
  const exact = (value: unknown, required: readonly string[], optional: readonly string[] = []) => isPlainObject(value) &&
    required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => [...required, ...optional].includes(key));
  const text = (value: unknown): value is string => typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 1_000;
  const atoms = (value: unknown): value is string[] => Array.isArray(value) && value.length >= 1 && value.length <= 16 && value.every(text) && new Set(value).size === value.length;
  if (!exact(branch, ["id", "entities", "propositions", "forbidden_assertions"]) || !/^[a-z][a-z0-9-]{0,63}$/.test(branch.id) ||
      !Array.isArray(branch.entities) || branch.entities.length < 1 || branch.entities.length > 8 ||
      !Array.isArray(branch.propositions) || branch.propositions.length < 1 || branch.propositions.length > 32 ||
      new Set(branch.propositions.map(prop => prop.rule_id)).size !== branch.propositions.length ||
      !atoms(branch.forbidden_assertions)) throw new Error("invalid complete proposition branch");
  for (const record of item.records) {
    if (!Array.isArray(record.structured_subjects) || record.structured_subjects.length > 8 ||
        new Set(record.structured_subjects.map(subject => subject.subject_id)).size !== record.structured_subjects.length) throw new Error("invalid structured subjects");
    for (const subject of record.structured_subjects) {
      if (!exact(subject, ["subject_id", "role", "display_name"]) || !text(subject.subject_id) || !text(subject.display_name) ||
          !["about", "from", "to"].includes(subject.role)) throw new Error("invalid structured subject");
      span(record, subject.display_name);
    }
  }
  if (new Set(branch.entities.map(entity => `${entity.record}:${entity.label}`)).size !== branch.entities.length) throw new Error("duplicate authored entity");
  for (const entity of branch.entities) {
    const record = item.records.find(record => record.id === entity.record);
    if (!exact(entity, ["label", "record", "allowed_occurrence_spans", "consistency"]) || !record || !text(entity.label) || !text(entity.consistency)) throw new Error("invalid entity");
    const occurrences = []; let start = record.text.indexOf(entity.label);
    while (start >= 0) { occurrences.push({ start_utf16: start, end_utf16: start + entity.label.length }); start = record.text.indexOf(entity.label, start + 1); }
    if (!occurrences.length || occurrences.length > 16 || canonicalJson(entity.allowed_occurrence_spans) !== canonicalJson(occurrences)) throw new Error("incomplete source occurrences");
  }
  const selector = (value: EntitySelector) => {
    if (value.mode === "source_occurrence") {
      if (!exact(value, ["mode", "record", "label"]) || !branch.entities.some(entity => entity.record === value.record && entity.label === value.label)) throw new Error("unbound source entity");
    } else if (value.mode !== "structured_source_subject" || !exact(value, ["mode", "record", "subject_id"]) ||
        !item.records.find(record => record.id === value.record)?.structured_subjects?.some(subject => subject.subject_id === value.subject_id)) throw new Error("unbound structured entity");
  };
  const direct = { holder: null, speaker: null, addressee: null, mode: "asserted", interpretation: "explicit" };
  const unknown = { valid_from: null, valid_to: null, temporal_basis: "unknown" };
  for (const prop of branch.propositions) {
    if (!exact(prop, ["rule_id", "subject", "predicate", "object", "witness", "perspective", "polarity", "time", "context"], ["required_relation_atoms", "symmetric", "witness_mode"]) ||
        !/^[a-z][a-z0-9-]{0,63}$/.test(prop.rule_id) || !text(prop.predicate) || !text(prop.witness) ||
        canonicalJson(prop.perspective) !== canonicalJson(direct) || prop.polarity !== "positive" || canonicalJson(prop.time) !== canonicalJson(unknown) ||
        !Array.isArray(prop.context) || prop.context.length > 4 || new Set(prop.context.map(canonicalJson)).size !== prop.context.length ||
        (prop.required_relation_atoms !== undefined && !atoms(prop.required_relation_atoms))) throw new Error("invalid complete proposition");
    selector(prop.subject); prop.context.forEach(selector);
    const record = item.records.find(record => record.id === prop.subject.record)!;
    span(record, prop.witness);
    if (prop.witness_mode !== undefined) {
      const classification = branch.propositions.find(candidate => candidate.predicate === "world.kind" && canonicalJson(candidate.subject) === canonicalJson(prop.subject));
      const kind = classification?.object.kind === "vocabulary" ? classification.object.value : "";
      if (prop.witness_mode !== "selected_entity_label/v1" || prop.subject.mode !== "source_occurrence" ||
          !["world/concept", "world/situation"].includes(kind) || prop.predicate !== `${kind.slice(6)}.label` ||
          prop.object.kind !== "literal" || !prop.witness.includes(prop.subject.label)) throw new Error("invalid selected entity label witness");
    }
    if (prop.object.kind === "subject") { if (!exact(prop.object, ["kind", "entity"]) || !atoms(prop.required_relation_atoms)) throw new Error("invalid relation atoms"); selector(prop.object.entity); }
    else if (prop.object.kind === "literal") { if (!exact(prop.object, ["kind", "required_atoms"]) || !atoms(prop.object.required_atoms)) throw new Error("invalid literal atoms"); }
    else if (prop.object.kind !== "vocabulary" || !exact(prop.object, ["kind", "value"]) || !text(prop.object.value)) throw new Error("invalid vocabulary object");
    if (prop.symmetric !== undefined && (prop.symmetric !== true || !["concept.same_as", "concept.distinguished_from"].includes(prop.predicate) || prop.object.kind !== "subject")) throw new Error("unsupported symmetric rule");
  }
  // The finite contract is frozen, but it must also be internally complete: every
  // source-local entity receives its own classification, exact label and definition.
  for (const entity of branch.entities) {
    const props = branch.propositions.filter(prop => prop.subject.mode === "source_occurrence" && prop.subject.label === entity.label && prop.subject.record === entity.record);
    const kind = props.find(prop => prop.predicate === "world.kind");
    const kindValue = kind?.object.kind === "vocabulary" ? kind.object.value : "";
    if (props.filter(prop => prop.predicate === "world.kind").length !== 1 || kind?.object.kind !== "vocabulary" || !["world/concept", "world/situation"].includes(kind.object.value) ||
        props.filter(prop => prop.predicate === `${kindValue.slice(6)}.label`).length !== 1 ||
        (kindValue === "world/concept" && props.filter(prop => prop.predicate === "concept.definition").length !== 1)) throw new Error("incomplete entity classification");
  }
}

function matchGeneralPropositions(item: CoreSemanticCase, branch: Omit<GeneralExtractBranch, "id">, response: NonNullable<Observation["response"]>, input: ProduceInputV2) {
  const errors: string[] = [], attribution: string[] = [], time: string[] = [], matches: { rule_id: string; predicate: string; claim_id: string; claim_sha256: string }[] = [];
  const bindings = new Map<string, string>();
  const source = structuredSourceContext(item);
  for (const entity of branch.entities) {
    const index = item.records.findIndex(record => record.id === entity.record);
    const candidates = response.mentions.filter(mention => mention.label === entity.label && mention.candidate_refs.length === 0 &&
      entity.allowed_occurrence_spans.some(anchor => canonicalJson(mention.anchor) === canonicalJson({ event_id: input.events[index]!.event_id, ...anchor })));
    if (candidates.length !== 1) errors.push(`entity:${entity.label}`);
    else bindings.set(canonicalJson({ mode: "source_occurrence", record: entity.record, label: entity.label }), `mention:${candidates[0]!.id}`);
  }
  for (const [index, record] of item.records.entries()) for (const subject of record.structured_subjects ?? []) {
    const candidates = [...source.supplied.refs].filter(([, raw]) => raw.kind === "supplied" && raw.id === subject.subject_id &&
      raw.namespace.connector_id === "qualification.synthetic" && raw.namespace.source_key === String(index + 100).padStart(26, "0"));
    if (candidates.length !== 1) errors.push(`structured:${subject.subject_id}`);
    else bindings.set(canonicalJson({ mode: "structured_source_subject", record: record.id, subject_id: subject.subject_id }), `supplied:${candidates[0]![0]}`);
  }
  const key = (selector: EntitySelector) => bindings.get(canonicalJson(selector));
  const used = new Set<string>();
  const predicates = new Set(branch.propositions.map(prop => prop.predicate));
  const typed = response.claims.filter(claim => !legacyPredicates.has(claim.predicate));
  const legacyExtras = response.claims.filter(claim => legacyPredicates.has(claim.predicate));
  if (legacyExtras.some(claim => forbiddenLegacyPredicates.includes(claim.predicate as typeof forbiddenLegacyPredicates[number]))) errors.push("forbidden_legacy_extra");
  for (const prop of branch.propositions) {
    const candidates = typed.filter(claim => {
      if (claim.predicate !== prop.predicate) return false;
      const subject = rawRefKey(claim.subject), object = claim.object;
      const forward = subject === key(prop.subject) && (prop.object.kind !== "subject" || (object.kind === "subject" && rawRefKey(object.ref) === key(prop.object.entity)));
      const reverse = prop.symmetric === true && prop.object.kind === "subject" && subject === key(prop.object.entity) && object.kind === "subject" && rawRefKey(object.ref) === key(prop.subject);
      return forward || reverse;
    });
    if (candidates.length !== 1) { errors.push(`${prop.rule_id}:claim_count`); continue; }
    const claim = candidates[0]!;
    if (used.has(claim.id)) errors.push(`${prop.rule_id}:reused_claim`);
    used.add(claim.id);
    if (claim.polarity !== prop.polarity) errors.push(`${prop.rule_id}:polarity`);
    if (!exactTime(claim, "unknown")) time.push(`${prop.rule_id}:time`);
    if (!exactPerspective(claim, { witness: prop.witness, perspective: "direct", time: "unknown" }, null)) attribution.push(`${prop.rule_id}:perspective`);
    if (canonicalJson(claim.context.map(rawRefKey).sort()) !== canonicalJson(prop.context.map(key).sort())) errors.push(`${prop.rule_id}:context`);
    if (prop.object.kind === "literal") {
      if (claim.object.kind !== "literal" || (prop.predicate.endsWith(".label") && prop.subject.mode === "source_occurrence" && claim.object.value !== prop.subject.label)) errors.push(`${prop.rule_id}:literal`);
    } else if (prop.object.kind === "vocabulary" && (claim.object.kind !== "vocabulary" || claim.object.ref.id !== prop.object.value)) errors.push(`${prop.rule_id}:vocabulary`);
    if (prop.witness_mode === "selected_entity_label/v1") {
      // The binding above already selects one exact allowed occurrence. Another
      // occurrence of the same spelling cannot witness this bound label claim.
      const mention = response.mentions.find(mention => `mention:${mention.id}` === key(prop.subject));
      if (!mention || !claim.anchors.some(anchor => canonicalJson(anchor) === canonicalJson(mention.anchor))) errors.push(`${prop.rule_id}:witness`);
    } else {
      const index = item.records.findIndex(record => record.id === prop.subject.record), expected = span(item.records[index]!, prop.witness);
      let end = expected.start_utf16;
      for (const anchor of claim.anchors.filter(anchor => anchor.event_id === input.events[index]!.event_id).sort((a,b) => a.start_utf16 - b.start_utf16)) {
        if (anchor.start_utf16 > end) break; end = Math.max(end, anchor.end_utf16);
      }
      if (end < expected.end_utf16) errors.push(`${prop.rule_id}:witness`);
    }
    matches.push({ rule_id: prop.rule_id, predicate: prop.predicate, claim_id: claim.id, claim_sha256: sha256(canonicalJson(claim)) });
  }
  if (typed.some(claim => !predicates.has(claim.predicate) || !used.has(claim.id)) || used.size !== typed.length) errors.push("uncontracted_typed_claim");
  return { errors, attribution, time, matches, legacyExtras };
}

/** The fixture is host-owned and derives exclusively from the exact quoted request. */
function fixtureContext(input: ProduceInputV2, item?: CoreSemanticCase): WorldDraftContext {
  const events = input.events.map((event, index) => ({ ...event, connector_id: "qualification.synthetic",
    source_record_id: event.event_id, source_key: String(index + 100).padStart(26, "0"), content_hash_version: 1,
    content_hash: sha256(canonicalJson(event)), text_hash: sha256(event.text), origin_binding: "external",
    accepted_at: "2000-01-01T00:00:00.000Z", subjects: [] as RawSubjectRef[] }));
  const structured = item?.records.some(record => record.structured_subjects !== undefined) ? structuredSourceContext(item) : null;
  if (structured && canonicalJson(structured.supplied.input) !== canonicalJson(input.supplied_refs)) throw new Error("structured fixture mapping mismatch");
  const supplied = new Map<string, RawSubjectRef>();
  for (const ref of input.supplied_refs) {
    const ids = new Set(ref.anchors.map(anchor => anchor.event_id));
    const event = events.find(row => ids.has(row.event_id));
    if (ids.size !== 1 || event === undefined) throw new Error("ambiguous qualification fixture identity");
    const raw: RawSubjectRef = structured ? structured.supplied.refs.get(ref.id)! : { kind: "supplied", id: ref.id,
      namespace: { connector_id: event.connector_id, source_key: event.source_key } };
    supplied.set(ref.id, raw); event.subjects.push(raw);
  }
  const freeze = <T>(value: T): T => {
    if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
    return value;
  };
  freeze(input);
  return { events: freeze(events), supplied_refs: supplied, model_ref: "synthetic-qualification", witness_event_ids: new Set(events.map(event => event.event_id)),
    sent_evidence_windows: freeze(input.events.map(event => ({ event_id: event.event_id, start_utf16: 0,
      end_utf16: event.text.length, text: event.text }))) };
}

/** Runs the real pipeline twice: original guard result, then the attested-context path.
 * No evaluator normalizer or admission substitute exists. Neither call mutates storage.
 */
export function prepareCoreSemanticObservation(observed: Observation, registry: WorldRegistry, item?: CoreSemanticCase) {
  const errors: string[] = [], input = structuredClone(observed.input), context = fixtureContext(input, item);
  const fixture = { input, ...(item?.records.some(record => record.structured_subjects !== undefined) ? { structured_source_metadata: item.records.map(record => record.structured_subjects) } : {}), events: context.events, supplied_refs: [...context.supplied_refs], model_ref: context.model_ref,
    witness_event_ids: [...context.witness_event_ids!], admission_context: { schema_version: LEDGER_SCHEMA_VERSION,
      stored_claims: [], pending_classifications: [], grounding: [], callback: "worldAssertionViolation+notePendingClassification" } };
  const input_manifest_sha256 = sha256(canonicalJson(fixture));
  const sent_window_manifest_sha256 = sha256(canonicalJson(context.sent_evidence_windows));
  let drafts: readonly WorldDraftInsert[] = [], original: readonly WorldDraftInsert[] = [];
  let correspondence: { claim_id: string; raw_claim_sha256: string; admission_sha256: string; guard_mode: string; guard_interpretation: string }[] = [];
  try {
    if (observed.response === null) throw new Error("missing response");
    const response = structuredClone(observed.response), before = canonicalJson(response);
    const { budget: _budget, ...parseInput } = input;
    const parsed = parseExtractResponseV2(JSON.stringify(response), parseInput);
    if (!parsed.ok || parsed.dropped.length || canonicalJson(parsed.response) !== before) throw new Error("response not canonical parsed output");
    const { sent_evidence_windows: _windows, ...narrow } = context;
    const prepare = (host: WorldDraftContext) => {
      const db = openLedger(":memory:"), pending: PendingClassifications = new Map();
      try {
        // Match journalWorldDrafts: each preparation sees a fresh real ledger and
        // its own in-order classifications. The evaluator cannot write rows.
        db.exec("PRAGMA query_only = ON");
        return withWorldRegistry(registry, () => prepareWorldDrafts(response, input, { ...host, admits: semantic => {
          if (worldAssertionViolation(db, semantic, { pending }) !== null) return false;
          notePendingClassification(pending, semantic);
          return true;
        } }));
      } finally { db.close(); }
    };
    const baseline = prepare(narrow), prepared = prepare(context);
    original = baseline.drafts; drafts = prepared.drafts;
    if (baseline.dropped.length || prepared.dropped.length || original.length !== response.claims.length || drafts.length !== response.claims.length) errors.push("pipeline_drop_or_count");
    const ref = (value: DraftRef): RawSubjectRef => {
      if (value.kind === "supplied") { const raw = context.supplied_refs.get(value.id); if (!raw) throw new Error("missing supplied ref"); return raw; }
      const mention = response.mentions.find(row => row.id === value.id), event = context.events.find(row => row.event_id === mention?.anchor.event_id);
      if (!mention || !event) throw new Error("missing occurrence ref");
      return { kind: "occurrence", id: mintOccurrenceId(event, event.source_key, mention.anchor) };
    };
    correspondence = response.claims.flatMap((claim, index) => {
      const guarded = original[index], admitted = drafts[index];
      if (!guarded || !admitted) return [];
      const expected: ClaimV2Assertion = { schema: CLAIM_V2_SCHEMA, discriminator: "assertion", subject: ref(claim.subject), predicate: claim.predicate,
        object: claim.object.kind === "subject" ? { kind: "subject", ref: ref(claim.object.ref) } : claim.object,
        perspective: { ...claim.perspective, holder: claim.perspective.holder === null ? null : ref(claim.perspective.holder),
          speaker: claim.perspective.speaker === null ? null : ref(claim.perspective.speaker),
          addressee: claim.perspective.addressee === null ? null : ref(claim.perspective.addressee) },
        context: claim.context.map(ref).sort((a,b) => rawSubjectRefKey(a) < rawSubjectRefKey(b) ? -1 : rawSubjectRefKey(a) > rawSubjectRefKey(b) ? 1 : 0),
        polarity: claim.polarity, valid_from: claim.valid_from, valid_to: claim.valid_to, temporal_basis: claim.temporal_basis, anchors: claim.anchors };
      if (canonicalJson(guarded.semantic) !== canonicalJson(expected)) errors.push(`${claim.id}:guard_changed_semantics`);
      const originalAnchors = guarded.semantic.perspective.anchors, admittedAnchors = admitted.semantic.perspective.anchors;
      const allowed = new Set([...originalAnchors, ...context.sent_evidence_windows!.map(({ text: _text, ...anchor }) => anchor)].map(canonicalJson));
      if (admittedAnchors.length > MAX_V2_ANCHORS_PER_ITEM || new Set(admittedAnchors.map(canonicalJson)).size !== admittedAnchors.length ||
          admittedAnchors.some(anchor => !allowed.has(canonicalJson(anchor)))) errors.push(`${claim.id}:invalid_prepared_anchor_delta`);
      const normalized = { ...admitted, semantic: { ...admitted.semantic, perspective: { ...admitted.semantic.perspective, anchors: originalAnchors } },
        world_admission: { ...admitted.world_admission, semantic: { ...admitted.world_admission.semantic,
          perspective: { ...admitted.world_admission.semantic.perspective, anchors: originalAnchors } } } };
      if (canonicalJson(normalized) !== canonicalJson(guarded) || admitted.body !== claim.body || admitted.confidence !== claim.confidence || admitted.sensitivity !== claim.sensitivity ||
          originalAnchors.some(anchor => !admitted.semantic.perspective.anchors.some(row => canonicalJson(row) === canonicalJson(anchor)))) errors.push(`${claim.id}:prepared_changed_semantics`);
      return [{ claim_id: claim.id, raw_claim_sha256: sha256(canonicalJson(claim)), admission_sha256: sha256(canonicalJson(admitted.world_admission)),
        guard_mode: guarded.semantic.perspective.mode, guard_interpretation: guarded.semantic.perspective.interpretation }];
    });
    if (drafts.reduce((sum, draft) => sum + draft.semantic.anchors.length + draft.semantic.perspective.anchors.length, 0) > MAX_V2_ANCHORS)
      errors.push("prepared_anchor_budget_exceeded");
    if (canonicalJson(response) !== before || sha256(canonicalJson({ ...fixture, supplied_refs: [...context.supplied_refs] })) !== input_manifest_sha256) errors.push("fixture_or_response_mutated");
  } catch { errors.push("pipeline_refused"); }
  return { errors, drafts, input_manifest_sha256, sent_window_manifest_sha256,
    prepared_admissions_sha256: sha256(canonicalJson(drafts.map(row => row.world_admission))), correspondence };
}

export interface CoreSemanticEvidence {
  readonly input_policy: QualificationInputPolicy;
  readonly source_commit: string;
  readonly traces: readonly { readonly case_id: string; readonly response_sha256: string | null; readonly model_response_sha256: string | null; readonly input_planning_sha256?: string }[];
  readonly wire_adapter: ModelWireAdapterIdentity;
  readonly wire_receipts: readonly CoreSemanticWireEvidence[];
}

function rawRefKey(ref: { kind: "supplied" | "mention"; id: string }): string { return `${ref.kind}:${ref.id}`; }
function exactTime(claim: RichClaimDraft, rule: TimeRule): boolean {
  if (rule === "unknown") return claim.valid_from === null && claim.valid_to === null && claim.temporal_basis === "unknown";
  return claim.valid_from !== null && claim.valid_to !== null && Number.isFinite(Date.parse(claim.valid_from)) && Number.isFinite(Date.parse(claim.valid_to)) &&
    new Date(claim.valid_from).toISOString() === rule.valid_from && new Date(claim.valid_to).toISOString() === rule.valid_to && claim.temporal_basis === rule.temporal_basis;
}

function exactPerspective(claim: RichClaimDraft, rule: PropositionRule, sourceKey: string | null, equivalentKey: string | null = null): boolean {
  const perspective = claim.perspective;
  if (perspective.interpretation !== "explicit" || perspective.addressee !== null) return false;
  if (rule.perspective === "direct") return perspective.mode === "asserted" && perspective.holder === null && perspective.speaker === null;
  const document = rule.perspective === "document_report" || rule.perspective === "document_suggestion";
  const modes = rule.perspective === "document_suggestion" ? ["suggested"] : document ? ["reported"] : ["reported", "quoted"];
  if (sourceKey === null || !modes.includes(perspective.mode)) return false;
  const matches = (key: string) => key === sourceKey || (equivalentKey !== null && key === equivalentKey);
  if (document) return perspective.holder !== null && matches(rawRefKey(perspective.holder)) && perspective.speaker === null;
  return perspective.speaker !== null && matches(rawRefKey(perspective.speaker)) &&
    (perspective.holder === null || rawRefKey(perspective.holder) === rawRefKey(perspective.speaker));
}

/** Attribution needs its reporting words on every claim, not merely a named actor. */
function roleEvidence(claim: RichClaimDraft, rule: PropositionRule, item: CoreSemanticCase, input: ProduceInputV2, prepared?: readonly TextAnchor[]): boolean {
  if (rule.perspective === "direct") return true;
  const witness = rule.attribution_witness ?? (typeof rule.source === "object" ? rule.source.attribution_witness : undefined);
  if (witness === undefined) return false;
  const index = item.records.findIndex(record => record.text.includes(witness));
  if (index < 0) return false;
  const expected = span(item.records[index]!, witness);
  const anchors = [...claim.anchors, ...(prepared ?? claim.perspective.anchors)].filter(anchor => anchor.event_id === input.events[index]!.event_id)
    .sort((a, b) => a.start_utf16 - b.start_utf16);
  let end = expected.start_utf16;
  for (const anchor of anchors) { if (anchor.start_utf16 > end) break; end = Math.max(end, anchor.end_utf16); }
  return end >= expected.end_utf16;
}

function propositionMatches(claim: RichClaimDraft, rule: PropositionRule, item: CoreSemanticCase, response: NonNullable<Observation["response"]>, input: ProduceInputV2, prepared?: readonly TextAnchor[]): boolean {
  const equivalent = rule.equivalent_mention === undefined ? null : sourceKey({ ...rule, source: rule.equivalent_mention }, item, response, input);
  return exactPerspective(claim, rule, sourceKey(rule, item, response, input), equivalent) && roleEvidence(claim, rule, item, input, prepared);
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

export function scoreCoreSemanticCase(item: CoreSemanticCase, rule: LegacyExtractRule | GeneralCaseRule | AbstainRule, observed: Observation | undefined, registry: WorldRegistry, policy: QualificationInputPolicy, prepared?: ReadonlyMap<string, readonly TextAnchor[]>) {
  const gates = { observation: [] as string[], schema: [] as string[], usage: [] as string[], abstention: [] as string[], structure: [] as string[], attribution: [] as string[], time: [] as string[] };
  let legacyExtras: RichClaimDraft[] = [];
  let matchedPropositions: { rule_id: string; predicate: string; claim_id: string; claim_sha256: string }[] = [];
  if (observed === undefined) gates.observation.push("not_run");
  else {
    const expectedInput = coreSemanticCaseInput(item, registry, policy);
    if (observed.case_id !== item.id || canonicalJson(observed.input) !== canonicalJson(expectedInput)) gates.observation.push("input_mismatch");
    if (observed.status !== "ok" || observed.response === null) gates.observation.push(observed.status);
    if (observed.response !== null) {
      const { budget: _budget, ...parseInput } = observed.input;
      const parsed = parseExtractResponseV2(JSON.stringify(observed.response), parseInput);
      if (!parsed.ok || parsed.dropped.length !== 0) gates.schema.push("invalid_typed_response");
      if (observed.dropped !== 0) gates.schema.push("dropped_claims");
      if (rule.expectation === "abstain") {
        if (observed.response.claims.length !== 0) gates.abstention.push("claims_present");
      } else if (parsed.ok && parsed.dropped.length === 0 && "propositions" in rule) {
        const scored = "scope" in rule ? matchScopedPropositions(item, rule, observed.response, observed.input, registry, prepared)
          : matchGeneralPropositions(item, rule, observed.response, observed.input);
        gates.structure.push(...scored.errors); gates.attribution.push(...scored.attribution); gates.time.push(...scored.time); matchedPropositions = scored.matches; legacyExtras = scored.legacyExtras;
      } else if (parsed.ok && parsed.dropped.length === 0 && !("propositions" in rule)) {
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
        if (!label || label.object.kind !== "literal" || (rule.label_rule?.naming === "source_description" ? label.object.value !== rule.label_rule.value : normalized(label.object.value) !== rule.classification.label) || label.polarity !== "positive" ||
            !label.anchors.some(anchor => canonicalJson(anchor) === canonicalJson(targetAnchor))) gates.structure.push("label_mismatch");
        for (const claim of [classification, label]) if (claim) {
          const alternatives = claim === label ? rule.label_rule ? [rule.label_rule] : rule.label_alternatives ?? [rule.classification] : [rule.classification];
          if (!alternatives.some(proposition => propositionMatches(claim, proposition, item, observed.response!, observed.input, prepared?.get(claim.id)))) gates.attribution.push(`${claim.predicate}:perspective`);
          if (!alternatives.some(proposition => exactTime(claim, proposition.time))) gates.time.push(`${claim.predicate}:time`);
        }
        for (const detail of rule.details) {
          const claim = typedClaims.find(row => row.predicate === detail.predicate);
          if (!claim || claim.object.kind !== "literal" || claim.polarity !== "positive") { gates.structure.push(`${detail.predicate}:missing`); continue; }
          if (!propositionMatches(claim, detail, item, observed.response, observed.input, prepared?.get(claim.id))) gates.attribution.push(`${detail.predicate}:perspective`);
          if (!exactTime(claim, detail.time)) gates.time.push(`${detail.predicate}:time`);
        }
      }
    }
    if (observed.usage.calls !== 1 || observed.usage.input_tokens === null || observed.usage.output_tokens === null) gates.usage.push("unmeasured_usage");
    for (const count of [observed.usage.input_tokens, observed.usage.output_tokens]) if (count !== null && (!Number.isSafeInteger(count) || count < 0 || count > 100_000_000)) gates.usage.push("invalid_usage");
    if ((observed.usage.input_tokens ?? 0) > policy.max_input_tokens) gates.usage.push("input_budget_exceeded");
    if ((observed.usage.output_tokens ?? 0) > policy.max_output_tokens) gates.usage.push("output_budget_exceeded");
  }
  const responseSha256 = observed?.response === null || observed?.response === undefined ? null : sha256(canonicalJson(observed.response));
  return { case_id: item.id, expectation: rule.expectation, automated_passed: Object.values(gates).every(errors => errors.length === 0), gates,
    ...("propositions" in rule ? { proposition_matches: matchedPropositions } : {}),
    manual_review: rule.expectation === "abstain" ? { status: "pending" as const, response_sha256: responseSha256, abstention: "confirm_exact_zero_claim_response" as const }
      : { status: "pending" as const, response_sha256: responseSha256,
        required_atoms: "propositions" in rule ? rule.propositions.flatMap(prop => [...(prop.object.kind === "literal" ? prop.object.required_atoms : []), ...(prop.required_relation_atoms ?? [])]
          .map(atom => ({ rule_id: prop.rule_id, predicate: prop.predicate, atom })))
          : rule.details.flatMap(detail => detail.required_atoms.map(atom => ({ predicate: detail.predicate, atom }))),
        legacy_extras: legacyExtras.map(claim => ({ claim_id: claim.id, predicate: claim.predicate, claim_sha256: sha256(canonicalJson(claim)) })),
        forbidden_assertions: rule.forbidden_assertions } };
}

/** Every candidate runs the same closed scorer. Selection never joins partial branches. */
export function scoreCoreSemanticRepresentations(item: CoreSemanticCase, rule: AnyExtractRule | AbstainRule, observed: Observation | undefined,
  registry: WorldRegistry, policy: QualificationInputPolicy, prepared?: ReadonlyMap<string, readonly TextAnchor[]>) {
  const branches = rule.expectation === "abstain" ? [] : coreSemanticBranches(rule);
  const candidates = rule.expectation === "abstain"
    ? [scoreCoreSemanticCase(item, rule, observed, registry, policy, prepared)]
    : branches.map(branch => scoreCoreSemanticCase(item, coreSemanticBranchRule(item.id, branch), observed, registry, policy, prepared));
  const index = candidates.findIndex(candidate => candidate.automated_passed), score = candidates[index < 0 ? 0 : index]!;
  const branch = rule.expectation === "extract" && index >= 0 ? branches[index]! : null;
  const binding = { selected_branch_id: branch?.id ?? null, selected_branch_sha256: branch === null ? null : sha256(canonicalJson(branch)),
    selected_branch: branch === null ? null : structuredClone(branch) };
  const representation = rule.expectation === "extract" && index < 0 ? ["no_complete_representation_branch"] : [];
  return { ...score, ...binding, automated_passed: score.automated_passed && representation.length === 0,
    gates: { ...score.gates, representation },
    branch_results: branches.map((branch, candidate) => ({ branch_id: branch.id, branch_sha256: sha256(canonicalJson(branch)),
      automated_passed: candidates[candidate]!.automated_passed, gates: candidates[candidate]!.gates })),
    manual_review: { ...score.manual_review, ...binding } };
}

export function scoreCoreSemanticRun(observations: readonly Observation[], registry: WorldRegistry, evidence: CoreSemanticEvidence, assets: CoreSemanticAssetSet = coreSemanticAssets()) {
  const policy = validateQualificationInputPolicy(evidence.input_policy);
  if (new Set(observations.map(row => row.case_id)).size !== observations.length || observations.some(row => !assets.corpus.cases.some(item => item.id === row.case_id))) throw new Error("unknown or duplicate core semantic observation");
  const cases = assets.corpus.cases.map(item => {
    const observed = observations.find(row => row.case_id === item.id), rule = assets.contract.cases.find(row => row.case_id === item.id)!;
    const pipeline = observed?.response ? prepareCoreSemanticObservation(observed, registry, item) : null;
    const anchors = new Map(pipeline?.drafts.map((draft,index) => [observed!.response!.claims[index]?.id ?? "", draft.semantic.perspective.anchors]));
    const prepared = scoreCoreSemanticRepresentations(item, rule, observed, registry, policy, anchors);
    const diagnosticBranch = rule.expectation === "extract" ? prepared.selected_branch ?? coreSemanticBranches(rule)[0]! : null;
    const raw = scoreCoreSemanticCase(item, rule.expectation === "abstain" ? rule : coreSemanticBranchRule(item.id, diagnosticBranch!), observed, registry, policy);
    const matches = evidence.traces.filter(row => row.case_id === item.id), transportSha = matches.length === 1 ? matches[0]!.response_sha256 : null;
    const modelResponseSha = matches.length === 1 ? matches[0]!.model_response_sha256 : null;
    const custody = inspectCoreSemanticWireEvidence({ case_id: item.id, input: observed?.input ?? coreSemanticCaseInput(item, registry, policy), input_policy: policy,
      input_planning_sha256: matches.length === 1 ? matches[0]!.input_planning_sha256 ?? null : null,
      response: observed?.response ?? null, transport_response_sha256: transportSha, model_response_sha256: modelResponseSha,
      adapter: evidence.wire_adapter, evidence: evidence.wire_receipts });
    const pipelineErrors = [...(pipeline?.errors ?? ["not_prepared"])];
    if (assets.split === "union22" && observed?.response) {
      const world = new Set(registry.offered.vocabulary.map(row => row.predicate));
      const allowed = new Set(diagnosticBranch === null ? [] : coreSemanticBranchPredicates(diagnosticBranch));
      if (observed.response.claims.some(claim => world.has(claim.predicate) && !allowed.has(claim.predicate))) pipelineErrors.push("uncontracted_world_predicate");
    }
    if (!/^[a-f0-9]{40}$/.test(evidence.source_commit) || !/^[a-f0-9]{64}$/.test(transportSha ?? "")) pipelineErrors.push("unbound_pipeline_evidence");
    pipelineErrors.push(...custody.errors.map(error => `custody:${error}`));
    return { ...prepared, stage: "prepared_admission" as const,
      automated_passed: prepared.automated_passed && pipelineErrors.length === 0 && (assets.split !== "union22" || raw.automated_passed),
      gates: { ...prepared.gates, pipeline: pipelineErrors },
      raw_model: { stage: "raw_model" as const, selected_branch_id: prepared.selected_branch_id, diagnostic_branch_id: diagnosticBranch?.id ?? null, automated_passed: raw.automated_passed, gates: raw.gates },
      raw_citation_precision: { passed: raw.gates.observation.length === 0 && raw.gates.schema.length === 0 && raw.gates.attribution.length === 0, failures: raw.gates.attribution },
      pipeline: pipeline === null ? null : { input_manifest_sha256: pipeline.input_manifest_sha256,
        sent_window_manifest_sha256: pipeline.sent_window_manifest_sha256, prepared_admissions_sha256: pipeline.prepared_admissions_sha256,
        correspondence: pipeline.correspondence, prepared_admissions: pipeline.drafts.map(row => row.world_admission) },
      manual_review: { ...prepared.manual_review, stage: "prepared_admission" as const, transport_response_sha256: transportSha,
        input_manifest_sha256: pipeline?.input_manifest_sha256 ?? null, sent_window_manifest_sha256: pipeline?.sent_window_manifest_sha256 ?? null,
        prepared_admissions_sha256: pipeline?.prepared_admissions_sha256 ?? null, ...custody.binding } };
  });
  return { schema: assets.split === "union22" ? "kizuki.core-semantic-result/v4" as const : "kizuki.core-semantic-result/v3" as const,
    protocol: assets.split === "union22" ? UNION_SEMANTIC_PROTOCOL : CORE_SEMANTIC_PROTOCOL, stage: "prepared_admission" as const,
    representation_method: CORE_SEMANTIC_REPRESENTATION_METHOD, source_commit: evidence.source_commit, input_policy: policy, corpus_sha256: assets.corpus_sha256, contract_sha256: assets.contract_sha256,
    ...(assets.split !== "regression13" ? { core_split: assets.split } : {}),
    raw_model_automated_passed: cases.every(row => row.raw_model.automated_passed),
    automated_passed: cases.every(row => row.automated_passed), status: "pending_manual_review" as const, cases };
}

export function expectedCoreSemanticReview(reportSha256: string, result: ReturnType<typeof scoreCoreSemanticRun>) {
  if (!result.automated_passed || result.cases.some(row => !row.automated_passed || (row.expectation === "extract" && row.selected_branch === null)))
    throw new Error("core semantic review requires complete passing branches");
  return { schema: result.protocol === UNION_SEMANTIC_PROTOCOL ? "kizuki.core-semantic-review/v4" as const : "kizuki.core-semantic-review/v3" as const,
    stage: "prepared_admission" as const, source_commit: result.source_commit, independent: true, status: "passed" as const, report_sha256: reportSha256,
    representation_method: result.representation_method, ...("core_split" in result ? { core_split: result.core_split } : {}), input_policy: result.input_policy, corpus_sha256: result.corpus_sha256, contract_sha256: result.contract_sha256,
    cases: result.cases.map(row => {
      const rule = row.expectation === "abstain" ? { expectation: "abstain" as const } : coreSemanticBranchRule(row.case_id, row.selected_branch!);
      const binding = { selected_branch_id: row.selected_branch_id, selected_branch_sha256: row.selected_branch_sha256, selected_branch: row.selected_branch, input_planning: row.manual_review.input_planning, producer_input_token_overhead: row.manual_review.producer_input_token_overhead, transport_response_sha256: row.manual_review.transport_response_sha256,
        input_manifest_sha256: row.manual_review.input_manifest_sha256, sent_window_manifest_sha256: row.manual_review.sent_window_manifest_sha256,
        prepared_admissions_sha256: row.manual_review.prepared_admissions_sha256, wire_schema: row.manual_review.wire_schema,
        receipt_schema: row.manual_review.receipt_schema, adapter_source_sha256: row.manual_review.adapter_source_sha256,
        raw_model_response_sha256: row.manual_review.raw_model_response_sha256, transport_model_response_sha256: row.manual_review.transport_model_response_sha256,
        outbound_sha256: row.manual_review.outbound_sha256,
        resolution_receipt_sha256: row.manual_review.resolution_receipt_sha256, translated_response_sha256: row.manual_review.translated_response_sha256 };
      return rule.expectation === "abstain"
        ? { ...binding, case_id: row.case_id, response_sha256: row.manual_review.response_sha256, status: "passed" as const, abstention: "confirmed" as const }
        : { ...binding, case_id: row.case_id, response_sha256: row.manual_review.response_sha256, status: "passed" as const,
          atoms: "propositions" in rule ? rule.propositions.flatMap(prop => [...(prop.object.kind === "literal" ? prop.object.required_atoms : []), ...(prop.required_relation_atoms ?? [])]
            .map(atom => ({ rule_id: prop.rule_id, predicate: prop.predicate, atom, status: "supported" as const })))
            : rule.details.flatMap(detail => detail.required_atoms.map(atom => ({ predicate: detail.predicate, atom, status: "supported" as const }))), literal_consistency: "passed" as const,
          body_fidelity: "passed" as const,
          evidence: "propositions" in rule ? rule.propositions.map(prop => ({ ...row.proposition_matches!.find(match => match.rule_id === prop.rule_id)!,
            anchors_jointly_support_claim: "passed" as const, role_and_time_supported: "passed" as const }))
            : ["world.kind", `${rule.classification.kind.slice(6)}.label`, ...rule.details.map(detail => detail.predicate)]
              .map(predicate => ({ predicate, anchors_jointly_support_claim: "passed" as const, role_and_time_supported: "passed" as const })), unsupported_additions: [],
          legacy_extras: (row.manual_review.legacy_extras ?? []).map(extra => ({ ...extra, literal_supported: "passed" as const, body_fidelity: "passed" as const,
            references_grounded: "passed" as const, anchors_jointly_support_claim: "passed" as const, role_and_time_supported: "passed" as const,
            source_entailment: "passed" as const, unsupported_additions: "absent" as const })),
          forbidden_assertions: rule.forbidden_assertions.map(assertion => ({ assertion, status: "absent" as const })) }; }) };
}

export function verifyCoreSemanticReview(reportSha256: string, result: ReturnType<typeof scoreCoreSemanticRun>, review: unknown): void {
  if (!result.automated_passed || canonicalJson(review) !== canonicalJson(expectedCoreSemanticReview(reportSha256, result))) throw new Error("core semantic review mismatch");
}
