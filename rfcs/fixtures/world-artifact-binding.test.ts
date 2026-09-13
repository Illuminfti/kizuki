/** Design-only check that failed v1 and later v2 inspections stay version-bound. Not retrieval quality. */
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
  status: string;
  input: {
    records: Array<Record<string, unknown>>;
    artifacts: Array<Record<string, unknown>>;
  };
};

function validate(dir?: string) {
  const args = dir === undefined ? [process.execPath, VALIDATOR] : [process.execPath, VALIDATOR, dir];
  return Bun.spawnSync(args, { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
}

function mutateLongitudinal(mutate: (fixture: Fixture) => void): number {
  const dir = mkdtempSync(join(tmpdir(), "kizuki-artifact-binding-"));
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

function record(fixture: Fixture, id: string): Record<string, unknown> {
  const row = fixture.input.records.find((item) => item.id === id);
  if (row === undefined) throw new Error(`missing record ${id}`);
  return row;
}

function artifact(fixture: Fixture, id: string): Record<string, unknown> {
  const row = fixture.input.artifacts.find((item) => item.id === id);
  if (row === undefined) throw new Error(`missing artifact ${id}`);
  return row;
}

test("unchanged fixtures bind failed v1 and successful v2 inspections", () => {
  const result = validate();
  expect(result.exitCode).toBe(0);
  const report = JSON.parse(result.stdout.toString()) as {
    validation: string;
    product_execution: boolean;
  };
  expect(report.validation).toBe("static_pass");
  expect(report.product_execution).toBe(false);
});

test("misbound inspection versions fail the design validator", () => {
  expect(
    mutateLongitudinal((fixture) => {
      record(fixture, "x_r_correct_version").artifact_refs = ["x_artifact_v1"];
    }),
  ).not.toBe(0);
  expect(
    mutateLongitudinal((fixture) => {
      delete record(fixture, "x_r_correct_version").artifact_refs;
    }),
  ).not.toBe(0);
  expect(
    mutateLongitudinal((fixture) => {
      record(fixture, "x_r_wrong_version").artifact_refs = ["x_artifact_v1"];
      record(fixture, "x_r_correct_version").artifact_refs = ["x_artifact_v1"];
    }),
  ).not.toBe(0);
  expect(
    mutateLongitudinal((fixture) => {
      artifact(fixture, "x_artifact_v2").version = "v1";
    }),
  ).not.toBe(0);
});
