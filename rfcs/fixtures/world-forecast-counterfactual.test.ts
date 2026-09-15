/** Design-only check that counterfactuals stay out of current world state. */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../..");
const EXAMPLE = join(ROOT, "rfcs/fixtures/world-forecast-counterfactual-design.json");

type Fixture = {
  id: string;
  evaluation_state: string;
  status: string;
  current: { view: string; includes_counterfactual: boolean };
  counterfactual: {
    kind: string;
    isolated: boolean;
    leaks_into_current_retrieval: boolean;
    leaks_into_consolidation: boolean;
    becomes_current_fact: boolean;
  };
  oracle: {
    current_contains_counterfactual: boolean;
    counterfactual_is_fact: boolean;
    retrieval_leaked: boolean;
    consolidation_leaked: boolean;
  };
};

function load(): Fixture {
  return JSON.parse(readFileSync(EXAMPLE, "utf8")) as Fixture;
}

function counterfactualErrors(example: Fixture): string[] {
  const errors: string[] = [];
  if (example.evaluation_state !== "not_run") errors.push("example must remain not_run");
  if (example.status !== "future_unimplemented") errors.push("example must remain unimplemented");
  if (example.id !== "counterfactual-is-not-current-world") errors.push("unexpected example id");
  if (example.current.view !== "current") errors.push("current view dropped");
  if (example.current.includes_counterfactual) errors.push("current view includes a counterfactual");
  if (example.counterfactual.kind !== "derived_analysis") errors.push("counterfactual kind drifted");
  if (!example.counterfactual.isolated) errors.push("counterfactual is not isolated");
  if (example.counterfactual.leaks_into_current_retrieval) errors.push("counterfactual leaked into retrieval");
  if (example.counterfactual.leaks_into_consolidation) errors.push("counterfactual leaked into consolidation");
  if (example.counterfactual.becomes_current_fact) errors.push("counterfactual became current fact");
  if (example.oracle.current_contains_counterfactual) errors.push("oracle mixed counterfactual into current");
  if (example.oracle.counterfactual_is_fact) errors.push("oracle treated analysis as fact");
  if (example.oracle.retrieval_leaked) errors.push("oracle retrieval leaked");
  if (example.oracle.consolidation_leaked) errors.push("oracle consolidation leaked");
  return errors;
}

test("a counterfactual world state is not current fact", () => {
  expect(counterfactualErrors(load())).toEqual([]);
});

test("leakage into current retrieval, consolidation, or fact fails", () => {
  const example = load();
  expect(counterfactualErrors(example)).toEqual([]);
  expect(
    counterfactualErrors({
      ...example,
      current: { ...example.current, includes_counterfactual: true },
      counterfactual: { ...example.counterfactual, isolated: false, becomes_current_fact: true },
      oracle: { ...example.oracle, current_contains_counterfactual: true, counterfactual_is_fact: true },
    }).length,
  ).toBeGreaterThan(0);
  expect(
    counterfactualErrors({
      ...example,
      counterfactual: {
        ...example.counterfactual,
        leaks_into_current_retrieval: true,
        leaks_into_consolidation: true,
      },
      oracle: { ...example.oracle, retrieval_leaked: true, consolidation_leaked: true },
    }).length,
  ).toBeGreaterThan(0);
});
