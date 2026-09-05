import { createHash } from "node:crypto";
import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import {
  EXTRACTION_SYSTEM_PROMPT, parseExtractResponse, predicateIds,
} from "../packages/core/src/index";
import type { ClaimDraft, SubjectRef } from "../packages/core/src/index";

export const SCORER_VERSION = "extraction-quality-v1";
const MAX_FILE_BYTES = 1_048_576;
const CASE_IDS = Array.from({ length: 12 }, (_, index) => `q${String(index + 1).padStart(2, "0")}`);
const STATUSES = ["ok", "unavailable", "rejected", "denied", "refusal"] as const;
type ResponseStatus = typeof STATUSES[number];
type Label = "public" | "personal" | "private";
const LABELS: readonly Label[] = ["public", "personal", "private"];

export interface QualityRecord {
  id: string;
  text: string;
  occurred_at: string;
  observed_at: string;
  subjects: SubjectRef[];
}

export interface ExpectedClaim {
  id: string;
  kind: ClaimDraft["kind"];
  subject: string;
  predicate: string;
  objects: string[];
  polarity: ClaimDraft["polarity"];
  valid_from: string | null;
  valid_to: string | null;
  bodies: string[];
  citation_sets: string[][];
  minimum_sensitivity: Label;
}

export interface QualityCase {
  id: string;
  slice: string;
  records: QualityRecord[];
  expected: ExpectedClaim[];
  retrieval_query: string;
}

export interface QualityCorpus {
  schema: "kizuki.extraction-quality-corpus/v1";
  id: "synthetic-12-v1";
  synthetic: true;
  annotation_method: "authored_reference_with_finite_paraphrases";
  cases: QualityCase[];
}

export interface QualityResponse {
  case_id: string;
  status: ResponseStatus;
  /** Raw extractor object or text. A malformed candidate is scored, not repaired. */
  response: unknown;
  usage: { calls: number; input_tokens: number | null; output_tokens: number | null };
  dropped?: number;
}

export interface QualityResponseSet {
  schema: "kizuki.extraction-quality-responses/v1";
  mode: "scripted_contract";
  corpus_sha256: string;
  model_reference: string;
  responses: QualityResponse[];
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const result = JSON.stringify(value);
    if (result === undefined) throw new Error("unsupported JSON value");
    return result;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
}

export function corpusDigest(corpus: QualityCorpus): string {
  return sha256(canonicalJson(corpus));
}

function requireValue(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}

function object(value: unknown, keys: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  requireValue(value !== null && typeof value === "object" && !Array.isArray(value), "expected an object");
  const result = value as Record<string, unknown>;
  requireValue(keys.every((key) => Object.hasOwn(result, key)) && Object.keys(result).every((key) => keys.includes(key) || optional.includes(key)), "unexpected or missing keys");
  return result;
}

function list(value: unknown, min: number, max: number): unknown[] {
  requireValue(Array.isArray(value) && value.length >= min && value.length <= max, "invalid list size");
  return value;
}

function string(value: unknown, max = 256): string {
  requireValue(typeof value === "string" && value.length > 0 && value.length <= max, "invalid bounded string");
  return value;
}

function timestamp(value: unknown): string {
  const result = string(value, 24);
  requireValue(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(result) && Number.isFinite(Date.parse(result)) && new Date(result).toISOString() === result, "invalid timestamp");
  return result;
}

function nullableTime(value: unknown): string | null {
  return value === null ? null : timestamp(value);
}

function integer(value: unknown, max: number): number {
  requireValue(typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max, "invalid or exceeded budget");
  return value;
}

function unique(values: readonly string[]): void {
  requireValue(new Set(values).size === values.length, "duplicate identifier or annotation");
}

function subjectId(value: unknown): string {
  const result = string(value);
  requireValue(/^quality:[a-z][a-z0-9_-]{0,63}$/.test(result), "expected a synthetic quality subject");
  return result;
}

