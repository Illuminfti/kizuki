/** Design-only check that a stale Cue decision does not cover a changed effect. */
import { expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../..");
const FIXTURES = join(ROOT, "rfcs/fixtures");
const VALIDATOR = join(FIXTURES, "validate-world-design.ts");
const CONCEPT = "world-concept-design.json";
const LONGITUDINAL = "world-longitudinal-design.json";

type Cue = {
  evaluation_state: string;
  commitments: Array<Record<string, unknown>>;
  decision: Record<string, unknown>;
  material_change: Record<string, unknown>;
  oracle: Record<string, unknown>;
};
type Fixture = {
  evaluation_state: string;
  status: string;
  cue_stale_approval: Cue;
};

function validate(dir?: string) {
  const args = dir === undefined ? [process.execPath, VALIDATOR] : [process.execPath, VALIDATOR, dir];
  return Bun.spawnSync(args, { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
}

function mutateLongitudinal(mutate: (fixture: Fixture) => void): number {
  const dir = mkdtempSync(join(tmpdir(), "kizuki-cue-design-"));
  try {
    copyFileSync(join(FIXTURES, CONCEPT), join(dir, CONCEPT));
    const fixture = JSON.parse(readFileSync(join(FIXTURES, LONGITUDINAL), "utf8")) as Fixture;
    mutate(fixture);
    writeFileSync(join(dir, LONGITUDINAL), `${JSON.stringify(fixture)}\n`);
    return validate(dir).exitCode ?? 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("unchanged fixtures keep a stale Cue decision from covering a changed effect", () => {
  const result = validate();
  expect(result.exitCode).toBe(0);
  const report = JSON.parse(result.stdout.toString()) as {
    validation: string;
    product_execution: boolean;
  };
  expect(report.validation).toBe("static_pass");
  expect(report.product_execution).toBe(false);
});

test("pre-approving the changed Cue effect or mutating Ada fails the design validator", () => {
  expect(
    mutateLongitudinal((fixture) => {
      fixture.cue_stale_approval.decision.covers_effect_ref = "x_cue_effect_v2";
    }),
  ).not.toBe(0);
  expect(
    mutateLongitudinal((fixture) => {
      fixture.cue_stale_approval.oracle.old_decision_covers_changed_effect = true;
    }),
  ).not.toBe(0);
  expect(
    mutateLongitudinal((fixture) => {
      const ada = fixture.cue_stale_approval.commitments.find((item) => item.id === "x_cue_ada");
      if (ada) ada.changed = true;
    }),
  ).not.toBe(0);
  expect(
    mutateLongitudinal((fixture) => {
      fixture.cue_stale_approval.decision.changes_canon = true;
    }),
  ).not.toBe(0);
});
