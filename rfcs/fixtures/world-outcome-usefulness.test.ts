/** Design-only check that task outcomes do not inflate truth confidence. */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../..");
const EXAMPLE = join(ROOT, "rfcs/fixtures/world-outcome-usefulness-design.json");

type Task = {
  comparable: boolean;
  result: string;
  truth_confidence_inflated: boolean;
  overrides_owner_correction: boolean;
};

type Fixture = {
  id: string;
  evaluation_state: string;
  status: string;
  tasks: { success: Task; failure: Task };
  oracle: {
    truth_inflated: boolean;
    owner_correction_overridden: boolean;
    usefulness_collapsed_into_truth: boolean;
  };
};

function load(): Fixture {
  return JSON.parse(readFileSync(EXAMPLE, "utf8")) as Fixture;
}

function usefulnessErrors(example: Fixture): string[] {
  const errors: string[] = [];
  if (example.evaluation_state !== "not_run") errors.push("example must remain not_run");
  if (example.status !== "future_unimplemented") errors.push("example must remain unimplemented");
  if (example.id !== "task-outcome-does-not-inflate-truth") errors.push("unexpected example id");
  if (!example.tasks.success.comparable || !example.tasks.failure.comparable) errors.push("comparability dropped");
  if (example.tasks.success.result !== "success") errors.push("success result drifted");
  if (example.tasks.failure.result !== "failed") errors.push("failure result drifted");
  if (example.tasks.success.truth_confidence_inflated || example.tasks.failure.truth_confidence_inflated) {
    errors.push("task outcome inflated truth confidence");
  }
  if (example.tasks.success.overrides_owner_correction || example.tasks.failure.overrides_owner_correction) {
    errors.push("task outcome overrode owner correction");
  }
  if (example.oracle.truth_inflated) errors.push("oracle inflated truth");
  if (example.oracle.owner_correction_overridden) errors.push("oracle overrode owner correction");
  if (example.oracle.usefulness_collapsed_into_truth) errors.push("oracle collapsed usefulness into truth");
  return errors;
}

test("comparable task outcomes do not inflate truth confidence", () => {
  expect(usefulnessErrors(load())).toEqual([]);
});

test("inflating truth or overriding owner correction fails", () => {
  const example = load();
  expect(usefulnessErrors(example)).toEqual([]);
  expect(
    usefulnessErrors({
      ...example,
      tasks: {
        ...example.tasks,
        success: { ...example.tasks.success, truth_confidence_inflated: true, overrides_owner_correction: true },
      },
      oracle: { truth_inflated: true, owner_correction_overridden: true, usefulness_collapsed_into_truth: true },
    }).length,
  ).toBeGreaterThan(0);
});