export function validateCorpus(value: unknown): QualityCorpus {
  const root = object(value, ["schema", "id", "synthetic", "annotation_method", "cases"]);
  requireValue(root.schema === "kizuki.extraction-quality-corpus/v1" && root.id === "synthetic-12-v1" && root.synthetic === true && root.annotation_method === "authored_reference_with_finite_paraphrases", "unsupported corpus contract");
  const cases = list(root.cases, 12, 12).map((raw): QualityCase => {
    const item = object(raw, ["id", "slice", "records", "expected", "retrieval_query"]);
    const id = string(item.id);
    requireValue(CASE_IDS.includes(id), "unknown corpus case");
    const records = list(item.records, 1, 8).map((rawRecord): QualityRecord => {
      const row = object(rawRecord, ["id", "text", "occurred_at", "observed_at", "subjects"]);
      const recordId = string(row.id, 64);
      requireValue(new RegExp(`^${id}-[a-z]$`).test(recordId), "record is outside its case");
      const subjects = list(row.subjects, 1, 8).map((rawSubject): SubjectRef => {
        const subject = object(rawSubject, ["subject_id", "role"]);
        requireValue(subject.role === "from" || subject.role === "to" || subject.role === "about", "invalid subject role");
        return { subject_id: subjectId(subject.subject_id), role: subject.role };
      });
      unique(subjects.map((subject) => `${subject.subject_id}:${subject.role}`));
      return { id: recordId, text: string(row.text, 4096), occurred_at: timestamp(row.occurred_at), observed_at: timestamp(row.observed_at), subjects };
    });
    unique(records.map((row) => row.id));
    requireValue(records.reduce((sum, row) => sum + row.text.length, 0) <= 24_000, "corpus exceeds producer input budget");
    const expected = list(item.expected, 0, 16).map((rawExpected): ExpectedClaim => {
      const row = object(rawExpected, ["id", "kind", "subject", "predicate", "objects", "polarity", "valid_from", "valid_to", "bodies", "citation_sets", "minimum_sensitivity"]);
      const subject = subjectId(row.subject);
      requireValue(row.kind === "claim", "v1 reference cases require claim kind");
      const predicate = string(row.predicate);
      requireValue(predicateIds().includes(predicate), "reference predicate is unsupported");
      requireValue(row.polarity === "positive" || row.polarity === "negative", "invalid reference polarity");
      requireValue(LABELS.includes(row.minimum_sensitivity as Label), "invalid reference sensitivity");
      const objects = list(row.objects, 1, 8).map((value) => string(value, 400));
      const bodies = list(row.bodies, 1, 8).map((value) => string(value, 1200));
      unique(objects.map(normalize)); unique(bodies.map(normalize));
      const citationSets = list(row.citation_sets, 1, 8).map((rawSet) => {
        const ids = list(rawSet, 1, 8).map((value) => string(value, 64));
        unique(ids);
        requireValue(ids.every((cited) => records.some((record) => record.id === cited && record.subjects.some((who) => who.subject_id === subject))), "reference citation or subject has no evidence");
        return ids;
      });
      unique(citationSets.map((ids) => [...ids].sort().join("\n")));
      const from = nullableTime(row.valid_from), to = nullableTime(row.valid_to);
      requireValue(from === null || to === null || from < to, "invalid reference validity interval");
      return { id: string(row.id), kind: row.kind, subject, predicate, objects, polarity: row.polarity, valid_from: from, valid_to: to, bodies, citation_sets: citationSets, minimum_sensitivity: row.minimum_sensitivity as Label };
    });
    unique(expected.map((row) => row.id));
    return { id, slice: string(item.slice), records, expected, retrieval_query: string(item.retrieval_query, 128) };
  });
  unique(cases.map((row) => row.id));
  requireValue(cases.every((row, index) => row.id === CASE_IDS[index]), "corpus cases must use canonical order");
  return { schema: "kizuki.extraction-quality-corpus/v1", id: "synthetic-12-v1", synthetic: true, annotation_method: "authored_reference_with_finite_paraphrases", cases };
}

