import type { ExtractResponseV2, ProduceInputV2, RichClaimDraft } from "../../packages/core/src/contracts/producer-v2";
import { parseExtractResponseV2 } from "../../packages/core/src/contracts/producer-v2";
import type { WorldRegistry } from "../../packages/core/src/contracts/world-kinds";
import { withWorldRegistry } from "../../packages/core/src/contracts/world-vocabulary";
import { worldProduceInput } from "../../packages/core/src/serve/extract-v2";
import { canonicalJson, sha256 } from "../evaluate-extraction";

export const FAMILIES = ["positive", "abstention", "perspective", "time"] as const;
export type Family = typeof FAMILIES[number];
export interface RecordInput { id: string; text: string; subjects: { id: string; quote: string }[] }
/** Full typed meaning; renderings are reported separately and do not repair a failed semantic tuple. */
export interface Meaning {
  subject: string; predicate: string; object: { kind: "literal" | "subject" | "vocabulary"; value: string };
  holder: string | null; speaker: string | null; addressee: string | null;
  mode: RichClaimDraft["perspective"]["mode"]; interpretation: "explicit" | "inferred";
  context: string[]; polarity: "positive" | "negative"; valid_from: string | null; valid_to: string | null;
  temporal_basis: "explicit" | "observed" | "unknown"; citations: string[]; perspective_citations: string[];
}
export interface QualificationCase {
  id: string; kind: string; family: Family; records: RecordInput[];
  /** Exact request-local identity nominations expected on witness mentions, never prompt data. */
  nominations?: { mention: string; supplied: string }[];
  /** Finite, record-grounded equivalent reference representations; one representation per response. */
  references?: { key: string; refs: string[] }[];
  /** Ordinary nominations are bounded data; only identity witnesses require exact grounding. */
  ordinary_nominations?: "bounded";
  /** Each required tuple has finite, predeclared alternatives, not model-graded fuzzy matching. */
  required: Meaning[][]; optional: Meaning[];
}
export interface QualificationCorpus {
  schema: "kizuki.world-qualification-corpus/v1" | "kizuki.world-qualification-corpus/v2"; synthetic: true;
  split: "held_out"; version: string; cases: QualificationCase[];
}
export interface Observation {
  case_id: string; input: ProduceInputV2; status: "ok" | "unavailable" | "rejected";
  response: ExtractResponseV2 | null; dropped: number;
  usage: { calls: number; input_tokens: number | null; output_tokens: number | null };
}

const eventId = (index: number) => String(index + 1).padStart(26, "0");
export function caseInput(item: QualificationCase, registry: WorldRegistry): ProduceInputV2 {
  const events = item.records.map((record, index) => ({ event_id: eventId(index), text: record.text }));
  const refs = new Map<string, { event_id: string; start_utf16: number; end_utf16: number }[]>();
  item.records.forEach((record, index) => record.subjects.forEach(subject => {
    const start = record.text.indexOf(subject.quote);
    if (start < 0 || record.text.indexOf(subject.quote, start + 1) >= 0) throw new Error(`ambiguous supplied anchor: ${item.id}`);
    refs.set(subject.id, [...(refs.get(subject.id) ?? []), { event_id: eventId(index), start_utf16: start, end_utf16: start + subject.quote.length }]);
  }));
  return withWorldRegistry(registry, () => worldProduceInput(events as never,
    [...refs].map(([id, anchors]) => ({ id, anchors })), { max_input_tokens: 8_192, max_output_tokens: 8_192 }));
}

