import { expect, test } from "bun:test";
import { oracleCoverage } from "../rfcs/fixtures/oracle-coverage";
import { verifyOperationCoverage, verifyOracleCoverage } from "./world-verify/registry";

test("world coverage cannot drop an executable oracle even if another is added", () => {
  const coverage = oracleCoverage();
  const rows = coverage.rows.map(row => row.unit === "world-question-copy-design" ? { ...row, status: { status: "deferred" as const, owner: "QUEST" as const } } : row);
  expect(() => verifyOracleCoverage({ ...coverage, rows })).toThrow("executable coverage regressed: world-question-copy-design");
});

test("claiming executable with a missing or unrelated test fails the world gate", () => {
  const coverage = oracleCoverage();
  for (const test of ["packages/core/test/missing-world-oracle.test.ts", "packages/core/test/world/evidence.test.ts"]) {
    const rows = coverage.rows.map(row => row.unit === "world-question-copy-design" ? { ...row, status: { status: "executable" as const, test } } : row);
    expect(() => verifyOracleCoverage({ ...coverage, rows })).toThrow();
  }
});

test("an operation without a scenario or an obsolete scenario fails the matrix gate", () => {
  expect(() => verifyOperationCoverage(["concept", "new_operation"], ["concept"])).toThrow("missing world scenario: new_operation");
  expect(() => verifyOperationCoverage(["concept"], ["concept", "old_operation"])).toThrow("stale world scenario: old_operation");
  expect(() => verifyOperationCoverage(["concept"], ["concept", "concept"])).toThrow("duplicate");
});