export function validateResponseSet(value: unknown, corpus: QualityCorpus): QualityResponseSet {
  const root = object(value, ["schema", "mode", "corpus_sha256", "model_reference", "responses"]);
  requireValue(root.schema === "kizuki.extraction-quality-responses/v1", "unsupported response contract");
  requireValue(root.mode === "scripted_contract", "recorded model provenance is unsupported; v1 accepts scripted contracts only");
  requireValue(root.corpus_sha256 === corpusDigest(corpus), "corpus hash mismatch");
  const responses = list(root.responses, corpus.cases.length, corpus.cases.length).map((raw): QualityResponse => {
    const row = object(raw, ["case_id", "status", "response", "usage"], ["dropped"]);
    const caseId = string(row.case_id);
    requireValue(corpus.cases.some((item) => item.id === caseId), "unknown response case");
    requireValue(STATUSES.includes(row.status as ResponseStatus), "unknown response status");
    requireValue(row.status === "ok" || row.response === null, "non-success must not masquerade as claims");
    requireValue(canonicalJson(row.response).length <= 400_000, "candidate response exceeds budget");
    const usage = object(row.usage, ["calls", "input_tokens", "output_tokens"]);
    return { case_id: caseId, status: row.status as ResponseStatus, response: row.response,
      usage: { calls: integer(usage.calls, 1), input_tokens: usage.input_tokens === null ? null : integer(usage.input_tokens, 200_000), output_tokens: usage.output_tokens === null ? null : integer(usage.output_tokens, 8192) },
      ...(row.dropped === undefined ? {} : { dropped: integer(row.dropped, 64) }) };
  });
  unique(responses.map((row) => row.case_id));
  return { schema: "kizuki.extraction-quality-responses/v1", mode: "scripted_contract", corpus_sha256: corpusDigest(corpus), model_reference: string(root.model_reference), responses };
}

export function readBoundedJson(path: string): unknown {
  const stat = lstatSync(path);
  requireValue(stat.isFile() && stat.size > 0 && stat.size <= MAX_FILE_BYTES, "expected a bounded regular JSON file");
  const bytes = readFileSync(path);
  requireValue(bytes.length <= MAX_FILE_BYTES, "JSON file grew beyond its budget");
  return JSON.parse(bytes.toString("utf8")) as unknown;
}

export function loadCorpus(path: string): QualityCorpus {
  return validateCorpus(readBoundedJson(path));
}

export function loadResponseSet(path: string, corpus: QualityCorpus): QualityResponseSet {
  return validateResponseSet(readBoundedJson(path), corpus);
}

function normalize(value: string): string { return value.normalize("NFC").trim().replace(/\s+/gu, " "); }
function sameSet(a: readonly string[], b: readonly string[]): boolean { return a.length === b.length && [...a].sort().every((value, index) => value === [...b].sort()[index]); }
function cites(expected: ExpectedClaim, draft: ClaimDraft): boolean { return expected.citation_sets.some((set) => sameSet(set, draft.event_ids)); }
function tupleMatches(expected: ExpectedClaim, draft: ClaimDraft): boolean {
  return expected.kind === draft.kind && expected.subject === draft.subject && expected.predicate === draft.predicate &&
    expected.objects.some((value) => normalize(value) === normalize(draft.object)) && expected.polarity === draft.polarity &&
    expected.valid_from === draft.valid_from && expected.valid_to === draft.valid_to && cites(expected, draft);
}

function fraction(numerator: number, denominator: number) {
  return { numerator, denominator, value: denominator === 0 ? null : numerator / denominator };
}

