/** Design-only check that purge removes dependent learned state. */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../..");
const EXAMPLE = join(ROOT, "rfcs/fixtures/world-outcome-purge-design.json");

type Fixture = {
  id: string;
  evaluation_state: string;
  status: string;
  learned: { kind: string; support_refs: string[] };
  invalidation: {
    kind: string;
    learned_invalid: boolean;
    retained_context_invalid: boolean;
    resurrects: boolean;
  };
  oracle: {
    learned_survives: boolean;
    context_survives: boolean;
    resurrected: boolean;
  };
};

function load(): Fixture {
  return JSON.parse(readFileSync(EXAMPLE, "utf8")) as Fixture;
}

function purgeErrors(example: Fixture): string[] {
  const errors: string[] = [];
  if (example.evaluation_state !== "not_run") errors.push("example must remain not_run");
  if (example.status !== "future_unimplemented") errors.push("example must remain unimplemented");
  if (example.id !== "purge-invalidates-learned-state") errors.push("unexpected example id");
  if (example.learned.kind !== "learned_procedure") errors.push("learned kind drifted");
  if (!example.learned.support_refs.includes("x_r_observed_artifact")) errors.push("support refs dropped");
  if (example.invalidation.kind !== "purge") errors.push("invalidation kind drifted");
  if (!example.invalidation.learned_invalid) errors.push("learned state survived purge");
  if (!example.invalidation.retained_context_invalid) errors.push("retained context survived purge");
  if (example.invalidation.resurrects) errors.push("purged state resurrected");
  if (example.oracle.learned_survives) errors.push("oracle kept learned state");
  if (example.oracle.context_survives) errors.push("oracle kept retained context");
  if (example.oracle.resurrected) errors.push("oracle resurrected purged state");
  return errors;
}

test("purge invalidates dependent learned state and retained context", () => {
  expect(purgeErrors(load())).toEqual([]);
});

test("surviving or resurrecting purged learned state fails", () => {
  const example = load();
  expect(purgeErrors(example)).toEqual([]);
  expect(
    purgeErrors({
      ...example,
      invalidation: {
        ...example.invalidation,
        learned_invalid: false,
        retained_context_invalid: false,
        resurrects: true,
      },
      oracle: { learned_survives: true, context_survives: true, resurrected: true },
    }).length,
  ).toBeGreaterThan(0);
});
