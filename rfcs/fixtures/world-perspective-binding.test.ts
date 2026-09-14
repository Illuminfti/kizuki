/** Design-only check that C1 deadline perspectives stay with their speakers. */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../..");
const EXAMPLE = join(ROOT, "rfcs/fixtures/world-perspective-binding-design.json");

type Perspective = {
  id: string;
  holder_ref: string;
  speaker_ref: string;
  evidence_ref: string;
  deadline: string;
  confirmed: boolean;
  about_commitment?: string;
};

type Fixture = {
  id: string;
  evaluation_state: string;
  status: string;
  perspectives: Perspective[];
  oracle: {
    agreed_deadline: string | null;
    c2_affected: boolean;
    later_correction_in_old_knowledge: boolean;
  };
};

function load(): Fixture {
  return JSON.parse(readFileSync(EXAMPLE, "utf8")) as Fixture;
}

function row(example: Fixture, id: string): Perspective {
  const found = example.perspectives.find((item) => item.id === id);
  if (found === undefined) throw new Error(`missing ${id}`);
  return found;
}

function perspectiveErrors(example: Fixture): string[] {
  const errors: string[] = [];
  if (example.evaluation_state !== "not_run") errors.push("example must remain not_run");
  if (example.status !== "future_unimplemented") errors.push("example must remain unimplemented");
  if (example.id !== "c1-deadline-perspectives") errors.push("unexpected example id");
  const ada = row(example, "ada_c1_deadline");
  const ben = row(example, "ben_unconfirmed_c1");
  if (ada.speaker_ref !== "base:actor_ada" || ada.holder_ref !== "base:actor_ada") {
    errors.push("Ada's statement left Ada");
  }
  if (ada.evidence_ref !== "x_r_goal_c1") errors.push("Ada's deadline left its evidence");
  if (ben.speaker_ref !== "base:actor_ben" || ben.holder_ref !== "base:actor_ben") {
    errors.push("Ben's understanding treated as Ada's assertion");
  }
  if (ben.evidence_ref !== "x_r_deadline_conflict") errors.push("Ben's understanding left its evidence");
  if (ben.confirmed) errors.push("Ben's unconfirmed understanding marked confirmed");
  if (example.oracle.agreed_deadline !== null) errors.push("agreed deadline invented");
  if (example.oracle.c2_affected) errors.push("C2 affected by C1 perspective binding");
  if (example.oracle.later_correction_in_old_knowledge) {
    errors.push("later correction used at earlier known_at");
  }
  return errors;
}

test("C1 deadline perspectives stay with their speakers and evidence", () => {
  expect(perspectiveErrors(load())).toEqual([]);
});

test("swapped holders, invented agreement, or backdated correction fail", () => {
  const example = load();
  expect(perspectiveErrors(example)).toEqual([]);
  const ada = row(example, "ada_c1_deadline");
  const ben = row(example, "ben_unconfirmed_c1");
  expect(
    perspectiveErrors({
      ...example,
      perspectives: [
        { ...ada, speaker_ref: ben.speaker_ref, holder_ref: ben.holder_ref },
        { ...ben, speaker_ref: ada.speaker_ref, holder_ref: ada.holder_ref },
      ],
    }).length,
  ).toBeGreaterThan(0);
  expect(
    perspectiveErrors({
      ...example,
      perspectives: [{ ...ada }, { ...ben, speaker_ref: ada.speaker_ref, holder_ref: ada.holder_ref }],
    }).length,
  ).toBeGreaterThan(0);
  expect(
    perspectiveErrors({
      ...example,
      oracle: { ...example.oracle, agreed_deadline: "2025-01-10T17:00:00Z" },
    }).length,
  ).toBeGreaterThan(0);
  expect(
    perspectiveErrors({
      ...example,
      oracle: { ...example.oracle, later_correction_in_old_knowledge: true },
    }).length,
  ).toBeGreaterThan(0);
});
