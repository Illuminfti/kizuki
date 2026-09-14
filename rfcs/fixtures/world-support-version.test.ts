/** Design-only check that fixture support names captured-record revision 1. */
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../..");
const FIXTURES = join(ROOT, "rfcs/fixtures");
const VALIDATOR = join(FIXTURES, "validate-world-design.ts");
const CONCEPT = "world-concept-design.json";
const LONGITUDINAL = "world-longitudinal-design.json";

type Support = Record<string, unknown>;
type Fixture = {
  evaluation_state: string;
  oracle: { support_expectations: Support[] };
};
type Longitudinal = { base: { sha256: string } };

function validate(dir?: string) {
  const args = dir === undefined ? [process.execPath, VALIDATOR] : [process.execPath, VALIDATOR, dir];
  return Bun.spawnSync(args, { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
}

function support(fixture: Fixture, id: string): Support {
  const row = fixture.oracle.support_expectations.find((item) => item.id === id);
  if (row === undefined) throw new Error(`missing support ${id}`);
  return row;
}

function mutateConcept(mutate: (fixture: Fixture) => void): number {
  const dir = mkdtempSync(join(tmpdir(), "kizuki-support-version-"));
  try {
    const fixture = JSON.parse(readFileSync(join(FIXTURES, CONCEPT), "utf8")) as Fixture;
    mutate(fixture);
    const conceptBytes = Buffer.from(`${JSON.stringify(fixture)}\n`);
    writeFileSync(join(dir, CONCEPT), conceptBytes);
    const longitudinal = JSON.parse(readFileSync(join(FIXTURES, LONGITUDINAL), "utf8")) as Longitudinal;
    longitudinal.base.sha256 = createHash("sha256").update(conceptBytes).digest("hex");
    writeFileSync(join(dir, LONGITUDINAL), `${JSON.stringify(longitudinal)}\n`);
    return validate(dir).exitCode ?? 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("unchanged fixtures keep captured-record revision 1", () => {
  const result = validate();
  expect(result.exitCode).toBe(0);
  const report = JSON.parse(result.stdout.toString()) as {
    validation: string;
    product_execution: boolean;
  };
  expect(report.validation).toBe("static_pass");
  expect(report.product_execution).toBe(false);
});

test("missing, zero, string, or undeclared support version 2 fails", () => {
  expect(
    mutateConcept((fixture) => {
      support(fixture, "support_question").event_version = 2;
    }),
  ).not.toBe(0);
  expect(
    mutateConcept((fixture) => {
      support(fixture, "support_question").event_version = 0;
    }),
  ).not.toBe(0);
  expect(
    mutateConcept((fixture) => {
      support(fixture, "support_question").event_version = "1";
    }),
  ).not.toBe(0);
  expect(
    mutateConcept((fixture) => {
      delete support(fixture, "support_question").event_version;
    }),
  ).not.toBe(0);
});
