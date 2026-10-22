import { readFileSync } from "node:fs";
import { canonicalJson, sha256 } from "../evaluate-extraction";
import { qualificationCorpus } from "./corpus-v5-core";
import oracleJson from "./corpus-v5-core-semantic-oracle.json";
import freeze from "./corpus-v5-core-freeze.json";
import { responseMeanings, scoreCase, validateCorpus, type Meaning, type Observation, type QualificationCase } from "./score";
import type { TextAnchor } from "../../packages/core/src/contracts/producer-v2";

interface Witness { record: string; start_utf16: number; end_utf16: number; quote: string }
interface Detail {
  predicate: string; acceptable_literal_values: string[]; substantive_atoms_all_required: string[][];
  evidence_span: Witness; forbidden_interpretations: string[];
  perspective: Pick<Meaning, "holder" | "speaker" | "addressee" | "mode" | "interpretation"> & { evidence_span: Witness | null };
  valid_from: string | null; valid_to: string | null; temporal_basis: Meaning["temporal_basis"];
}
interface OracleCase {
  case_id: string; expectation: "extract" | "abstain"; target?: string;
  structural_requirements?: { kind: string; label: string; label_span: Witness };
  details?: Detail[]; time_witness?: Witness; forbidden_interpretations?: string[]; forbidden_owner_interpretation?: string;
}
const oracle = oracleJson as { cases: OracleCase[] };
const normalized = (value: string) => value.normalize("NFC").trim().replace(/\s+/g, " ");
const iso = (value: string | null) => value === null ? null : new Date(value).toISOString();

/** Check sealed source bytes before opening any endpoint. No observed answer may repair this split. */
export function validateFreshCore(): void {
  const files = { "corpus.json": "corpus-v5-core.json", "semantic-oracle.json": "corpus-v5-core-semantic-oracle.json",
    "validation.json": "corpus-v5-core-author-validation.json", "README.md": "corpus-v5-core-author.md" } as const;
  for (const [original, path] of Object.entries(files) as [keyof typeof files, string][]) {
    const bytes = readFileSync(new URL(path, import.meta.url)), pin = freeze.files[original];
    if (bytes.length !== pin.bytes || sha256(bytes) !== pin.byte_sha256) throw new Error("fresh core author bytes changed");
    if ("sorted_compact_json_sha256" in pin && sha256(canonicalJson(JSON.parse(bytes.toString()))) !== pin.sorted_compact_json_sha256)
      throw new Error("fresh core canonical bytes changed");
  }
  validateCorpus(qualificationCorpus);
  if (qualificationCorpus.cases.length !== 12 || oracle.cases.length !== 12 ||
      new Set(oracle.cases.map(row => row.case_id)).size !== 12 ||
      ["concept", "situation"].some(kind => qualificationCorpus.cases.filter(row => row.kind === kind).length !== 6))
    throw new Error("fresh core case coverage changed");
  for (const item of qualificationCorpus.cases) {
    const rule = oracle.cases.find(row => row.case_id === item.id);
    if (!rule || (item.family === "abstention") !== (rule.expectation === "abstain")) throw new Error("fresh core oracle mismatch");
    const spans = [rule.structural_requirements?.label_span, rule.time_witness,
      ...(rule.details ?? []).flatMap(row => [row.evidence_span, row.perspective.evidence_span])];
    for (const span of spans) if (span !== undefined && span !== null) {
      const record = item.records.find(row => row.id === span.record);
      if (!record || !Number.isSafeInteger(span.start_utf16) || !Number.isSafeInteger(span.end_utf16) || span.start_utf16 < 0 ||
          span.end_utf16 <= span.start_utf16 || record.text.slice(span.start_utf16, span.end_utf16) !== span.quote)
        throw new Error("fresh core witness mismatch");
    }
  }
}

