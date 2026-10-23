import type { DraftRef, ExtractResponseV2, ProduceInputV2, RichClaimDraft, TextAnchor } from "../../packages/core/src/contracts/producer-v2";
import type { WorldRegistry } from "../../packages/core/src/contracts/world-kinds";
import { worldSuppliedReferences } from "../../packages/core/src/serve/world-supplied";
import { PREDICATE_REGISTRY } from "../../packages/core/src/claims/predicates";
import { isRfc3339 } from "../../packages/core/src/util/time";
import { canonicalJson, sha256 } from "../evaluate-extraction";
import type { CoreSemanticCase, EntitySelector, GeneralExtractBranch, GeneralPropositionRule } from "./core-semantic";

export const UNION_SEMANTIC_PROTOCOL = "core-semantic-v4" as const;
export interface ScopedPerspective {
  holder: EntitySelector | null; speaker: EntitySelector | null; addressee: EntitySelector | null;
  mode: RichClaimDraft["perspective"]["mode"]; interpretation: "explicit" | "inferred";
}
export interface ScopedPropositionRule extends Omit<GeneralPropositionRule, "perspective" | "polarity" | "time"> {
  perspective: ScopedPerspective;
  /** Each alternative is complete; fields from different alternatives never mix. */
  perspective_alternatives?: ScopedPerspective[];
  polarity: "positive" | "negative";
  time: { valid_from: string | null; valid_to: string | null; temporal_basis: "unknown" | "explicit"; witness?: string };
  attribution_witness?: string;
}
export interface ScopedExtractBranch extends Omit<GeneralExtractBranch, "propositions"> {
  scope: "world-union/v1"; propositions: ScopedPropositionRule[];
}
type ScopedRule = Omit<ScopedExtractBranch, "id">;
const refKey = (ref: DraftRef) => `${ref.kind}:${ref.id}`;
const selectorKey = (ref: EntitySelector) => canonicalJson(ref);
const legacy = new Set(PREDICATE_REGISTRY.map(row => row.id));
const exact = (value: unknown, required: readonly string[], optional: readonly string[] = []) => value !== null && typeof value === "object" && !Array.isArray(value) &&
  required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => [...required, ...optional].includes(key));
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 8_000 && value.trim() === value;
const atoms = (value: unknown): value is string[] => Array.isArray(value) && value.length > 0 && value.length <= 16 && value.every(text) && new Set(value).size === value.length;

function authoredSpan(item: CoreSemanticCase, recordId: string, quote: string, input: ProduceInputV2): TextAnchor {
  const index = item.records.findIndex(record => record.id === recordId), record = item.records[index];
  const start = record?.text.indexOf(quote) ?? -1;
  if (!record || !quote || start < 0 || record.text.indexOf(quote, start + 1) >= 0) throw Error("ambiguous union witness");
  return { event_id: input.events[index]!.event_id, start_utf16: start, end_utf16: start + quote.length };
}
function covers(anchors: readonly TextAnchor[], expected: TextAnchor): boolean {
  let end = expected.start_utf16;
  for (const anchor of anchors.filter(a => a.event_id === expected.event_id).sort((a, b) => a.start_utf16 - b.start_utf16)) {
    if (anchor.start_utf16 > end) break;
    end = Math.max(end, anchor.end_utf16);
  }
  return end >= expected.end_utf16;
}
function suppliedContext(item: CoreSemanticCase) {
  const events = item.records.map((r, i) => ({ event_id: String(i + 1).padStart(26, "0"), connector_id: "qualification.synthetic", text: r.text, subjects: r.structured_subjects ?? [] }));
  return worldSuppliedReferences(events, id => String(events.findIndex(event => event.event_id === id) + 100).padStart(26, "0"));
}

