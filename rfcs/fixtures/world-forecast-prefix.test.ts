/** Design-only check that forecast inputs freeze before later inspections. */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../..");
const EXAMPLE = join(ROOT, "rfcs/fixtures/world-forecast-prefix-design.json");

type Fixture = {
  id: string;
  evaluation_state: string;
  status: string;
  prediction: {
    frozen_after: string;
    frozen_before: string;
    input_record_refs: string[];
    resolution_question: string;
    resolution_rule: string;
  };
  oracle: {
    prediction_inputs_exclude: string[];
    first_inspection_ref: string;
    first_inspection_meets_criterion: boolean;
    later_success_ref: string;
    later_success_rewrites_first_inspection: boolean;
    absent_resolving_observation_is_success: boolean;
  };
};

function load(): Fixture {
  return JSON.parse(readFileSync(EXAMPLE, "utf8")) as Fixture;
}

function forecastErrors(example: Fixture): string[] {
  const errors: string[] = [];
  if (example.evaluation_state !== "not_run") errors.push("example must remain not_run");
  if (example.status !== "future_unimplemented") errors.push("example must remain unimplemented");
  if (example.id !== "next-inspection-forecast") errors.push("unexpected example id");
  if (example.prediction.frozen_after !== "x_r_provider_ack") errors.push("prediction not frozen after acknowledgement");
  if (example.prediction.frozen_before !== "x_r_wrong_version") errors.push("prediction not frozen before first inspection");
  if (example.prediction.resolution_rule !== "next_independent_inspection") {
    errors.push("resolution rule changed");
  }
  const inputs = new Set(example.prediction.input_record_refs);
  for (const id of example.oracle.prediction_inputs_exclude) {
    if (inputs.has(id)) errors.push(`future record ${id} leaked into prediction inputs`);
  }
  if (inputs.has("x_r_wrong_version") || inputs.has("x_r_correct_version")) {
    errors.push("inspection records present in prediction inputs");
  }
  if (example.oracle.first_inspection_ref !== "x_r_wrong_version") errors.push("first inspection is not v1");
  if (example.oracle.first_inspection_meets_criterion) errors.push("first inspection treated as success");
  if (example.oracle.later_success_rewrites_first_inspection) {
    errors.push("later v2 success rewrote the first inspection result");
  }
  if (example.oracle.absent_resolving_observation_is_success) {
    errors.push("success inferred without a resolving observation");
  }
  return errors;
}

test("prediction inputs freeze before the first independent inspection", () => {
  expect(forecastErrors(load())).toEqual([]);
});

test("future inspections, rewritten rules, or absent-success inferences fail", () => {
  const example = load();
  expect(forecastErrors(example)).toEqual([]);
  expect(
    forecastErrors({
      ...example,
      prediction: {
        ...example.prediction,
        input_record_refs: [...example.prediction.input_record_refs, "x_r_correct_version"],
      },
    }).length,
  ).toBeGreaterThan(0);
  expect(
    forecastErrors({
      ...example,
      prediction: { ...example.prediction, resolution_rule: "latest_available_inspection" },
    }).length,
  ).toBeGreaterThan(0);
  expect(
    forecastErrors({
      ...example,
      oracle: { ...example.oracle, later_success_rewrites_first_inspection: true },
    }).length,
  ).toBeGreaterThan(0);
  expect(
    forecastErrors({
      ...example,
      oracle: { ...example.oracle, absent_resolving_observation_is_success: true },
    }).length,
  ).toBeGreaterThan(0);
});
