/** Design-only check that C1/C2 stay bound to their actual actor and evidence. */
import { expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../..");
const FIXTURES = join(ROOT, "rfcs/fixtures");
const VALIDATOR = join(FIXTURES, "validate-world-design.ts");
const CONCEPT = "world-concept-design.json";
const LONGITUDINAL = "world-longitudinal-design.json";

type Fixture = {
  evaluation_state: string;
  oracle: { entities: Array<Record<string, unknown>> };
};

function validate(dir?: string) {
  const args = dir === undefined ? [process.execPath, VALIDATOR] : [process.execPath, VALIDATOR, dir];
  return Bun.spawnSync(args, { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
}

function mutateLongitudinal(mutate: (fixture: Fixture) => void): { exitCode: number; stdout: string } {
  const dir = mkdtempSync(join(tmpdir(), "kizuki-commitment-binding-"));
  try {
    copyFileSync(join(FIXTURES, CONCEPT), join(dir, CONCEPT));
    const fixture = JSON.parse(readFileSync(join(FIXTURES, LONGITUDINAL), "utf8")) as Fixture;
    mutate(fixture);
    writeFileSync(join(dir, LONGITUDINAL), `${JSON.stringify(fixture)}\n`);
    const result = validate(dir);
    return { exitCode: result.exitCode ?? 1, stdout: result.stdout.toString() };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function entity(fixture: Fixture, id: string): Record<string, unknown> {
  const row = fixture.oracle.entities.find((item) => item.id === id);
  if (row === undefined) throw new Error(`missing entity ${id}`);
  return row;
}

test("unchanged fixtures bind each commitment to its actor and evidence", () => {
  const result = validate();
  expect(result.exitCode).toBe(0);
  const report = JSON.parse(result.stdout.toString()) as {
    validation: string;
    product_execution: boolean;
  };
  expect(report.validation).toBe("static_pass");
  expect(report.product_execution).toBe(false);
});

test("swapping commitment actors or evidence fails the design validator", () => {
  expect(
    mutateLongitudinal((fixture) => {
      const c1 = entity(fixture, "x_c1");
      const c2 = entity(fixture, "x_c2");
      [c1.actor_ref, c2.actor_ref] = [c2.actor_ref, c1.actor_ref];
    }).exitCode,
  ).not.toBe(0);
  expect(
    mutateLongitudinal((fixture) => {
      const c1 = entity(fixture, "x_c1");
      const c2 = entity(fixture, "x_c2");
      [c1.evidence_refs, c2.evidence_refs] = [c2.evidence_refs, c1.evidence_refs];
    }).exitCode,
  ).not.toBe(0);
  expect(
    mutateLongitudinal((fixture) => {
      const c1 = entity(fixture, "x_c1");
      const c2 = entity(fixture, "x_c2");
      [c1.actor_ref, c2.actor_ref] = [c2.actor_ref, c1.actor_ref];
      [c1.evidence_refs, c2.evidence_refs] = [c2.evidence_refs, c1.evidence_refs];
    }).exitCode,
  ).not.toBe(0);
});
