/** Design-only check that matched later-task evaluation stays honest. */
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../..");
const EXAMPLE = join(ROOT, "rfcs/fixtures/world-outcome-matched-evaluation-design.json");
const BASE = join(ROOT, "rfcs/fixtures/world-longitudinal-design.json");

type Pair = {
  id: string;
  kind: string;
  subsequent_task: boolean;
  learning_task: boolean;
  control_success: boolean;
  treatment_success: boolean;
  resolved: boolean;
  resolution_in_prefix: boolean;
};

type Arm = {
  id: string;
  applies_outcome_usefulness_update: boolean;
  drops_original_outcome_evidence: boolean;
  model_override: string | null;
  prompt_override: string | null;
  grant_override: string | null;
  budget_override: number | null;
  evidence_override: string[] | null;
};

type Shared = {
  raw_evidence_refs: string[];
  grant: string;
  model: string;
  prompt: string;
  seed: number;
  budget_tokens: number;
};

type Fixture = {
  id: string;
  evaluation_state: string;
  status: string;
  result_class: string;
  longitudinal_base: { file: string; sha256: string; role: string };
  arms: { shared: Shared; control: Arm; treatment: Arm };
  pairs: Pair[];
  costs: {
    ingestion: number;
    learning: number;
    maintenance: number;
    retries: number;
    answering: number;
    unknown: { metric: string; reason: string }[];
  };
};

function load(): Fixture {
  return JSON.parse(readFileSync(EXAMPLE, "utf8")) as Fixture;
}

function pairStats(pairs: Pair[]) {
  const resolved = pairs.filter((pair) => pair.resolved);
  const control = resolved.filter((pair) => pair.control_success).length;
  const treatment = resolved.filter((pair) => pair.treatment_success).length;
  return {
    resolved: resolved.length,
    total: pairs.length,
    control,
    treatment,
    net: resolved.length === 0 ? null : (treatment - control) / resolved.length,
  };
}

function matchedErrors(example: Fixture): string[] {
  const errors: string[] = [];
  if (example.evaluation_state !== "not_run") errors.push("example must remain not_run");
  if (example.status !== "future_unimplemented") errors.push("example must remain unimplemented");
  if (example.result_class !== "illustrative") errors.push("illustrative numbers promoted to measured results");
  if (example.id !== "matched-subsequent-task-benefit-and-cost") errors.push("unexpected example id");
  if (example.longitudinal_base.file !== "world-longitudinal-design.json") errors.push("longitudinal base drifted");
  if (example.longitudinal_base.role !== "evaluation_contract_reference") errors.push("base role drifted");
  const baseSha = createHash("sha256").update(readFileSync(BASE)).digest("hex");
  if (example.longitudinal_base.sha256 !== baseSha) errors.push("longitudinal base pin drifted");
  if (example.arms.control.applies_outcome_usefulness_update) errors.push("control applied the usefulness update");
  if (!example.arms.treatment.applies_outcome_usefulness_update) errors.push("treatment dropped the usefulness update");
  if (example.arms.control.drops_original_outcome_evidence || example.arms.treatment.drops_original_outcome_evidence) {
    errors.push("an arm dropped original outcome evidence");
  }
  for (const arm of [example.arms.control, example.arms.treatment]) {
    if (arm.model_override || arm.prompt_override || arm.grant_override || arm.budget_override || arm.evidence_override) {
      errors.push("mutating one arm invalidated the matched comparison");
    }
  }
  const kinds = example.pairs.map((pair) => pair.kind);
  if (kinds.join() !== "benefit,tie,regression,unresolved") errors.push("required pair kinds drifted");
  if (example.pairs.some((pair) => !pair.subsequent_task || pair.learning_task)) {
    errors.push("learning task used as the subsequent task");
  }
  if (example.pairs.some((pair) => pair.resolution_in_prefix)) errors.push("resolution evidence moved into the prediction prefix");
  const stats = pairStats(example.pairs);
  if (stats.resolved !== 3 || stats.total !== 4) errors.push("resolved or total pair count drifted");
  if (stats.control !== 2 || stats.treatment !== 2 || stats.net !== 0) {
    errors.push("learning improved success by dropping the regression");
  }
  const unresolved = example.pairs.find((pair) => pair.kind === "unresolved");
  if (!unresolved || unresolved.resolved) errors.push("unresolved pair left the inventory or entered the denominator");
  const costs = example.costs;
  if (costs.retries < 1) errors.push("costs omitted unsuccessful attempts");
  if (costs.learning < 1) errors.push("costs omitted pre-task learning work");
  if (costs.unknown.some((row) => row.reason.length === 0) || costs.unknown.length === 0) {
    errors.push("missing measurements recorded as zero");
  }
  return errors;
}

test("matched later-task evaluation keeps zero net benefit and unresolved cost", () => {
  expect(matchedErrors(load())).toEqual([]);
});

test("dropping the regression or counting unresolved as success fails", () => {
  const example = load();
  expect(matchedErrors(example)).toEqual([]);
  expect(
    matchedErrors({
      ...example,
      pairs: example.pairs.filter((pair) => pair.kind !== "regression"),
    }).length,
  ).toBeGreaterThan(0);
  expect(
    matchedErrors({
      ...example,
      pairs: example.pairs.map((pair) =>
        pair.kind === "unresolved" ? { ...pair, resolved: true, treatment_success: true } : pair,
      ),
    }).length,
  ).toBeGreaterThan(0);
});

test("unmatched arms, prefix leakage, or measured promotion fail", () => {
  const example = load();
  expect(
    matchedErrors({
      ...example,
      result_class: "measured",
      arms: {
        ...example.arms,
        control: { ...example.arms.control, model_override: "other-model", budget_override: 80 },
      },
    }).length,
  ).toBeGreaterThan(0);
  expect(
    matchedErrors({
      ...example,
      pairs: example.pairs.map((pair) =>
        pair.kind === "benefit" ? { ...pair, resolution_in_prefix: true, learning_task: true } : pair,
      ),
    }).length,
  ).toBeGreaterThan(0);
  expect(
    matchedErrors({
      ...example,
      arms: {
        ...example.arms,
        control: { ...example.arms.control, drops_original_outcome_evidence: true },
      },
      costs: { ...example.costs, retries: 0, learning: 0, unknown: [] },
    }).length,
  ).toBeGreaterThan(0);
});
