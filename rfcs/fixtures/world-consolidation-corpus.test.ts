/** Design-only corpus accounting. Counts are folded from records; unrun measurements stay null. */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../..");
const EXAMPLE = join(ROOT, "rfcs/fixtures/world-consolidation-corpus-design.json");

type Corpus = { id: string; logical_records: number; id_prefix: string };
type Candidates = {
  examined: number;
  comparisons: number;
  admitted: number;
  rejected: number;
  overflow: number;
  unexamined_remainder: number | null;
  unexamined_reason: string;
};
type Window = {
  id: string;
  start: string;
  end: string;
  corpus_id: string;
  backlog_start: number;
  arrivals: number;
  coalesced: number;
  completed: number;
  deferred: number;
  remaining: number;
  candidates: Candidates;
};
type Job = { id: string; enqueued_at: string; completed_in: string; age_reset: boolean };
type Attempt = {
  logical_job_id: string;
  attempt_id: string;
  attempt_number: number;
  status: string;
  usage: number | null;
  usage_reason: string | null;
  reservation: string;
};
type Fixture = {
  id: string;
  evaluation_state: string;
  status: string;
  result_class: string;
  corpora: Corpus[];
  caps: { examine: number; compare: number; admit: number };
  windows: Window[];
  jobs: Job[];
  lag: {
    definition: string;
    ingest_lag_start: string;
    ingest_lag_end: string;
    unit: string;
    pending_accepted_at: string[];
    illustrative_ingest_lag_ms: number;
    capture_latency_ms: number;
    measured_ingest_lag_ms: number | null;
    measured_reason: string;
  };
  p95: {
    operation: string;
    rule: string;
    percentile: number;
    illustrative_completed_ms: number[];
    unresolved: number;
    failed: number;
    measured_ms: number | null;
    measured_reason: string;
  };
  memory: {
    method: string;
    metric: string;
    scope: string;
    interval_ms: number;
    excludes_harness: boolean;
    illustrative_samples_bytes: number[];
    measured_bytes: number | null;
    measured_reason: string;
  };
  model: { attempts: Attempt[] };
};

function load(): Fixture {
  return JSON.parse(readFileSync(EXAMPLE, "utf8")) as Fixture;
}

function ms(value: string): number {
  return Date.parse(value);
}

function expand(prefix: string, n: number): string[] {
  if (!Number.isSafeInteger(n) || n <= 0 || n > 10_000) throw new Error("corpus expansion bound");
  const ids = Array.from({ length: n }, (_, index) => `${prefix}_${index + 1}`);
  if (new Set(ids).size !== n) throw new Error("corpus ids are not unique");
  return ids;
}

function nearestRank(samples: number[], percentile: number): number | null {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.ceil((percentile / 100) * sorted.length) - 1] ?? null;
}

