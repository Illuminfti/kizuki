/** Design-only resource report. Counts are recomputed from records; unrun measurements stay null. */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../..");
const EXAMPLE = join(ROOT, "rfcs/fixtures/world-consolidation-resources-design.json");

type Job = { id: string; arrived_at: string; completed: boolean; deferred: boolean };

type Fixture = {
  id: string;
  evaluation_state: string;
  status: string;
  result_class: string;
  window: { start: string; end: string; unit: string };
  corpus: {
    logical_records: number;
    candidate_cap: number;
    examined: number;
    comparisons: number;
    admitted: number;
    overflow: number;
  };
  jobs: Job[];
  backlog: {
    arrivals: number;
    completed: number;
    coalesced: number;
    deferred: number;
    remaining: number;
    oldest_age_ms: number;
  };
  lag: {
    capture_latency_ms: number;
    ingest_start: string;
    ingest_end: string;
    illustrative_ingest_lag_ms: number;
    measured_ingest_lag_ms: number | null;
    measured_reason: string;
  };
  p95: {
    population: string;
    percentile: number;
    rule: string;
    sample_size: number;
    measured_ms: number | null;
    unavailable_reason: string;
  };
  memory: {
    method: string;
    scope: string;
    excludes_fixture_validator: boolean;
    measured_bytes: number | null;
    unavailable_reason: string;
  };
  model: {
    attempts: number;
    retries: number;
    failures: number;
    unknown_consumption: number;
    unknown_charged_as_zero: boolean;
    total: number;
  };
};

function load(): Fixture {
  return JSON.parse(readFileSync(EXAMPLE, "utf8")) as Fixture;
}

function ms(value: string): number {
  return Date.parse(value);
}

function resourceErrors(example: Fixture): string[] {
  const errors: string[] = [];
  if (example.evaluation_state !== "not_run") errors.push("example must remain not_run");
  if (example.status !== "future_unimplemented") errors.push("example must remain unimplemented");
  if (example.result_class !== "illustrative") errors.push("illustrative arithmetic was promoted to a measured result");
  if (example.id !== "large-corpus-bounded-work-and-unrun-measurements") errors.push("unexpected example id");
  if (example.window.unit !== "ms") errors.push("lag unit drifted");

  const corpus = example.corpus;
  if (corpus.examined > corpus.candidate_cap) errors.push("candidates exceeded the cap");
  if (corpus.logical_records > corpus.candidate_cap && corpus.examined === corpus.logical_records) {
    errors.push("bounded result after an unbounded scan");
  }
  if (corpus.admitted > corpus.examined) errors.push("admitted more candidates than were examined");
  if (corpus.overflow !== corpus.examined - corpus.admitted) errors.push("overflow is not retained examined work");
  if (!(corpus.comparisons >= corpus.examined)) errors.push("comparisons missing for examined candidates");

  const backlog = example.backlog;
  if (backlog.remaining !== backlog.arrivals - backlog.completed - backlog.coalesced) {
    errors.push("backlog disappeared without accounting");
  }
  if (backlog.deferred !== backlog.remaining) errors.push("deferred work is not the remaining backlog");
  if (backlog.remaining !== corpus.overflow) errors.push("overflow was not retained as pending work");

  const older = example.jobs.find((job) => job.id === "older");
  const newer = example.jobs.find((job) => job.id === "newer");
  if (!older || !newer) errors.push("older and newer jobs are required");
  else {
    if (ms(newer.arrived_at) <= ms(older.arrived_at)) errors.push("newer job did not arrive after the older job");
    if (!older.completed || older.deferred) errors.push("older job did not progress");
    if (newer.completed && !older.completed) errors.push("newer arrivals starved the older job");
    if (!newer.deferred || newer.completed) errors.push("newer overflow was not deferred");
    if (backlog.oldest_age_ms !== ms(example.window.end) - ms(newer.arrived_at)) {
      errors.push("oldest remaining age is not the deferred newer job");
    }
  }

  const lag = example.lag;
  if (lag.illustrative_ingest_lag_ms !== ms(lag.ingest_end) - ms(lag.ingest_start)) {
    errors.push("illustrative ingest lag does not match the window");
  }
  if (lag.capture_latency_ms === lag.illustrative_ingest_lag_ms) {
    errors.push("capture latency and ingest lag were collapsed");
  }
  if (lag.measured_ingest_lag_ms !== null) errors.push("unrun ingest lag was reported as a measurement");
  if (lag.measured_reason !== "not_run") errors.push("unrun ingest lag lost its reason");

  if (example.p95.sample_size === 0) {
    if (example.p95.measured_ms !== null) errors.push("empty p95 sample fabricated a millisecond value");
    if (example.p95.unavailable_reason !== "empty_sample") errors.push("empty p95 sample lost its reason");
  }
  if (example.p95.percentile !== 95 || example.p95.rule !== "nearest_rank") errors.push("p95 rule drifted");
  if (!example.p95.population.includes("read")) errors.push("p95 population is not a read sample");

  if (!example.memory.excludes_fixture_validator) errors.push("validator memory was counted as product usage");
  if (example.memory.measured_bytes !== null) errors.push("unrun peak memory was reported as a measurement");
  if (example.memory.unavailable_reason !== "not_run") errors.push("unrun peak memory lost its reason");
  if (example.memory.scope !== "consolidation_worker") errors.push("memory scope drifted");

  const model = example.model;
  if (model.total !== model.attempts + model.retries) errors.push("retries excluded from total model usage");
  if (model.failures > model.attempts) errors.push("failures exceeded attempts");
  if (model.unknown_consumption <= 0) errors.push("unknown consumption was omitted");
  if (model.unknown_charged_as_zero) errors.push("unknown consumption charged as zero");
  return errors;
}

test("a large corpus reports bounded work, retained overflow and unrun measurements", () => {
  expect(resourceErrors(load())).toEqual([]);
});

test("unbounded scan, backlog loss, starvation, zeroed p95, omitted retries or measured promotion fail", () => {
  const example = load();
  expect(resourceErrors(example)).toEqual([]);
  expect(
    resourceErrors({
      ...example,
      corpus: { ...example.corpus, examined: example.corpus.logical_records, comparisons: example.corpus.logical_records },
    }).length,
  ).toBeGreaterThan(0);
  expect(
    resourceErrors({
      ...example,
      backlog: { ...example.backlog, remaining: 0, deferred: 0 },
    }).length,
  ).toBeGreaterThan(0);
  expect(
    resourceErrors({
      ...example,
      jobs: example.jobs.map((job) =>
        job.id === "older"
          ? { ...job, completed: false, deferred: true }
          : { ...job, completed: true, deferred: false },
      ),
    }).length,
  ).toBeGreaterThan(0);
  expect(
    resourceErrors({
      ...example,
      p95: { ...example.p95, measured_ms: 0, unavailable_reason: "none" },
    }).length,
  ).toBeGreaterThan(0);
  expect(
    resourceErrors({
      ...example,
      model: { ...example.model, total: example.model.attempts, unknown_charged_as_zero: true },
    }).length,
  ).toBeGreaterThan(0);
  expect(
    resourceErrors({
      ...example,
      status: "implemented",
      evaluation_state: "pass",
      result_class: "measured",
      lag: { ...example.lag, measured_ingest_lag_ms: example.lag.illustrative_ingest_lag_ms },
      memory: { ...example.memory, measured_bytes: 67108864 },
    }).length,
  ).toBeGreaterThan(0);
});
