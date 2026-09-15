/** Design-only check that competing hypotheses stay non-causal until proved. */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../..");
const EXAMPLE = join(ROOT, "rfcs/fixtures/world-forecast-hypothesis-design.json");

type Hypothesis = {
  id: string;
  kind: string;
  plausible: boolean;
  causal: boolean;
};

type Fixture = {
  id: string;
  evaluation_state: string;
  status: string;
  hypotheses: Record<string, Hypothesis>;
  association: {
    kind: string;
    promoted_to_cause: boolean;
    silences_alternative: boolean;
  };
  oracle: {
    coexist: boolean;
    correlation_is_cause: boolean;
    alternative_dropped: boolean;
    current_fact: boolean;
  };
};

function load(): Fixture {
  return JSON.parse(readFileSync(EXAMPLE, "utf8")) as Fixture;
}

function hypothesisErrors(example: Fixture): string[] {
  const errors: string[] = [];
  if (example.evaluation_state !== "not_run") errors.push("example must remain not_run");
  if (example.status !== "future_unimplemented") errors.push("example must remain unimplemented");
  if (example.id !== "correlation-is-not-cause") errors.push("unexpected example id");
  const left = example.hypotheses.h_schedule;
  const right = example.hypotheses.h_tooling;
  if (!left || !right) errors.push("competing hypotheses missing");
  if (left?.kind !== "hypothesis" || right?.kind !== "hypothesis") errors.push("hypothesis kind drifted");
  if (!left?.plausible || !right?.plausible) errors.push("a plausible hypothesis was dropped");
  if (left?.causal || right?.causal) errors.push("hypothesis silently marked causal");
  if (example.association.kind !== "correlation") errors.push("association kind drifted");
  if (example.association.promoted_to_cause) errors.push("correlation promoted to cause");
  if (example.association.silences_alternative) errors.push("correlation silenced the alternative");
  if (!example.oracle.coexist) errors.push("oracle forbids coexistence");
  if (example.oracle.correlation_is_cause) errors.push("oracle treated correlation as cause");
  if (example.oracle.alternative_dropped) errors.push("oracle dropped an alternative");
  if (example.oracle.current_fact) errors.push("oracle published a hypothesis as current fact");
  return errors;
}

test("two plausible hypotheses can coexist without becoming causes", () => {
  expect(hypothesisErrors(load())).toEqual([]);
});

test("promoting a correlation to cause or dropping an alternative fails", () => {
  const example = load();
  expect(hypothesisErrors(example)).toEqual([]);
  expect(
    hypothesisErrors({
      ...example,
      hypotheses: {
        ...example.hypotheses,
        h_schedule: { ...example.hypotheses.h_schedule, causal: true },
      },
      association: { ...example.association, promoted_to_cause: true },
      oracle: { ...example.oracle, correlation_is_cause: true, current_fact: true },
    }).length,
  ).toBeGreaterThan(0);
  expect(
    hypothesisErrors({
      ...example,
      hypotheses: {
        h_schedule: example.hypotheses.h_schedule,
        h_tooling: { ...example.hypotheses.h_tooling, plausible: false },
      },
      association: { ...example.association, silences_alternative: true },
      oracle: { ...example.oracle, coexist: false, alternative_dropped: true },
    }).length,
  ).toBeGreaterThan(0);
});
