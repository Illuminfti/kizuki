/** Design-only check that a large corpus reports bounded work and cost. */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../..");
const EXAMPLE = join(ROOT, "rfcs/fixtures/world-consolidation-corpus-design.json");

type UnknownMetric = { metric: string; reason: string };

type Fixture = {
  id: string;
  evaluation_state: string;
  status: string;
  corpus: {
    records: number;
    admitted: number;
    candidate_cap: number;
    candidates_considered: number;
  };
  backlog: { start: number; end: number; converged: boolean };
  lag: { ingest_ms: number; p95_read_ms: number };
  resources: {
    peak_memory_bytes: number;
    model_calls: number;
    retry_calls: number;
    total_model_calls: number;
  };
  unknown: UnknownMetric[];
  oracle: {
    candidates_within_cap: boolean;
    backlog_converged: boolean;
    lag_reported: boolean;
    p95_reported: boolean;
    peak_memory_reported: boolean;
    retries_included_in_model_usage: boolean;
    unknown_priced_as_zero: boolean;
    claims_multiplier: boolean;
  };
};

function load(): Fixture {
  return JSON.parse(readFileSync(EXAMPLE, "utf8")) as Fixture;
}

function corpusErrors(example: Fixture): string[] {
  const errors: string[] = [];
  if (example.evaluation_state !== "not_run") errors.push("example must remain not_run");
  if (example.status !== "future_unimplemented") errors.push("example must remain unimplemented");
  if (example.id !== "large-corpus-reports-bounded-work-and-cost") errors.push("unexpected example id");
  if (example.corpus.candidates_considered > example.corpus.candidate_cap) {
    errors.push("candidates exceeded the cap");
  }
  if (example.corpus.admitted > example.corpus.records) errors.push("admitted more records than the corpus");
  if (!example.backlog.converged || example.backlog.end !== 0) errors.push("backlog did not converge");
  if (!(example.lag.ingest_ms > 0) || !(example.lag.p95_read_ms > 0)) errors.push("lag or p95 missing");
  if (!(example.resources.peak_memory_bytes > 0)) errors.push("peak memory missing");
  if (example.resources.total_model_calls !== example.resources.model_calls + example.resources.retry_calls) {
    errors.push("retries excluded from total model usage");
  }
  if (example.unknown.length === 0) errors.push("missing measurements were not recorded");
  if (example.unknown.some((item) => item.reason.length === 0)) errors.push("unknown metric lost its reason");
  if (!example.oracle.candidates_within_cap) errors.push("oracle dropped the candidate cap");
  if (!example.oracle.backlog_converged) errors.push("oracle dropped backlog convergence");
  if (!example.oracle.lag_reported || !example.oracle.p95_reported) errors.push("oracle dropped lag or p95");
  if (!example.oracle.peak_memory_reported) errors.push("oracle dropped peak memory");
  if (!example.oracle.retries_included_in_model_usage) errors.push("oracle dropped retries from model usage");
  if (example.oracle.unknown_priced_as_zero) errors.push("unknown cost priced as zero");
  if (example.oracle.claims_multiplier) errors.push("oracle claimed a speed or accuracy multiplier");
  return errors;
}

test("a large corpus reports bounded candidates, lag, memory and model usage including retries", () => {
  expect(corpusErrors(load())).toEqual([]);
});

test("uncapped candidates, missing retries, zeroed unknown cost or a claimed multiplier fail", () => {
  const example = load();
  expect(corpusErrors(example)).toEqual([]);
  expect(
    corpusErrors({
      ...example,
      corpus: { ...example.corpus, candidates_considered: example.corpus.candidate_cap + 1 },
      oracle: { ...example.oracle, candidates_within_cap: false },
    }).length,
  ).toBeGreaterThan(0);
  expect(
    corpusErrors({
      ...example,
      resources: { ...example.resources, retry_calls: 2, total_model_calls: example.resources.model_calls },
      oracle: { ...example.oracle, retries_included_in_model_usage: false },
    }).length,
  ).toBeGreaterThan(0);
  expect(
    corpusErrors({
      ...example,
      unknown: [],
      oracle: { ...example.oracle, unknown_priced_as_zero: true },
    }).length,
  ).toBeGreaterThan(0);
  expect(
    corpusErrors({
      ...example,
      oracle: { ...example.oracle, claims_multiplier: true },
    }).length,
  ).toBeGreaterThan(0);
});