/** Strict prospective validation; neither the v3 schema nor its matcher calls this. */
export function validateScopedBranch(item: CoreSemanticCase, branch: ScopedExtractBranch, registry: WorldRegistry): void {
  if (!exact(branch, ["id", "scope", "entities", "propositions", "forbidden_assertions"]) || branch.scope !== "world-union/v1" ||
      !/^[a-z][a-z0-9-]{0,63}$/.test(branch.id) || !Array.isArray(branch.entities) || branch.entities.length > 8 ||
      !Array.isArray(branch.propositions) || branch.propositions.length < 1 || branch.propositions.length > 32 ||
      new Set(branch.propositions.map(p => p.rule_id)).size !== branch.propositions.length || !atoms(branch.forbidden_assertions)) throw Error("invalid union branch");
  const fixture = suppliedContext(item);
  const selector = (s: EntitySelector) => {
    if (!s || typeof s !== "object") throw Error("invalid union selector");
    if (s.mode === "source_occurrence") {
      if (!exact(s, ["mode", "record", "label"]) || !branch.entities.some(e => e.record === s.record && e.label === s.label)) throw Error("unbound union occurrence");
    } else if (s.mode !== "structured_source_subject" || !exact(s, ["mode", "record", "subject_id"]) ||
        !item.records.find(r => r.id === s.record)?.structured_subjects?.some(v => v.subject_id === s.subject_id)) throw Error("unbound union subject");
  };
  if (new Set(branch.entities.map(e => `${e.record}:${e.label}`)).size !== branch.entities.length) throw Error("duplicate union entity");
  for (const e of branch.entities) {
    const record = item.records.find(r => r.id === e.record), spans: { start_utf16: number; end_utf16: number }[] = [];
    if (!exact(e, ["label", "record", "allowed_occurrence_spans", "consistency"]) || !record || !text(e.label) || !text(e.consistency)) throw Error("invalid union entity");
    let at = record.text.indexOf(e.label);
    while (at >= 0) { spans.push({ start_utf16: at, end_utf16: at + e.label.length }); at = record.text.indexOf(e.label, at + 1); }
    if (!spans.length || spans.length > 16 || canonicalJson(spans) !== canonicalJson(e.allowed_occurrence_spans)) throw Error("incomplete union occurrences");
  }
  const perspectives = (p: ScopedPropositionRule) => [p.perspective, ...(p.perspective_alternatives ?? [])];
  for (const p of branch.propositions) {
    if (!exact(p, ["rule_id", "subject", "predicate", "object", "witness", "perspective", "polarity", "time", "context"],
      ["perspective_alternatives", "attribution_witness", "required_relation_atoms", "symmetric", "witness_mode"]) ||
        !/^[a-z][a-z0-9-]{0,63}$/.test(p.rule_id) || !text(p.witness) || !registry.spec(p.predicate) ||
        !["positive", "negative"].includes(p.polarity) || !Array.isArray(p.context) || p.context.length > 4 ||
        new Set(p.context.map(selectorKey)).size !== p.context.length || !exact(p.time, ["valid_from", "valid_to", "temporal_basis"], ["witness"])) throw Error("invalid scoped proposition");
    selector(p.subject); p.context.forEach(selector);
    const spec = registry.offered.vocabulary.find(row => row.predicate === p.predicate);
    if (!spec || !spec.polarity.includes(p.polarity) || (p.object.kind === "literal" ? !spec.objects.includes("literal") : p.object.kind === "vocabulary"
      ? !spec.objects.includes("vocabulary") || !registry.offered.refs.includes(p.object.value) || (spec.vocabulary_values !== null && !spec.vocabulary_values.includes(p.object.value))
      : !spec.objects.includes("raw_subject") && !spec.objects.includes("concept"))) throw Error("union proposition outside offered contract");
    if (p.time.temporal_basis === "unknown" ? p.time.valid_from !== null || p.time.valid_to !== null :
        p.time.temporal_basis !== "explicit" || !isRfc3339(p.time.valid_from) || !isRfc3339(p.time.valid_to) || p.time.valid_from! >= p.time.valid_to! ||
        new Date(p.time.valid_from!).toISOString() !== p.time.valid_from || new Date(p.time.valid_to!).toISOString() !== p.time.valid_to || !text(p.time.witness)) throw Error("invalid union time");
    if (p.perspective_alternatives !== undefined && (!Array.isArray(p.perspective_alternatives) || p.perspective_alternatives.length > 3)) throw Error("invalid union alternatives");
    if (new Set(perspectives(p).map(canonicalJson)).size !== perspectives(p).length) throw Error("duplicate union perspective");
    for (const view of perspectives(p)) {
      if (!exact(view, ["holder", "speaker", "addressee", "mode", "interpretation"]) ||
          !["asserted", "quoted", "reported", "hypothetical", "suggested", "questioned", "uncertain"].includes(view.mode) || !["explicit", "inferred"].includes(view.interpretation)) throw Error("invalid union perspective");
      for (const role of [view.holder, view.speaker, view.addressee]) if (role !== null) selector(role);
      if ([view.holder, view.speaker, view.addressee].some(role => role !== null) && !text(p.attribution_witness)) throw Error("missing union attribution witness");
    }
    if (p.object.kind === "literal") { if (!exact(p.object, ["kind", "required_atoms"]) || !atoms(p.object.required_atoms)) throw Error("invalid union literal atoms"); }
    else if (p.object.kind === "subject") { if (!exact(p.object, ["kind", "entity"]) || !atoms(p.required_relation_atoms)) throw Error("invalid union relation atoms"); selector(p.object.entity); }
    else if (p.object.kind !== "vocabulary" || !exact(p.object, ["kind", "value"]) || !text(p.object.value)) throw Error("invalid union object");
    if (p.symmetric !== undefined && (p.symmetric !== true || !["concept.same_as", "concept.distinguished_from"].includes(p.predicate))) throw Error("invalid symmetric union rule");
    // Labels alone may use the already-bound name occurrence. Every other witness is unique and complete.
    const record = item.records.find(r => r.id === p.subject.record)!;
    if (!record || !record.text.includes(p.witness) || (p.witness_mode === undefined && record.text.indexOf(p.witness, record.text.indexOf(p.witness) + 1) >= 0)) throw Error("invalid union witness");
    if (p.time.witness && (!record.text.includes(p.time.witness) || record.text.indexOf(p.time.witness, record.text.indexOf(p.time.witness) + 1) >= 0)) throw Error("invalid union time witness");
    if (p.attribution_witness && (!record.text.includes(p.attribution_witness) || record.text.indexOf(p.attribution_witness, record.text.indexOf(p.attribution_witness) + 1) >= 0)) throw Error("invalid union attribution");
  }
  const subjects = new Map(branch.propositions.map(p => [selectorKey(p.subject), p.subject]));
  for (const subject of subjects.values()) {
    const props = branch.propositions.filter(p => selectorKey(p.subject) === selectorKey(subject));
    const kinds = props.filter(p => p.predicate === "world.kind"), kind = kinds[0]?.object;
    const module = kind?.kind === "vocabulary" ? registry.kindByVocabularyId(kind.value) : undefined;
    if (kinds.length !== 1 || !module || props.filter(p => p.predicate === module.labelPredicate).length !== 1 ||
        (module.id === "person" && subject.mode !== "structured_source_subject") ||
        (module.id === "concept" && props.filter(p => p.predicate === "concept.definition").length !== 1)) throw Error("incomplete union subject");
    for (const p of props.filter(p => p.witness_mode !== undefined)) {
      const name = subject.mode === "source_occurrence" ? subject.label : item.records.find(r => r.id === subject.record)!.structured_subjects!.find(s => s.subject_id === subject.subject_id)!.display_name;
      if (p.witness_mode !== "selected_entity_label/v1" || p.predicate !== module.labelPredicate || p.object.kind !== "literal" || !name || !p.witness.includes(name)) throw Error("invalid union label witness");
    }
  }
  for (const record of item.records) for (const subject of record.structured_subjects ?? []) {
    const index = item.records.indexOf(record);
    if (![...fixture.refs.values()].some(ref => ref.id === subject.subject_id && ref.namespace.source_key === String(index + 100).padStart(26, "0"))) throw Error("unavailable genuine union handle");
  }
}