/** The stable occurrence identity contains its exact source span, never a label-based identity guess. */
export function mentionRef(record: RecordInput, quote: string): string {
  const start = record.text.indexOf(quote);
  if (start < 0 || record.text.indexOf(quote, start + 1) >= 0) throw new Error("ambiguous reference quote");
  return `mention:${record.id}:${start}:${start + quote.length}`;
}
const normalized = (text: string) => text.normalize("NFC").trim().replace(/\s+/g, " ");
function normalizeMeaning(value: Meaning): Meaning {
  return { ...value, object: { ...value.object, value: normalized(value.object.value) },
    valid_from: value.valid_from === null ? null : new Date(value.valid_from).toISOString(),
    valid_to: value.valid_to === null ? null : new Date(value.valid_to).toISOString(),
    context: [...value.context].sort(), citations: [...value.citations].sort(), perspective_citations: [...value.perspective_citations].sort() };
}
function canonicalRef(item: QualificationCase, value: string | null): string | null {
  return value === null ? null : item.references?.find(row => row.refs.includes(value))?.key ?? value;
}
function canonicalMeaning(item: QualificationCase, meaning: Meaning): Meaning {
  return normalizeMeaning({ ...meaning, subject: canonicalRef(item, meaning.subject)!,
    object: meaning.object.kind === "subject" ? { ...meaning.object, value: canonicalRef(item, meaning.object.value)! } : meaning.object,
    holder: canonicalRef(item, meaning.holder), speaker: canonicalRef(item, meaning.speaker), addressee: canonicalRef(item, meaning.addressee),
    context: meaning.context.map(ref => canonicalRef(item, ref)!),
  });
}
export function responseMeanings(item: QualificationCase, response: ExtractResponseV2): Meaning[] {
  const records = new Map(item.records.map((row, index) => [eventId(index), row.id]));
  const mentions = new Map(response.mentions.map(row => [row.id, row]));
  const ref = (value: { kind: "supplied" | "mention"; id: string } | null): string | null => {
    if (value === null) return null;
    if (value.kind === "supplied") return `supplied:${value.id}`;
    const mention = mentions.get(value.id);
    return mention === undefined ? "invalid:missing-mention" : `mention:${records.get(mention.anchor.event_id) ?? "invalid"}:${mention.anchor.start_utf16}:${mention.anchor.end_utf16}`;
  };
  const citations = (anchors: readonly { event_id: string }[]) => [...new Set(anchors.map(anchor => records.get(anchor.event_id) ?? "invalid"))].sort();
  return response.claims.map(claim => canonicalMeaning(item, {
    subject: ref(claim.subject)!, predicate: claim.predicate,
    object: { kind: claim.object.kind, value: claim.object.kind === "literal" ? claim.object.value : claim.object.kind === "vocabulary" ? claim.object.ref.id : ref(claim.object.ref)! },
    holder: ref(claim.perspective.holder), speaker: ref(claim.perspective.speaker), addressee: ref(claim.perspective.addressee),
    mode: claim.perspective.mode, interpretation: claim.perspective.interpretation, context: claim.context.map(value => ref(value)!),
    polarity: claim.polarity, valid_from: claim.valid_from, valid_to: claim.valid_to, temporal_basis: claim.temporal_basis,
    citations: citations(claim.anchors), perspective_citations: citations(claim.perspective.anchors),
  }));
}

