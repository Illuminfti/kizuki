/** Design-only check that a copied Concept exposure keeps the original support root. */
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

type Fixture = {
  evaluation_state: string;
  oracle: {
    support_expectations: Array<Record<string, unknown>>;
    assertions: Array<Record<string, unknown>>;
  };
};
type Longitudinal = { base: { sha256: string } };

function validate(dir?: string) {
  const args = dir === undefined ? [process.execPath, VALIDATOR] : [process.execPath, VALIDATOR, dir];
  return Bun.spawnSync(args, { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
}

function support(fixture: Fixture, id: string): Record<string, unknown> {
  const row = fixture.oracle.support_expectations.find((item) => item.id === id);
  if (row === undefined) throw new Error(`missing support ${id}`);
  return row;
}

function assertion(fixture: Fixture, id: string): Record<string, unknown> {
  const row = fixture.oracle.assertions.find((item) => item.id === id);
  if (row === undefined) throw new Error(`missing assertion ${id}`);
  return row;
}

function mutateConcept(mutate: (fixture: Fixture) => void): number {
  const dir = mkdtempSync(join(tmpdir(), "kizuki-concept-lineage-"));
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

test("unchanged fixtures keep copied Concept evidence on the original root", () => {
  const result = validate();
  expect(result.exitCode).toBe(0);
  const report = JSON.parse(result.stdout.toString()) as {
    validation: string;
    product_execution: boolean;
  };
  expect(report.validation).toBe("static_pass");
  expect(report.product_execution).toBe(false);
});

test("copied root substitution or inflated independent count fails", () => {
  expect(
    mutateConcept((fixture) => {
      support(fixture, "support_copied_exposure").independence_root_refs = ["r05"];
    }),
  ).not.toBe(0);
  expect(
    mutateConcept((fixture) => {
      support(fixture, "support_copied_exposure").independence_root_refs = ["r04"];
    }),
  ).not.toBe(0);
  expect(
    mutateConcept((fixture) => {
      delete support(fixture, "support_copied_exposure").prerequisite_support_refs;
    }),
  ).not.toBe(0);
  expect(
    mutateConcept((fixture) => {
      const expected = assertion(fixture, "a_copy").expected as Record<string, unknown>;
      expected.independent_definition_root_count = 3;
    }),
  ).not.toBe(0);
});