function corpusErrors(example: Fixture): string[] {
  const errors: string[] = [];
  if (example.evaluation_state !== "not_run") errors.push("example must remain not_run");
  if (example.status !== "future_unimplemented") errors.push("example must remain unimplemented");
  if (example.result_class !== "illustrative") errors.push("illustrative arithmetic was promoted to a measured result");
  if (example.id !== "large-corpus-bounded-work-and-unrun-measurements") errors.push("unexpected example id");

  const byId = new Map(example.corpora.map((item) => [item.id, item]));
  if (example.corpora.map((item) => item.id).join() !== "small,large") {
    errors.push("small and large corpora are required");
  }
  for (const corpus of example.corpora) {
    const ids = expand(corpus.id_prefix, corpus.logical_records);
    if (ids.length !== corpus.logical_records) errors.push(`${corpus.id}: generated ids drifted`);
  }
  const large = byId.get("large");
  if (large && large.logical_records <= example.caps.examine) errors.push("large corpus is not larger than the examine cap");

  const windowIds = example.windows.map((item) => item.id);
  if (windowIds.join() !== "w1,w2_drain") errors.push("required windows drifted");

  for (const window of example.windows) {
    const remaining = window.backlog_start + window.arrivals - window.coalesced - window.completed;
    if (window.remaining !== remaining) errors.push(`${window.id}: backlog disappeared without accounting`);
    if (window.deferred > window.remaining) errors.push(`${window.id}: deferred work is not a subset of remaining`);
    const work = window.candidates;
    if (work.examined > example.caps.examine) errors.push(`${window.id}: examined past the cap`);
    if (work.comparisons > example.caps.compare) errors.push(`${window.id}: comparisons past the cap`);
    if (work.admitted > example.caps.admit) errors.push(`${window.id}: admitted past the cap`);
    if (work.admitted > work.examined) errors.push(`${window.id}: admitted more than examined`);
    if (work.rejected !== work.examined - work.admitted) errors.push(`${window.id}: rejected candidates were omitted`);
    if (work.overflow !== work.rejected) errors.push(`${window.id}: overflow disappeared`);
    if (work.unexamined_remainder !== null) errors.push(`${window.id}: unexamined remainder was manufactured`);
    if (work.unexamined_reason !== "bounded_window") errors.push(`${window.id}: bounded window lost its reason`);
    if (large && work.examined === large.logical_records && work.comparisons >= large.logical_records) {
      errors.push(`${window.id}: bounded result after an unbounded scan`);
    }
  }

  const w1 = example.windows[0];
  const drain = example.windows[1];
  if (w1 && drain && drain.backlog_start !== w1.remaining) errors.push("drain did not start from remaining work");
  if (drain && drain.remaining !== 0) errors.push("finite drain did not empty remaining work");

  const older = example.jobs.find((job) => job.id === "older");
  const newer = example.jobs.find((job) => job.id === "newer");
  if (!older || !newer) errors.push("older and newer jobs are required");
  else {
    if (ms(newer.enqueued_at) <= ms(older.enqueued_at)) errors.push("newer job did not arrive after the older job");
    if (older.completed_in !== "w1") errors.push("older eligible job did not complete while newer work arrived");
    if (newer.completed_in !== "w2_drain") errors.push("newer job was not drained after the older job");
    if (older.age_reset || newer.age_reset) errors.push("coalescing reset enqueue age");
  }

  const lag = example.lag;
  const oldestPending = Math.min(...lag.pending_accepted_at.map(ms));
  if (lag.unit !== "ms") errors.push("lag unit drifted");
  if (lag.definition !== "oldest_uncovered_ledger_evidence_age_ms") errors.push("lag definition drifted");
  if (lag.illustrative_ingest_lag_ms !== ms(lag.ingest_lag_end) - oldestPending) {
    errors.push("illustrative ingest lag skipped an older uncovered input");
  }
  if (lag.capture_latency_ms === lag.illustrative_ingest_lag_ms) {
    errors.push("capture latency and ingest lag were collapsed");
  }
  if (lag.measured_ingest_lag_ms !== null || lag.measured_reason !== "not_run") {
    errors.push("unrun ingest lag was reported as a measurement");
  }

  const p95 = example.p95;
  if (p95.rule !== "nearest_rank" || p95.percentile !== 95) errors.push("p95 rule drifted");
  if (p95.unresolved <= 0 || p95.failed <= 0) errors.push("unresolved or failed jobs vanished from the p95 population");
  if (nearestRank(p95.illustrative_completed_ms, 95) !== 36) errors.push("illustrative p95 is not nearest-rank");
  if (p95.measured_ms !== null || p95.measured_reason !== "not_run") errors.push("unrun p95 was reported as a measurement");

  const memory = example.memory;
  if (memory.method !== "sampled_process_tree_rss" || memory.metric !== "sampled_peak_rss_bytes") {
    errors.push("memory method drifted");
  }
  if (!memory.excludes_harness || memory.interval_ms <= 0) errors.push("memory scope or interval drifted");
  if (Math.max(...memory.illustrative_samples_bytes) !== 12_000_000) errors.push("illustrative sampled peak drifted");
  if (memory.measured_bytes !== null || memory.measured_reason !== "not_run") {
    errors.push("unrun peak memory was reported as a measurement");
  }

  const attempts = example.model.attempts;
  if (attempts.length !== 3) errors.push("model attempts drifted");
  if (new Set(attempts.map((item) => item.attempt_id)).size !== attempts.length) errors.push("model attempts lost identity");
  if (!attempts.some((item) => item.status === "unknown_consumption" && item.usage === null && item.reservation === "unresolved")) {
    errors.push("unknown consumption was omitted or refunded");
  }
  if (!attempts.some((item) => item.status === "failed" && item.usage !== null)) errors.push("failed usage was omitted");
  if (!attempts.some((item) => item.status === "success" && item.attempt_number > 1)) errors.push("successful retry was omitted");
  const known = attempts.reduce((sum, item) => sum + (item.usage ?? 0), 0);
  if (known !== 18) errors.push("known usage lower bound drifted");
  if (attempts.some((item) => item.usage === null && item.usage_reason !== "unknown")) {
    errors.push("unknown usage lost its reason");
  }
  return errors;
}

test("a large corpus reports bounded work, conserved backlog and unrun measurements", () => {
  expect(corpusErrors(load())).toEqual([]);
});

test("unbounded scan, backlog loss, starvation, zeroed p95, omitted retries or measured promotion fail", () => {
  const example = load();
  expect(corpusErrors(example)).toEqual([]);
  const w1 = example.windows[0]!;
  expect(
    corpusErrors({
      ...example,
      windows: example.windows.map((window) =>
        window.id === "w1"
          ? {
              ...window,
              candidates: {
                ...window.candidates,
                examined: 10000,
                comparisons: 10000,
                unexamined_remainder: 0,
              },
            }
          : window,
      ),
    }).length,
  ).toBeGreaterThan(0);
  expect(
    corpusErrors({
      ...example,
      windows: example.windows.map((window) =>
        window.id === "w1" ? { ...window, remaining: 0, deferred: 0 } : window,
      ),
    }).length,
  ).toBeGreaterThan(0);
  expect(
    corpusErrors({
      ...example,
      jobs: example.jobs.map((job) =>
        job.id === "older" ? { ...job, completed_in: "w2_drain", age_reset: true } : { ...job, completed_in: "w1" },
      ),
    }).length,
  ).toBeGreaterThan(0);
  expect(
    corpusErrors({
      ...example,
      p95: { ...example.p95, measured_ms: 0, unresolved: 0, failed: 0, measured_reason: "none" },
    }).length,
  ).toBeGreaterThan(0);
  expect(
    corpusErrors({
      ...example,
      model: {
        attempts: example.model.attempts.filter((item) => item.status === "success").map((item) => ({
          ...item,
          attempt_number: 1,
          usage: 0,
        })),
      },
    }).length,
  ).toBeGreaterThan(0);
  expect(
    corpusErrors({
      ...example,
      status: "implemented",
      evaluation_state: "pass",
      result_class: "measured",
      lag: { ...example.lag, measured_ingest_lag_ms: example.lag.illustrative_ingest_lag_ms },
      memory: { ...example.memory, measured_bytes: 12_000_000 },
    }).length,
  ).toBeGreaterThan(0);
  expect(w1.candidates.examined).toBe(example.caps.examine);
});