export function validateCorpus(corpus: QualificationCorpus): void {
  if (!["kizuki.world-qualification-corpus/v1", "kizuki.world-qualification-corpus/v2"].includes(corpus.schema) || corpus.synthetic !== true || corpus.split !== "held_out" ||
    !/^[a-z0-9-]{1,64}$/.test(corpus.version) || corpus.cases.length < 4 || corpus.cases.length > 100) throw new Error("invalid qualification corpus");
  const ids = new Set<string>();
  for (const item of corpus.cases) {
    if (!/^[a-z0-9-]{1,80}$/.test(item.id) || ids.has(item.id) || !FAMILIES.includes(item.family) || !/^[a-z0-9_]{1,40}$/.test(item.kind) ||
      item.records.length < 1 || item.records.length > 8 || item.required.length > 32 || item.optional.length > 64 ||
      (item.family !== "abstention" && item.required.length === 0)) throw new Error("invalid qualification case");
    ids.add(item.id);
    if ((item.references !== undefined || item.ordinary_nominations !== undefined) && corpus.schema !== "kizuki.world-qualification-corpus/v2") throw new Error("legacy corpus cannot change reference semantics");
    if (item.references !== undefined) {
      if (item.references.length > 32 || new Set(item.references.map(row => row.key)).size !== item.references.length) throw new Error("invalid reference alternatives");
      const seen = new Set<string>();
      for (const group of item.references) {
        if (!/^entity:[a-z0-9-]{1,50}$/.test(group.key) || group.refs.length < 1 || group.refs.length > 8) throw new Error("invalid reference alternative");
        for (const ref of group.refs) {
          if (seen.has(ref)) throw new Error("ambiguous reference alternative"); seen.add(ref);
          if (ref.startsWith("supplied:")) {
            if (!item.records.some(row => row.subjects.some(subject => `supplied:${subject.id}` === ref))) throw new Error("unbound supplied alternative");
          } else {
            const match = /^mention:([^:]+):(\d+):(\d+)$/.exec(ref), record = item.records.find(row => row.id === match?.[1]);
            if (match === null || record === undefined || Number(match[2]) >= Number(match[3]) || Number(match[3]) > record.text.length) throw new Error("unbound mention alternative");
          }
        }
      }
    }
    if (new Set(item.records.map(row => row.id)).size !== item.records.length || item.records.some(row => row.text.length === 0 || row.text.length > 8000) ||
      item.records.reduce((n, row) => n + row.text.length, 0) > 24_000) throw new Error("invalid qualification records");
    for (const alternatives of item.required) if (alternatives.length < 1 || alternatives.length > 8) throw new Error("invalid oracle alternatives");
    for (const meaning of [...item.required.flat(), ...item.optional]) {
      if (meaning.citations.length === 0 || [...meaning.citations, ...meaning.perspective_citations].some(id => !item.records.some(row => row.id === id))) throw new Error("oracle has no source support");
      normalizeMeaning(meaning);
    }
  }
  for (const kind of new Set(corpus.cases.map(row => row.kind))) for (const family of FAMILIES) {
    if (!corpus.cases.some(row => row.kind === kind && row.family === family)) throw new Error(`missing ${kind}/${family} corpus`);
  }
}

