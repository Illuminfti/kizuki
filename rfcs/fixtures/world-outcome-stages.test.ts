/** Design-only check that execution stages stay separate from goal achievement. */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../..");
const EXAMPLE = join(ROOT, "rfcs/fixtures/world-outcome-stages-design.json");

type StageKind = "agent_says_done" | "provider_accepted" | "observed_artifact" | "goal_achieved";

type Stage = {
  kind: StageKind;
  source: string;
  independent_observation: boolean;
  goal_achieved: boolean;
};

type Fixture = {
  id: string;
  evaluation_state: string;
  status: string;
  stages: Record<StageKind, Stage>;
  oracle: {
    self_report_is_goal: boolean;
    provider_ack_is_goal: boolean;
    artifact_is_goal: boolean;
    stages_collapsed: boolean;
  };
};

function load(): Fixture {
  return JSON.parse(readFileSync(EXAMPLE, "utf8")) as Fixture;
}

function stageErrors(example: Fixture): string[] {
  const errors: string[] = [];
  if (example.evaluation_state !== "not_run") errors.push("example must remain not_run");
  if (example.status !== "future_unimplemented") errors.push("example must remain unimplemented");
  if (example.id !== "agent-done-is-not-goal-achieved") errors.push("unexpected example id");
  const expected = ["agent_says_done", "provider_accepted", "observed_artifact", "goal_achieved"] as const;
  if (new Set(Object.values(example.stages).map((stage) => stage.kind)).size !== 4) {
    errors.push("execution stages collapsed");
  }
  for (const kind of expected) {
    if (example.stages[kind]?.kind !== kind) errors.push(`stage kind mismatch: ${kind}`);
  }
  const agent = example.stages.agent_says_done;
  const provider = example.stages.provider_accepted;
  const artifact = example.stages.observed_artifact;
  const goal = example.stages.goal_achieved;
  if (agent.independent_observation || agent.goal_achieved || agent.source !== "self_report") {
    errors.push("agent-says-done treated as observation or goal");
  }
  if (provider.independent_observation || provider.goal_achieved || provider.source !== "provider_ack") {
    errors.push("provider accepted treated as observation or goal");
  }
  if (!artifact.independent_observation || artifact.goal_achieved || artifact.source !== "attributable_observation") {
    errors.push("observed artifact collapsed into goal");
  }
  if (!goal.independent_observation || !goal.goal_achieved || goal.source !== "intended_goal_oracle") {
    errors.push("goal-achieved stage lost its oracle");
  }
  if (example.oracle.self_report_is_goal) errors.push("self-report counted as goal");
  if (example.oracle.provider_ack_is_goal) errors.push("provider ack counted as goal");
  if (example.oracle.artifact_is_goal) errors.push("artifact observation counted as goal");
  if (example.oracle.stages_collapsed) errors.push("oracle collapsed execution stages");
  return errors;
}

test("agent done, provider ack, observed artifact, and goal stay separate", () => {
  expect(stageErrors(load())).toEqual([]);
});

test("promoting an earlier stage to goal fails", () => {
  const example = load();
  expect(stageErrors(example)).toEqual([]);
  expect(
    stageErrors({
      ...example,
      stages: {
        ...example.stages,
        agent_says_done: { ...example.stages.agent_says_done, goal_achieved: true, independent_observation: true },
      },
      oracle: { ...example.oracle, self_report_is_goal: true },
    }).length,
  ).toBeGreaterThan(0);
  expect(
    stageErrors({
      ...example,
      stages: {
        ...example.stages,
        provider_accepted: { ...example.stages.provider_accepted, goal_achieved: true },
      },
      oracle: { ...example.oracle, provider_ack_is_goal: true },
    }).length,
  ).toBeGreaterThan(0);
  expect(
    stageErrors({
      ...example,
      stages: {
        ...example.stages,
        observed_artifact: { ...example.stages.observed_artifact, goal_achieved: true },
      },
      oracle: { ...example.oracle, artifact_is_goal: true },
    }).length,
  ).toBeGreaterThan(0);
});
