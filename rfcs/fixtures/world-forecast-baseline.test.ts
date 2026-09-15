/** Design-only check that a cheap deterministic baseline runs first. */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../..");
const EXAMPLE = join(ROOT, "rfcs/fixtures/world-forecast-baseline-design.json");

type Fixture = {
  id: string;
  evaluation_state: string;
  status: string;
  question: { kind: string; deterministic: boolean };
  baseline: { kind: string; evaluated: boolean; adopted_expensive_model: boolean };
  learned_model: { adopted: boolean; compared_to_baseline: boolean; skips_baseline: boolean };
  oracle: {
    baseline_evaluated: boolean;
    expensive_model_first: boolean;
    baseline_skipped: boolean;
  };
};

function load(): Fixture {
  return JSON.parse(readFileSync(EXAMPLE, "utf8")) as Fixture;
}

function baselineErrors(example: Fixture): string[] {
  const errors: string[] = [];
  if (example.evaluation_state !== "not_run") errors.push("example must remain not_run");
  if (example.status !== "future_unimplemented") errors.push("example must remain unimplemented");
  if (example.id !== "deterministic-baseline-before-learned-model") errors.push("unexpected example id");
  if (example.question.kind !== "prerequisite_deadline") errors.push("question kind drifted");
  if (!example.question.deterministic) errors.push("question is not deterministic");
  if (example.baseline.kind !== "deterministic_dependency") errors.push("baseline kind drifted");
  if (!example.baseline.evaluated) errors.push("baseline was not evaluated");
  if (example.baseline.adopted_expensive_model) errors.push("baseline adopted an expensive model");
  if (example.learned_model.adopted) errors.push("learned model adopted before baseline comparison");
  if (!example.learned_model.compared_to_baseline) errors.push("learned model was not compared to baseline");
  if (example.learned_model.skips_baseline) errors.push("learned model skipped the baseline");
  if (!example.oracle.baseline_evaluated) errors.push("oracle skipped the baseline");
  if (example.oracle.expensive_model_first) errors.push("oracle adopted the expensive model first");
  if (example.oracle.baseline_skipped) errors.push("oracle marked the baseline skipped");
  return errors;
}

test("a deterministic dependency baseline is evaluated before a learned model", () => {
  expect(baselineErrors(load())).toEqual([]);
});

test("adopting an expensive model first or skipping the baseline fails", () => {
  const example = load();
  expect(baselineErrors(example)).toEqual([]);
  expect(
    baselineErrors({
      ...example,
      baseline: { ...example.baseline, evaluated: false, adopted_expensive_model: true },
      learned_model: { ...example.learned_model, adopted: true, skips_baseline: true, compared_to_baseline: false },
      oracle: { baseline_evaluated: false, expensive_model_first: true, baseline_skipped: true },
    }).length,
  ).toBeGreaterThan(0);
});
