/** Prints the executable-versus-deferred table and fails on an unowned oracle unit. */
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatCoverageTable, oracleCoverage } from "./oracle-coverage";
import { FIXTURE_STATUS, ORACLE_ASSERTION_STATUS, deferred, executable } from "./status";

test("every oracle assertion is executable or deferred with an owner", () => {
  const coverage = oracleCoverage();
  console.log(formatCoverageTable(coverage));
  expect(coverage.uncovered).toEqual([]);
  expect(coverage.stale).toEqual([]);
  expect(coverage.rows.length).toBeGreaterThan(Object.keys(FIXTURE_STATUS).length);
});

test("the concept and longitudinal fixtures are counted assertion by assertion", () => {
  const units = oracleCoverage().rows.map((row) => row.unit);
  expect(units).toContain("world-concept-design#a_hidden_mutation");
  expect(units).not.toContain("world-concept-design");
  expect(Object.keys(ORACLE_ASSERTION_STATUS).length).toBe(units.filter((unit) => unit.includes("#")).length);
});

test("a many-assertion fixture is executable only when every assertion is", () => {
  for (const [id, entry] of Object.entries(FIXTURE_STATUS)) {
    if (entry.status !== "executable") continue;
    const parts = oracleCoverage().rows.filter((row) => row.unit.startsWith(`${id}#`));
    for (const row of parts) expect(row.status?.status, row.unit).toBe("executable");
  }
});

test("an assertion with neither a test nor an owner fails, and a stale line is reported", () => {
  const dir = mkdtempSync(join(tmpdir(), "kizuki-oracle-coverage-"));
  try {
    writeFileSync(join(dir, "one.json"), JSON.stringify({ oracle: { assertions: [{ id: "a" }, { id: "b" }] } }));
    writeFileSync(join(dir, "two.json"), JSON.stringify({ oracle: { flag: false } }));
    const coverage = oracleCoverage(
      dir,
      { two: deferred("VERIFY") },
      { "one#a": executable("rfcs/fixtures/oracle-coverage.test.ts"), "one#gone": deferred("KNOWN") },
    );
    expect(coverage.uncovered).toEqual(["one#b"]);
    expect(coverage.stale).toEqual(["one#gone"]);
    expect(formatCoverageTable(coverage)).toContain("UNCOVERED");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
