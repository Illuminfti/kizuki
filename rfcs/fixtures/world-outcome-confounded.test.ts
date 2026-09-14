/** Design-only check that confounded outcomes are not success or failure. */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../..");
const EXAMPLE = join(ROOT, "rfcs/fixtures/world-outcome-confounded-design.json");

type Fixture = {
  id: string;
  evaluation_state: string;
  status: string;
  report: {
    kind: string;
    independent_root: boolean;
    goal_achieved: boolean;
  };
  observation: {
    class: string;
    unknown: boolean;
    failed: boolean;
    success: boolean;
  };
  oracle: {
    self_report_is_independent_proof: boolean;
    confounded_counts_as_success: boolean;
    confounded_counts_as_failure: boolean;
    unknown_collapsed: boolean;
    goal_achieved: boolean;
  };
};

function load(): Fixture {
  return JSON.parse(readFileSync(EXAMPLE, "utf8")) as Fixture;
}

function confoundedErrors(example: Fixture): string[] {
  const errors: string[] = [];
  if (example.evaluation_state !== "not_run") errors.push("example must remain not_run");
  if (example.status !== "future_unimplemented") errors.push("example must remain unimplemented");
  if (example.id !== "confounded-is-not-success") errors.push("unexpected example id");
  if (example.report.kind !== "self_report") errors.push("agent report kind drifted");
  if (example.report.independent_root) errors.push("self-report treated as independent proof");
  if (example.report.goal_achieved) errors.push("self-report marked the goal achieved");
  if (example.observation.class !== "confounded") errors.push("confounded class dropped");
  if (example.observation.unknown) errors.push("confounded collapsed into unknown");
  if (example.observation.failed) errors.push("confounded collapsed into failed");
  if (example.observation.success) errors.push("confounded collapsed into success");
  if (example.oracle.self_report_is_independent_proof) errors.push("self-report counted as independent proof");
  if (example.oracle.confounded_counts_as_success) errors.push("confounded counted as success");
  if (example.oracle.confounded_counts_as_failure) errors.push("confounded counted as failure");
  if (example.oracle.unknown_collapsed) errors.push("unknown and confounded merged");
  if (example.oracle.goal_achieved) errors.push("goal marked achieved");
  return errors;
}

test("a confounded outcome stays distinct from unknown, failed, and success", () => {
  expect(confoundedErrors(load())).toEqual([]);
});

test("self-report proof or collapsed outcome classes fail", () => {
  const example = load();
  expect(confoundedErrors(example)).toEqual([]);
  expect(
    confoundedErrors({
      ...example,
      report: { ...example.report, independent_root: true, goal_achieved: true },
      oracle: { ...example.oracle, self_report_is_independent_proof: true, goal_achieved: true },
    }).length,
  ).toBeGreaterThan(0);
  expect(
    confoundedErrors({
      ...example,
      observation: { ...example.observation, class: "success", success: true },
      oracle: { ...example.oracle, confounded_counts_as_success: true, goal_achieved: true },
    }).length,
  ).toBeGreaterThan(0);
  expect(
    confoundedErrors({
      ...example,
      observation: { ...example.observation, class: "failed", failed: true, unknown: true },
      oracle: { ...example.oracle, confounded_counts_as_failure: true, unknown_collapsed: true },
    }).length,
  ).toBeGreaterThan(0);
});