export function scoreCase(item: QualificationCase, observed: Observation) {
  const errors: string[] = [];
  if (observed.status !== "ok" || observed.response === null) return { id: item.id, family: item.family, passed: false, errors: [observed.status], claims: 0 };
  const { budget: _budget, ...parseInput } = observed.input;
  const parsed = parseExtractResponseV2(JSON.stringify(observed.response), parseInput);
  if (!parsed.ok || parsed.dropped.length !== 0) return { id: item.id, family: item.family, passed: false, errors: ["invalid_typed_response"], claims: 0 };
  if (observed.dropped !== 0) errors.push("dropped_claims");
  if (observed.usage.calls !== 1 || observed.usage.input_tokens === null || observed.usage.output_tokens === null) errors.push("unmeasured_usage");
  for (const count of [observed.usage.input_tokens, observed.usage.output_tokens]) if (count !== null && (!Number.isSafeInteger(count) || count < 0 || count > 100_000_000)) errors.push("invalid_usage");
  if ((observed.usage.output_tokens ?? 0) > observed.input.budget.max_output_tokens) errors.push("output_budget_exceeded");
  const expectedNominations = new Map((item.nominations ?? []).map(row => [row.mention, row.supplied]));
  const seenNominations = new Set<string>();
  for (const mention of observed.response.mentions) {
    const record = item.records[observed.input.events.findIndex(event => event.event_id === mention.anchor.event_id)];
    const key = `mention:${record?.id}:${mention.anchor.start_utf16}:${mention.anchor.end_utf16}`;
    const expected = expectedNominations.get(key);
    if (expected === undefined) { if (item.ordinary_nominations !== "bounded" && mention.candidate_refs.length !== 0) errors.push("unsupported_nomination"); }
    else {
      seenNominations.add(key);
      if (mention.candidate_refs.length !== 1 || mention.candidate_refs[0]?.kind !== "supplied" || mention.candidate_refs[0]?.id !== expected) errors.push("incorrect_nomination");
    }
  }
  for (const key of expectedNominations.keys()) if (!seenNominations.has(key)) errors.push("missing_nomination");
  // Reference alternatives may not hide a classification/detail split that produces no usable card.
  if (item.references !== undefined) {
    const used = new Map<string, Set<string>>();
    const rawRef = (ref: { kind: "supplied" | "mention"; id: string } | null) => {
      if (ref === null) return;
      const mention = ref.kind === "mention" ? observed.response!.mentions.find(row => row.id === ref.id) : undefined;
      const record = mention === undefined ? undefined : item.records[observed.input.events.findIndex(event => event.event_id === mention.anchor.event_id)];
      const raw = ref.kind === "supplied" ? `supplied:${ref.id}` : `mention:${record?.id}:${mention?.anchor.start_utf16}:${mention?.anchor.end_utf16}`;
      const key = canonicalRef(item, raw)!;
      if (!key.startsWith("entity:")) return;
      const representations = used.get(key) ?? new Set<string>(); representations.add(raw); used.set(key, representations);
    };
    for (const claim of observed.response.claims) {
      [claim.subject, ...(claim.object.kind === "subject" ? [claim.object.ref] : []), ...claim.context,
        claim.perspective.holder, claim.perspective.speaker, claim.perspective.addressee].forEach(rawRef);
      if ((claim.predicate.startsWith("person.") || claim.predicate === "relationship.with" ||
          (claim.predicate === "world.kind" && claim.object.kind === "vocabulary" && claim.object.ref.id === "world/person")) && claim.subject.kind !== "supplied") errors.push("invalid_person_ref");
      if (["relationship.with", "commitment.debtor", "commitment.creditor"].includes(claim.predicate) && claim.object.kind === "subject" && claim.object.ref.kind !== "supplied") errors.push("invalid_person_endpoint");
    }
    if ([...used.values()].some(refs => refs.size > 1)) errors.push("split_reference_identity");
  }
  const keys = responseMeanings(item, observed.response).map(value => canonicalJson(value));
  const required = item.required.map(alternatives => alternatives.map(value => canonicalJson(canonicalMeaning(item, value))));
  const allowed = new Set([...required.flat(), ...item.optional.map(value => canonicalJson(canonicalMeaning(item, value)))]);
  required.forEach((alternatives, index) => { if (!keys.some(key => alternatives.includes(key))) errors.push(`missing_meaning:${index}`); });
  keys.forEach((key, index) => { if (!allowed.has(key)) errors.push(`unsupported_meaning:${index}`); });
  if (new Set(keys).size !== keys.length) errors.push("duplicate_meaning");
  return { id: item.id, family: item.family, passed: errors.length === 0, errors, claims: keys.length };
}

export function scoreRun(corpus: QualificationCorpus, observations: readonly Observation[]) {
  validateCorpus(corpus);
  if (new Set(observations.map(row => row.case_id)).size !== observations.length || observations.some(row => !corpus.cases.some(item => item.id === row.case_id))) throw new Error("duplicate or unknown observation");
  const kinds = [...new Set(corpus.cases.map(item => item.kind))].sort().map(kind => {
    const cases = corpus.cases.filter(item => item.kind === kind).map(item => {
      const observed = observations.find(row => row.case_id === item.id);
      return observed === undefined ? { id: item.id, family: item.family, passed: false, errors: ["not_run"], claims: 0 } : scoreCase(item, observed);
    });
    const status = cases.every(item => item.errors.includes("not_run")) ? "not_run" : cases.every(item => item.passed) ? "passed" : "failed";
    return { kind, status, cases };
  });
  return { corpus_sha256: sha256(canonicalJson(corpus)), status: kinds.every(row => row.status === "not_run") ? "not_run" : kinds.every(row => row.status === "passed") ? "passed" : "failed", kinds };
}
