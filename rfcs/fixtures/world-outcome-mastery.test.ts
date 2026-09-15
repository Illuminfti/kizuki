/** Design-only check that agent-performed work is not user mastery. */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../..");
const EXAMPLE = join(ROOT, "rfcs/fixtures/world-outcome-mastery-design.json");

type Fixture = {
  id: string;
  evaluation_state: string;
  status: string;
  execution: { kind: string; actor: string; user_performed: boolean };
  learning: { asserts_user_mastery: boolean; hides_later_rework: boolean; rework_visible: boolean };
  oracle: {
    user_mastery: boolean;
    rework_hidden: boolean;
    independent_mastery_from_agent: boolean;
  };
};

function load(): Fixture {
  return JSON.parse(readFileSync(EXAMPLE, "utf8")) as Fixture;
}

function masteryErrors(example: Fixture): string[] {
  const errors: string[] = [];
  if (example.evaluation_state !== "not_run") errors.push("example must remain not_run");
  if (example.status !== "future_unimplemented") errors.push("example must remain unimplemented");
  if (example.id !== "assisted-execution-is-not-user-mastery") errors.push("unexpected example id");
  if (example.execution.kind !== "assisted_execution") errors.push("execution kind drifted");
  if (example.execution.actor !== "agent_client") errors.push("actor drifted");
  if (example.execution.user_performed) errors.push("agent work marked user-performed");
  if (example.learning.asserts_user_mastery) errors.push("learning asserted user mastery");
  if (example.learning.hides_later_rework) errors.push("later rework was hidden");
  if (!example.learning.rework_visible) errors.push("rework is not visible");
  if (example.oracle.user_mastery) errors.push("oracle asserted user mastery");
  if (example.oracle.rework_hidden) errors.push("oracle hid rework");
  if (example.oracle.independent_mastery_from_agent) errors.push("oracle inferred mastery from agent work");
  return errors;
}

test("assisted execution does not assert independent user mastery", () => {
  expect(masteryErrors(load())).toEqual([]);
});

test("inferring mastery from agent work or hiding rework fails", () => {
  const example = load();
  expect(masteryErrors(example)).toEqual([]);
  expect(
    masteryErrors({
      ...example,
      execution: { ...example.execution, user_performed: true },
      learning: { asserts_user_mastery: true, hides_later_rework: true, rework_visible: false },
      oracle: { user_mastery: true, rework_hidden: true, independent_mastery_from_agent: true },
    }).length,
  ).toBeGreaterThan(0);
});
