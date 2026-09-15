/** Design-only check that crash, restart, duplicates and narrowing stay exactly-once. */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../..");
const EXAMPLE = join(ROOT, "rfcs/fixtures/world-consolidation-exactly-once-design.json");

type Trace = {
  id: string;
  crash: "before_commit" | "after_commit" | "none";
  duplicate_jobs: number;
  policy_revision_prepared: number;
  policy_revision_commit: number;
  committed_on_crash: number;
  retry_new_effects: number;
  observable_effects: number;
  idempotent_equivalent: boolean;
  admits_old_scope_after_narrowing: boolean;
};

type Fixture = {
  id: string;
  evaluation_state: string;
  status: string;
  traces: Trace[];
  oracle: {
    exactly_once: boolean;
    crash_before_commits: boolean;
    crash_after_retry_duplicates: boolean;
    duplicate_jobs_inflate: boolean;
    narrowing_admits_old_scope: boolean;
  };
};

function load(): Fixture {
  return JSON.parse(readFileSync(EXAMPLE, "utf8")) as Fixture;
}

function traceErrors(trace: Trace): string[] {
  const errors: string[] = [];
  if (trace.observable_effects !== 1) errors.push(`${trace.id}: observable effects are not exactly once`);
  if (!trace.idempotent_equivalent) errors.push(`${trace.id}: lost the documented idempotent equivalent`);
  if (trace.crash === "before_commit") {
    if (trace.committed_on_crash !== 0) errors.push(`${trace.id}: crash before commit still committed`);
    if (trace.retry_new_effects !== 1) errors.push(`${trace.id}: restart after pre-commit crash did not produce the one effect`);
  }
  if (trace.crash === "after_commit") {
    if (trace.committed_on_crash !== 1) errors.push(`${trace.id}: crash after commit lost the committed effect`);
    if (trace.retry_new_effects !== 0) errors.push(`${trace.id}: restart after commit produced a second effect`);
  }
  if (trace.duplicate_jobs > 1 && trace.observable_effects !== 1) {
    errors.push(`${trace.id}: duplicate jobs inflated observable effects`);
  }
  if (trace.policy_revision_commit > trace.policy_revision_prepared && trace.admits_old_scope_after_narrowing) {
    errors.push(`${trace.id}: narrowed policy still admitted the old scope`);
  }
  return errors;
}

function exactlyOnceErrors(example: Fixture): string[] {
  const errors: string[] = [];
  if (example.evaluation_state !== "not_run") errors.push("example must remain not_run");
  if (example.status !== "future_unimplemented") errors.push("example must remain unimplemented");
  if (example.id !== "crash-restart-duplicate-narrowing-exactly-once") errors.push("unexpected example id");
  const ids = example.traces.map((trace) => trace.id);
  if (ids.join() !== "crash_before_commit,crash_after_commit,duplicate_jobs,policy_narrowing") {
    errors.push("required traces drifted");
  }
  const duplicate = example.traces.find((trace) => trace.id === "duplicate_jobs");
  const narrowing = example.traces.find((trace) => trace.id === "policy_narrowing");
  if (!duplicate || duplicate.duplicate_jobs < 2) errors.push("duplicate_jobs lost the extra job");
  if (!narrowing || narrowing.policy_revision_commit <= narrowing.policy_revision_prepared) {
    errors.push("policy_narrowing lost the narrower commit revision");
  }
  for (const trace of example.traces) errors.push(...traceErrors(trace));
  if (!example.oracle.exactly_once) errors.push("oracle dropped exactly-once");
  if (example.oracle.crash_before_commits) errors.push("oracle let a pre-commit crash commit");
  if (example.oracle.crash_after_retry_duplicates) errors.push("oracle let a post-commit retry duplicate");
  if (example.oracle.duplicate_jobs_inflate) errors.push("oracle let duplicate jobs inflate effects");
  if (example.oracle.narrowing_admits_old_scope) errors.push("oracle let narrowing admit the old scope");
  return errors;
}

test("crash, restart, duplicate jobs and policy narrowing stay exactly-once", () => {
  expect(exactlyOnceErrors(load())).toEqual([]);
});

test("pre-commit commit, post-commit duplicate, inflated jobs or old-scope narrowing fail", () => {
  const example = load();
  expect(exactlyOnceErrors(example)).toEqual([]);
  const before = example.traces.find((trace) => trace.id === "crash_before_commit")!;
  const after = example.traces.find((trace) => trace.id === "crash_after_commit")!;
  const duplicate = example.traces.find((trace) => trace.id === "duplicate_jobs")!;
  const narrowing = example.traces.find((trace) => trace.id === "policy_narrowing")!;
  expect(
    exactlyOnceErrors({
      ...example,
      traces: example.traces.map((trace) =>
        trace.id === before.id ? { ...trace, committed_on_crash: 1, observable_effects: 2 } : trace,
      ),
      oracle: { ...example.oracle, crash_before_commits: true, exactly_once: false },
    }).length,
  ).toBeGreaterThan(0);
  expect(
    exactlyOnceErrors({
      ...example,
      traces: example.traces.map((trace) =>
        trace.id === after.id ? { ...trace, retry_new_effects: 1, observable_effects: 2 } : trace,
      ),
      oracle: { ...example.oracle, crash_after_retry_duplicates: true, exactly_once: false },
    }).length,
  ).toBeGreaterThan(0);
  expect(
    exactlyOnceErrors({
      ...example,
      traces: example.traces.map((trace) =>
        trace.id === duplicate.id ? { ...trace, observable_effects: 2, idempotent_equivalent: false } : trace,
      ),
      oracle: { ...example.oracle, duplicate_jobs_inflate: true, exactly_once: false },
    }).length,
  ).toBeGreaterThan(0);
  expect(
    exactlyOnceErrors({
      ...example,
      traces: example.traces.map((trace) =>
        trace.id === narrowing.id ? { ...trace, admits_old_scope_after_narrowing: true } : trace,
      ),
      oracle: { ...example.oracle, narrowing_admits_old_scope: true },
    }).length,
  ).toBeGreaterThan(0);
});