/** Exact qualified preselection, followed by cardinality; no scorer normalization or fallback. */
export function matchScopedPropositions(item: CoreSemanticCase, branch: ScopedRule, response: ExtractResponseV2, input: ProduceInputV2, registry: WorldRegistry, prepared?: ReadonlyMap<string, readonly TextAnchor[]>) {
  const errors: string[] = [], attribution: string[] = [], time: string[] = [], matches: { rule_id: string; predicate: string; claim_id: string; claim_sha256: string }[] = [];
  const bindings = new Map<string, { key: string; anchor: TextAnchor; label: string }>();
  for (const entity of branch.entities) {
    const index = item.records.findIndex(r => r.id === entity.record);
    const candidates = response.mentions.filter(m => m.label === entity.label && m.candidate_refs.length === 0 && entity.allowed_occurrence_spans.some(a => canonicalJson(m.anchor) === canonicalJson({ event_id: input.events[index]!.event_id, ...a })));
    if (candidates.length !== 1) errors.push(`entity:${entity.record}:${entity.label}`);
    else bindings.set(selectorKey({ mode: "source_occurrence", record: entity.record, label: entity.label }), { key: `mention:${candidates[0]!.id}`, anchor: candidates[0]!.anchor, label: entity.label });
  }
  const source = suppliedContext(item);
  if (canonicalJson(source.input) !== canonicalJson(input.supplied_refs)) errors.push("structured_input_mismatch");
  for (const [index, record] of item.records.entries()) for (const subject of record.structured_subjects ?? []) {
    const handles = [...source.refs].filter(([, ref]) => ref.id === subject.subject_id && ref.namespace.connector_id === "qualification.synthetic" && ref.namespace.source_key === String(index + 100).padStart(26, "0"));
    const handle = handles.length === 1 ? source.input.find(h => h.id === handles[0]![0]) : undefined;
    if (!handle || handle.anchors.length !== 1 || !subject.display_name) errors.push(`structured:${record.id}:${subject.subject_id}`);
    else bindings.set(selectorKey({ mode: "structured_source_subject", record: record.id, subject_id: subject.subject_id }), { key: `supplied:${handle.id}`, anchor: handle.anchors[0]!, label: subject.display_name });
  }
  const key = (s: EntitySelector) => bindings.get(selectorKey(s))?.key;
  const role = (r: DraftRef | null) => r === null ? null : refKey(r);
  const perspective = (claim: RichClaimDraft, view: ScopedPerspective) => claim.perspective.mode === view.mode && claim.perspective.interpretation === view.interpretation &&
    (["holder", "speaker", "addressee"] as const).every(name => role(claim.perspective[name]) === (view[name] === null ? null : key(view[name]!)));
  // As in v3, exact RFC3339 instants may differ in their equivalent spelling.
  const sameTime = (claim: RichClaimDraft, p: ScopedPropositionRule) => p.time.temporal_basis === "unknown"
    ? claim.valid_from === null && claim.valid_to === null && claim.temporal_basis === "unknown"
    : isRfc3339(claim.valid_from) && isRfc3339(claim.valid_to) && claim.temporal_basis === "explicit" &&
      new Date(claim.valid_from).toISOString() === p.time.valid_from && new Date(claim.valid_to).toISOString() === p.time.valid_to;
  // commitment.due is also a legacy ID. Every offered world row remains
  // typed, including an extra that this branch never contracted.
  const world = new Set(registry.offered.vocabulary.map(p => p.predicate));
  const used = new Set<string>(), typed = response.claims.filter(c => !legacy.has(c.predicate) || world.has(c.predicate)), legacyExtras = response.claims.filter(c => legacy.has(c.predicate) && !world.has(c.predicate));
  if (legacyExtras.some(c => ["identity.same_as", "project.owns"].includes(c.predicate))) errors.push("forbidden_legacy_extra");
  for (const p of branch.propositions) {
    const candidates = typed.filter(claim => {
      const forward = refKey(claim.subject) === key(p.subject) && (p.object.kind !== "subject" || (claim.object.kind === "subject" && refKey(claim.object.ref) === key(p.object.entity)));
      const reverse = p.symmetric === true && p.object.kind === "subject" && refKey(claim.subject) === key(p.object.entity) && claim.object.kind === "subject" && refKey(claim.object.ref) === key(p.subject);
      const object = claim.object.kind === p.object.kind && (p.object.kind !== "vocabulary" || (claim.object.kind === "vocabulary" && claim.object.ref.id === p.object.value));
      return claim.predicate === p.predicate && (forward || reverse) && object && claim.polarity === p.polarity && sameTime(claim, p) &&
        [p.perspective, ...(p.perspective_alternatives ?? [])].some(view => perspective(claim, view)) &&
        canonicalJson(claim.context.map(refKey).sort()) === canonicalJson(p.context.map(key).sort());
    });
    if (candidates.length !== 1) { errors.push(`${p.rule_id}:claim_count`); continue; }
    const claim = candidates[0]!;
    if (used.has(claim.id)) errors.push(`${p.rule_id}:reused_claim`);
    used.add(claim.id);
    if (claim.object.kind !== p.object.kind || (p.object.kind === "vocabulary" && (claim.object.kind !== "vocabulary" || claim.object.ref.id !== p.object.value))) errors.push(`${p.rule_id}:object`);
    if (claim.object.kind === "literal" && claim.perspective.interpretation === "explicit") {
      const literal = claim.object.value;
      if (!claim.anchors.some(a => input.events.find(e => e.event_id === a.event_id)?.text.slice(a.start_utf16, a.end_utf16).includes(literal))) errors.push(`${p.rule_id}:literal_not_source_copy`);
    }
    const bound = bindings.get(selectorKey(p.subject));
    if (p.witness_mode === "selected_entity_label/v1") {
      if (!bound || claim.object.kind !== "literal" || claim.object.value !== bound.label || !claim.anchors.some(a => canonicalJson(a) === canonicalJson(bound.anchor)) ||
          input.events.find(e => e.event_id === bound.anchor.event_id)?.text.slice(bound.anchor.start_utf16, bound.anchor.end_utf16) !== bound.label) errors.push(`${p.rule_id}:witness`);
    } else if (!covers(claim.anchors, authoredSpan(item, p.subject.record, p.witness, input))) errors.push(`${p.rule_id}:witness`);
    if (p.attribution_witness && !covers([...claim.anchors, ...(prepared?.get(claim.id) ?? claim.perspective.anchors)], authoredSpan(item, p.subject.record, p.attribution_witness, input))) attribution.push(`${p.rule_id}:attribution_witness`);
    if (p.time.witness && !covers([...claim.anchors, ...(prepared?.get(claim.id) ?? claim.perspective.anchors)], authoredSpan(item, p.subject.record, p.time.witness, input))) time.push(`${p.rule_id}:time_witness`);
    matches.push({ rule_id: p.rule_id, predicate: p.predicate, claim_id: claim.id, claim_sha256: sha256(canonicalJson(claim)) });
  }
  if (typed.some(c => !used.has(c.id)) || used.size !== typed.length) errors.push("uncontracted_typed_claim");
  return { errors, attribution, time, matches, legacyExtras };
}