/** Cumulative checks only: exact tuple scoring stays authoritative and unchanged. */
export function scoreSupplementalCase(item: QualificationCase, observed: Observation) {
  const rule = oracle.cases.find(row => row.case_id === item.id);
  if (!rule) throw new Error("unknown fresh core case");
  const tuple = scoreCase(item, observed);
  const gates = { tuple: [...tuple.errors], anchors: [] as string[], substance: [] as string[], attribution: [] as string[], time: [] as string[], usage: tuple.errors.filter(error => ["unmeasured_usage", "invalid_usage", "output_budget_exceeded"].includes(error)) };
  const response = observed.response;
  if (observed.case_id !== item.id || observed.input.events.length !== item.records.length || item.records.some((record, index) =>
    observed.input.events[index]?.text !== record.text || observed.input.events[index]?.event_id !== String(index + 1).padStart(26, "0"))) gates.anchors.push("source_mismatch");
  const covers = (anchors: readonly TextAnchor[], witness: Witness) => {
    const index = item.records.findIndex(row => row.id === witness.record), event = observed.input.events[index];
    return event !== undefined && anchors.some(anchor => anchor.event_id === event.event_id &&
      anchor.start_utf16 <= witness.start_utf16 && anchor.end_utf16 >= witness.end_utf16);
  };
  if (response !== null && observed.status === "ok" && !tuple.errors.includes("invalid_typed_response")) {
    const meanings = responseMeanings(item, response);
    if (rule.expectation === "abstain") {
      if (response.claims.length !== 0) gates.substance.push("abstention_requires_zero_claims");
    } else {
      const structural = rule.structural_requirements!;
      for (const predicate of ["world.kind", `${item.kind}.label`]) {
        const indexes = meanings.flatMap((meaning, index) => meaning.subject === rule.target && meaning.predicate === predicate ? [index] : []);
        if (indexes.length !== 1 || !covers(response.claims[indexes[0]!]!.anchors, structural.label_span)) gates.anchors.push(`${predicate}:label_witness`);
      }
      for (const detail of rule.details!) {
        const indexes = meanings.flatMap((meaning, index) => meaning.subject === rule.target && meaning.predicate === detail.predicate &&
          meaning.object.kind === "literal" && detail.acceptable_literal_values.some(value => normalized(value) === meaning.object.value) ? [index] : []);
        if (indexes.length !== 1) { gates.substance.push(`${detail.predicate}:required_detail`); continue; }
        const index = indexes[0]!, claim = response.claims[index]!, meaning = meanings[index]!;
        if (!covers(claim.anchors, detail.evidence_span)) gates.anchors.push(`${detail.predicate}:detail_witness`);
        if (!detail.substantive_atoms_all_required.every(group => group.some(atom => meaning.object.value.toLowerCase().includes(atom.toLowerCase()))))
          gates.substance.push(`${detail.predicate}:substance_atoms`);
        if ((["holder", "speaker", "addressee", "mode", "interpretation"] as const).some(key =>
          meaning[key] !== detail.perspective[key]) ||
          (detail.perspective.evidence_span !== null && !covers(claim.perspective.anchors, detail.perspective.evidence_span)))
          gates.attribution.push(`${detail.predicate}:attribution`);
        if (meaning.valid_from !== iso(detail.valid_from) || meaning.valid_to !== iso(detail.valid_to) || meaning.temporal_basis !== detail.temporal_basis ||
            (rule.time_witness !== undefined && !covers(claim.anchors, rule.time_witness))) gates.time.push(`${detail.predicate}:historical_interval`);
      }
    }
  }
  return { id: item.id, deterministic_passed: Object.values(gates).every(errors => errors.length === 0), gates,
    body_review: { status: "pending" as const, response_sha256: response === null ? null : sha256(canonicalJson(response)),
      forbidden_interpretations: [...(rule.forbidden_interpretations ?? []), ...(rule.forbidden_owner_interpretation ? [rule.forbidden_owner_interpretation] : []),
        ...(rule.details ?? []).flatMap(row => row.forbidden_interpretations)] } };
}

export function scoreSupplementalRun(observations: readonly Observation[]) {
  if (new Set(observations.map(row => row.case_id)).size !== observations.length ||
      observations.some(row => !qualificationCorpus.cases.some(item => item.id === row.case_id))) throw new Error("unknown or duplicate supplemental observation");
  const cases = qualificationCorpus.cases.map(item => {
    const observed = observations.find(row => row.case_id === item.id);
    return observed === undefined ? { id: item.id, deterministic_passed: false, gates: { tuple: ["not_run"] }, body_review: { status: "pending" as const } }
      : scoreSupplementalCase(item, observed);
  });
  return { schema: "kizuki.fresh-core-supplemental/v1" as const, oracle_sha256: freeze.files["semantic-oracle.json"].byte_sha256,
    deterministic_passed: cases.every(row => row.deterministic_passed), body_review: "pending" as const, cases };
}
