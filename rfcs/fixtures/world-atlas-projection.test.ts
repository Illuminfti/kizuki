/** Design-only check that human, developer, and agent Concept projections share semantics. */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../..");
const EXAMPLE = join(ROOT, "rfcs/fixtures/world-atlas-projection-design.json");

type Projection = {
  definition: string;
  attribution: string;
  attributed_is_fact?: boolean;
  evidence_visible?: boolean;
  evidence_refs?: string[];
  uncertainty: string;
  freshness: string;
  status: string;
  omission_exposes_restricted_counts?: boolean;
};

type Fixture = {
  id: string;
  evaluation_state: string;
  status: string;
  concept: {
    definition: string;
    attribution: string;
    attributed_is_fact: boolean;
    evidence_refs: string[];
    uncertainty: string;
    freshness: string;
    summary_available: boolean;
  };
  projections: {
    human: Projection;
    developer: Projection;
    agent: Projection;
  };
};

function load(): Fixture {
  return JSON.parse(readFileSync(EXAMPLE, "utf8")) as Fixture;
}

function atlasErrors(example: Fixture): string[] {
  const errors: string[] = [];
  if (example.evaluation_state !== "not_run") errors.push("example must remain not_run");
  if (example.status !== "future_unimplemented") errors.push("example must remain unimplemented");
  if (example.id !== "shared-concept-card-projection") errors.push("unexpected example id");
  if (example.concept.attributed_is_fact) errors.push("attributed statement treated as fact");
  if (example.concept.summary_available) errors.push("unavailable summary presented as available");
  const { human, developer, agent } = example.projections;
  for (const [name, projection] of Object.entries({ human, developer, agent })) {
    if (projection.definition !== example.concept.definition) errors.push(`${name} dropped definition`);
    if (projection.attribution !== example.concept.attribution) errors.push(`${name} dropped attribution`);
    if (projection.uncertainty !== example.concept.uncertainty) errors.push(`${name} dropped uncertainty`);
    if (projection.freshness !== example.concept.freshness) errors.push(`${name} dropped freshness`);
    if (projection.status === "current") errors.push(`${name} called partial data current`);
  }
  if (human.attributed_is_fact) errors.push("human projection treats attribution as fact");
  if (human.evidence_visible !== true) errors.push("human projection hid evidence");
  if (human.omission_exposes_restricted_counts) errors.push("omission metadata exposed restricted counts");
  if (!developer.evidence_refs || developer.evidence_refs.join(",") !== example.concept.evidence_refs.join(",")) {
    errors.push("developer projection dropped evidence");
  }
  if (!agent.evidence_refs || agent.evidence_refs.join(",") !== example.concept.evidence_refs.join(",")) {
    errors.push("agent projection dropped evidence");
  }
  return errors;
}

test("human, developer, and agent projections keep the same Concept semantics", () => {
  expect(atlasErrors(load())).toEqual([]);
});

test("fact-washing, dropped evidence, current-on-partial, or restricted counts fail", () => {
  const example = load();
  expect(atlasErrors(example)).toEqual([]);
  expect(
    atlasErrors({
      ...example,
      projections: {
        ...example.projections,
        human: { ...example.projections.human, attributed_is_fact: true },
      },
    }).length,
  ).toBeGreaterThan(0);
  expect(
    atlasErrors({
      ...example,
      projections: {
        ...example.projections,
        developer: { ...example.projections.developer, evidence_refs: [] },
      },
    }).length,
  ).toBeGreaterThan(0);
  expect(
    atlasErrors({
      ...example,
      projections: {
        ...example.projections,
        agent: { ...example.projections.agent, status: "current" },
      },
    }).length,
  ).toBeGreaterThan(0);
  expect(
    atlasErrors({
      ...example,
      projections: {
        ...example.projections,
        human: { ...example.projections.human, omission_exposes_restricted_counts: true },
      },
    }).length,
  ).toBeGreaterThan(0);
});
