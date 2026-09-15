/** Design-only check that a forwarded copy is not independent outcome support. */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../..");
const EXAMPLE = join(ROOT, "rfcs/fixtures/world-outcome-copy-design.json");

type Fixture = {
  id: string;
  evaluation_state: string;
  status: string;
  observation: {
    kind: string;
    independent_root: boolean;
    resolves_outcome: boolean;
    goal_achieved: boolean;
  };
  forwarded_copy: {
    kind: string;
    independent_root: boolean;
    inflates_independent_support: boolean;
    source_ref: string;
  };
  oracle: {
    copy_is_independent: boolean;
    copy_inflates_support: boolean;
    observation_can_resolve: boolean;
    goal_achieved: boolean;
  };
};

function load(): Fixture {
  return JSON.parse(readFileSync(EXAMPLE, "utf8")) as Fixture;
}

function copyErrors(example: Fixture): string[] {
  const errors: string[] = [];
  if (example.evaluation_state !== "not_run") errors.push("example must remain not_run");
  if (example.status !== "future_unimplemented") errors.push("example must remain unimplemented");
  if (example.id !== "forwarded-copy-is-not-independent-support") errors.push("unexpected example id");
  if (example.observation.kind !== "attributable_observation") errors.push("observation kind drifted");
  if (!example.observation.independent_root) errors.push("attributable observation lost independent root");
  if (!example.observation.resolves_outcome) errors.push("attributable observation cannot resolve");
  if (example.observation.goal_achieved) errors.push("observation marked the goal achieved");
  if (example.forwarded_copy.kind !== "forwarded_copy") errors.push("forwarded copy kind drifted");
  if (example.forwarded_copy.independent_root) errors.push("forwarded copy treated as independent root");
  if (example.forwarded_copy.inflates_independent_support) errors.push("forwarded copy inflated support");
  if (example.forwarded_copy.source_ref !== "x_r_observed_artifact") errors.push("copy lost its source");
  if (example.oracle.copy_is_independent) errors.push("oracle treated copy as independent");
  if (example.oracle.copy_inflates_support) errors.push("oracle inflated support from a copy");
  if (!example.oracle.observation_can_resolve) errors.push("oracle dropped attributable resolution");
  if (example.oracle.goal_achieved) errors.push("goal marked achieved");
  return errors;
}

test("a forwarded copy cannot inflate independent support", () => {
  expect(copyErrors(load())).toEqual([]);
});

test("treating a copy as independent support fails", () => {
  const example = load();
  expect(copyErrors(example)).toEqual([]);
  expect(
    copyErrors({
      ...example,
      forwarded_copy: {
        ...example.forwarded_copy,
        independent_root: true,
        inflates_independent_support: true,
      },
      oracle: { ...example.oracle, copy_is_independent: true, copy_inflates_support: true },
    }).length,
  ).toBeGreaterThan(0);
  expect(
    copyErrors({
      ...example,
      observation: { ...example.observation, independent_root: false, resolves_outcome: false },
      oracle: { ...example.oracle, observation_can_resolve: false },
    }).length,
  ).toBeGreaterThan(0);
});
