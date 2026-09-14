/** Design-only check that four outcome-evidence classes stay distinct. */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../..");
const EXAMPLE = join(ROOT, "rfcs/fixtures/world-outcome-evidence-design.json");

type Prefix = {
  id: string;
  evidence_refs: string[];
  artifact_refs?: string[];
  c1_independent_verification?: string;
  acknowledgement_recorded?: boolean;
  c1_criteria?: string;
  c2_review: string;
  goal_achieved: boolean;
};

type Fixture = {
  id: string;
  evaluation_state: string;
  status: string;
  prefixes: Prefix[];
  history: { pre_success_query_ref: string; later_success_injected: boolean };
};

function load(): Fixture {
  return JSON.parse(readFileSync(EXAMPLE, "utf8")) as Fixture;
}

function prefix(example: Fixture, id: string): Prefix {
  const row = example.prefixes.find((item) => item.id === id);
  if (row === undefined) throw new Error(`missing prefix ${id}`);
  return row;
}

function outcomeErrors(example: Fixture): string[] {
  const errors: string[] = [];
  if (example.evaluation_state !== "not_run") errors.push("example must remain not_run");
  if (example.status !== "future_unimplemented") errors.push("example must remain unimplemented");
  if (example.id !== "four-outcome-evidence-classes") errors.push("unexpected example id");
  const agent = prefix(example, "x_q_agent");
  const ack = prefix(example, "x_q_ack");
  const wrong = prefix(example, "x_q_wrong");
  const correct = prefix(example, "x_q_correct");
  if (agent.c1_independent_verification !== "absent") errors.push("agent report treated as C1 verification");
  if (ack.c1_criteria !== "unverified") errors.push("acknowledgement treated as C1 success");
  if (wrong.c1_criteria !== "not_met") errors.push("wrong-version inspection met C1");
  if (correct.c1_criteria !== "met") errors.push("correct-version inspection lost C1 success");
  if (correct.c2_review !== "pending") errors.push("C2 inferred complete from delivery");
  if (example.prefixes.some((item) => item.goal_achieved)) errors.push("combined goal marked achieved");
  if (wrong.artifact_refs?.includes("x_artifact_v2")) errors.push("later v2 injected into failed inspection");
  if (example.history.later_success_injected) errors.push("later success injected into pre-success history");
  if (!correct.evidence_refs.includes("x_r_wrong_version")) errors.push("later success dropped earlier failure");
  return errors;
}

test("four outcome prefixes keep report, ack, failure, and later success distinct", () => {
  expect(outcomeErrors(load())).toEqual([]);
});

test("acknowledgement-as-success, inferred C2, or rewritten history fail", () => {
  const example = load();
  expect(outcomeErrors(example)).toEqual([]);
  const ack = prefix(example, "x_q_ack");
  const correct = prefix(example, "x_q_correct");
  expect(
    outcomeErrors({
      ...example,
      prefixes: example.prefixes.map((item) =>
        item.id === ack.id ? { ...item, c1_criteria: "met" } : item,
      ),
    }).length,
  ).toBeGreaterThan(0);
  expect(
    outcomeErrors({
      ...example,
      prefixes: example.prefixes.map((item) =>
        item.id === correct.id ? { ...item, c2_review: "complete" } : item,
      ),
    }).length,
  ).toBeGreaterThan(0);
  expect(
    outcomeErrors({
      ...example,
      prefixes: example.prefixes.map((item) =>
        item.id === correct.id ? { ...item, goal_achieved: true } : item,
      ),
    }).length,
  ).toBeGreaterThan(0);
  expect(
    outcomeErrors({
      ...example,
      history: { ...example.history, later_success_injected: true },
    }).length,
  ).toBeGreaterThan(0);
});