export function scoreExtraction(corpusInput: QualityCorpus, responseInput: QualityResponseSet) {
  const corpus = validateCorpus(corpusInput), responses = validateResponseSet(responseInput, corpus);
  const cases = corpus.cases.map((item) => {
    const observed = responses.responses.find((row) => row.case_id === item.id)!;
    const failures = new Set<string>();
    const parsed = observed.status === "ok" ? parseExtractResponse(typeof observed.response === "string" ? observed.response : canonicalJson(observed.response)) : null;
    if (observed.status !== "ok") failures.add(observed.status);
    if (parsed?.ok === false) failures.add("schema_invalid");
    if ((observed.dropped ?? 0) > 0) failures.add("dropped_drafts");
    const drafts = parsed?.ok === true ? parsed.claims : [];
    const matched = new Set<string>();
    let falsePositive = 0, bodyUnscored = 0, underLabels = 0;
    for (const draft of drafts) {
      const expected = item.expected.find((row) => !matched.has(row.id) && tupleMatches(row, draft));
      if (expected === undefined) {
        falsePositive += 1;
        failures.add("unsupported_tuple");
        const sameObject = item.expected.find((row) => row.predicate === draft.predicate && row.objects.some((object) => normalize(object) === normalize(draft.object)));
        if (sameObject !== undefined) {
          if (sameObject.subject !== draft.subject) failures.add("subject_support");
          if (sameObject.polarity !== draft.polarity) failures.add("polarity");
          if (sameObject.valid_from !== draft.valid_from || sameObject.valid_to !== draft.valid_to) failures.add("temporal_support");
          if (!cites(sameObject, draft)) failures.add("citation_support");
        }
        if (!draft.event_ids.every((id) => item.records.some((record) => record.id === id))) failures.add("citation_support");
      } else {
        matched.add(expected.id);
        if (!expected.bodies.some((body) => normalize(body) === normalize(draft.body))) {
          bodyUnscored += 1; failures.add("unscored_requires_annotation");
        }
      }
      const floor = expected?.minimum_sensitivity ?? "private";
      if (LABELS.indexOf(draft.sensitivity) < LABELS.indexOf(floor)) { underLabels += 1; failures.add("sensitivity_under_label"); }
    }
    const falseNegative = item.expected.length - matched.size;
    if (falseNegative > 0) failures.add("missing_required_tuple");
    const abstained = observed.status === "ok" && parsed?.ok === true && drafts.length === 0 && (observed.dropped ?? 0) === 0;
    const expectedAbstention = item.expected.length === 0;
    if (expectedAbstention && !abstained) failures.add("missed_abstention");
    return { case_id: item.id, slice: item.slice, status: observed.status, schema_valid: parsed === null ? null : parsed.ok,
      true_positive: matched.size, false_positive: falsePositive, false_negative: falseNegative, body_unscored: bodyUnscored,
      sensitivity_under_labels: underLabels, abstained, expected_abstention: expectedAbstention, failures: [...failures].sort() };
  });
  const total = (key: "true_positive" | "false_positive" | "false_negative" | "body_unscored" | "sensitivity_under_labels") => cases.reduce((sum, row) => sum + row[key], 0);
  const truePositive = total("true_positive");
  const correctAbstentions = cases.filter((row) => row.abstained && row.expected_abstention).length;
  const statusCounts = Object.fromEntries(STATUSES.map((status) => [status, cases.filter((row) => row.status === status).length]));
  const sumUsage = (key: "input_tokens" | "output_tokens"): number | null => responses.responses.some((row) => row.usage[key] === null) ? null : responses.responses.reduce((sum, row) => sum + row.usage[key]!, 0);
  const complete = total("body_unscored") === 0;
  return {
    schema: "kizuki.extraction-quality-score/v1", scorer_version: SCORER_VERSION, mode: responses.mode,
    qualification: "scripted_fixture_only", model_quality_claim: false,
    corpus_sha256: corpusDigest(corpus), response_set_sha256: sha256(canonicalJson(responses)),
    prompt_sha256: sha256(EXTRACTION_SYSTEM_PROMPT), scorer_sha256: sha256(readFileSync(import.meta.filename)),
    model_reference: responses.model_reference, complete, passed: complete && cases.every((row) => row.failures.length === 0),
    metrics: {
      tuple_precision: fraction(truePositive, truePositive + total("false_positive")),
      tuple_recall: fraction(truePositive, truePositive + total("false_negative")),
      schema_valid: fraction(cases.filter((row) => row.schema_valid === true).length, cases.filter((row) => row.schema_valid !== null).length),
      abstention_precision: fraction(correctAbstentions, cases.filter((row) => row.abstained).length),
      abstention_recall: fraction(correctAbstentions, cases.filter((row) => row.expected_abstention).length),
      sensitivity_under_labels: total("sensitivity_under_labels"), unscored_bodies: total("body_unscored"),
    },
    usage: { provenance: "scripted_transport_metadata", calls: responses.responses.reduce((sum, row) => sum + row.usage.calls, 0),
      input_tokens: sumUsage("input_tokens"), output_tokens: sumUsage("output_tokens"),
      unknown_usage_cases: responses.responses.filter((row) => row.usage.input_tokens === null || row.usage.output_tokens === null).length },
    status_counts: statusCounts, cases,
  };
}

export function writeQualityReport(path: string, report: unknown): void {
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 });
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    requireValue(args.length === 6 && args[0] === "--corpus" && args[2] === "--responses" && args[4] === "--out", "usage: evaluate-extraction --corpus FILE --responses FILE --out NEW_FILE");
    const corpus = loadCorpus(args[1]!);
    const result = scoreExtraction(corpus, loadResponseSet(args[3]!, corpus));
    writeQualityReport(args[5]!, result);
    console.log(result.passed ? "scripted fixture score passed" : "scripted fixture score failed");
    process.exitCode = result.passed ? 0 : 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : "evaluation failed");
    process.exitCode = 2;
  }
}
