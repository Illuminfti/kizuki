/** Design-only check that forecast scoring stays proper and honest. */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../..");
const EXAMPLE = join(ROOT, "rfcs/fixtures/world-forecast-scoring-design.json");

type Row = {
  id: string;
  p: number;
  y: number | null;
  resolved: boolean;
  censored: boolean;
};

type Fixture = {
  id: string;
  evaluation_state: string;
  status: string;
  result_class: string;
  scoring: {
    kind: string;
    applicable: boolean;
    not_applicable_reason: string | null;
    false_certainty_threshold: number;
    bins: number[];
  };
  rows: Row[];
  certain_wrong: Row;
  decision: {
    act_if_p_ge: number;
    true_positive: number;
    false_positive: number;
    true_negative: number;
    false_negative: number;
    useful_because_better_score: boolean;
  };
  costs: {
    prediction: number;
    retries: number;
    maintenance: number;
    unknown: { metric: string; reason: string }[];
  };
};

function load(): Fixture {
  return JSON.parse(readFileSync(EXAMPLE, "utf8")) as Fixture;
}

function brier(rows: Row[]): number | null {
  const resolved = rows.filter((row) => row.resolved && row.y !== null);
  if (resolved.length === 0) return null;
  const sum = resolved.reduce((total, row) => total + (row.p - (row.y as number)) ** 2, 0);
  return sum / resolved.length;
}

function validProbability(p: number): boolean {
  return Number.isFinite(p) && p >= 0 && p <= 1;
}

function scoringErrors(example: Fixture): string[] {
  const errors: string[] = [];
  if (example.evaluation_state !== "not_run") errors.push("example must remain not_run");
  if (example.status !== "future_unimplemented") errors.push("example must remain unimplemented");
  if (example.result_class !== "illustrative") errors.push("illustrative numbers promoted to measured results");
  if (example.id !== "binary-forecast-scoring-and-usefulness") errors.push("unexpected example id");
  if (example.scoring.kind !== "binary_brier") errors.push("scoring kind drifted");
  if (!example.scoring.applicable) errors.push("probabilistic sample marked not applicable");
  if (example.rows.some((row) => !validProbability(row.p)) || !validProbability(example.certain_wrong.p)) {
    errors.push("invalid probabilities");
  }
  const ids = example.rows.map((row) => row.id);
  if (ids.join() !== "wrong_confident,resolved_low,unresolved,censored") errors.push("required scoring rows drifted");
  const unresolved = example.rows.filter((row) => !row.resolved);
  if (unresolved.length !== 2) errors.push("omitted unresolved cases");
  if (example.rows.some((row) => row.resolved && row.y === null)) errors.push("resolved row missing an outcome");
  const score = brier(example.rows);
  if (score === null || Math.abs(score - 0.34) > 1e-10) errors.push("resolved Brier is not 0.34");
  const withoutOpen = brier(example.rows.filter((row) => row.resolved));
  if (withoutOpen === null || Math.abs(withoutOpen - score) > 1e-12) {
    errors.push("unresolved rows changed the resolved-only score");
  }
  const certainLoss = (example.certain_wrong.p - (example.certain_wrong.y as number)) ** 2;
  if (certainLoss !== 1) errors.push("certain wrong prediction did not contribute loss 1");
  const threshold = example.scoring.false_certainty_threshold;
  const falseCertainty = [...example.rows, example.certain_wrong].filter(
    (row) => row.resolved && row.y === 0 && row.p >= threshold,
  );
  if (falseCertainty.map((row) => row.id).join() !== "certain_wrong") errors.push("false-certainty count was not recomputed");
  if (example.decision.useful_because_better_score) errors.push("better score automatically became more useful");
  if (example.costs.retries < 1 || example.costs.maintenance < 1) errors.push("omitted retry or maintenance costs");
  if (example.costs.unknown.length === 0) errors.push("missing measurements recorded as zero");
  return errors;
}

test("resolved Brier stays 0.34 when unresolved cases only add cost", () => {
  expect(scoringErrors(load())).toEqual([]);
  expect(brier(load().rows)).toBeCloseTo(0.34, 10);
});

test("all-unresolved and non-probabilistic samples have no zero loss", () => {
  const example = load();
  const unresolvedOnly: Fixture = {
    ...example,
    rows: example.rows.map((row) => ({ ...row, resolved: false, y: null })),
  };
  expect(brier(unresolvedOnly.rows)).toBeNull();
  expect(
    scoringErrors({
      ...unresolvedOnly,
      scoring: { ...example.scoring, applicable: false, not_applicable_reason: "not_probabilistic" },
    }).length,
  ).toBeGreaterThan(0);
});

test("prefix leakage, omitted unresolved rows, or score-as-usefulness fail", () => {
  const example = load();
  expect(
    scoringErrors({
      ...example,
      rows: example.rows.filter((row) => row.resolved),
      decision: { ...example.decision, useful_because_better_score: true },
      certain_wrong: { ...example.certain_wrong, p: 1.2 },
      costs: { ...example.costs, retries: 0, maintenance: 0, unknown: [] },
    }).length,
  ).toBeGreaterThan(0);
});
