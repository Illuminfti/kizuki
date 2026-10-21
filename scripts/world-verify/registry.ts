import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";
import { oracleCoverage, type OracleCoverage } from "../../rfcs/fixtures/oracle-coverage";
import { boundTestErrors, REPOSITORY_ROOT } from "../../rfcs/fixtures/status";
import { WORLD_OPS } from "../../packages/core/src/world/ops/registry";
import { WORLD_VERIFICATION_OPERATIONS } from "../../packages/core/test/helpers/world-verification";
import { verifyPacketSeams, verifyWorldSurfaceParity } from "../verify-packet-seams";

/** Unit identities, not a count: replacing a covered oracle cannot conceal regression. */
export const ORACLE_COVERAGE_FLOOR = [
  "world-concept-absence-design", "world-concept-design#a_hidden_mutation",
  "world-concept-design#a_copy_raw_retained", "world-concept-design#a_narrowed_old_view",
  "world-longitudinal-design#x_a_restore_old", "world-question-copy-design", "world-question-reopen-design",
  "world-perspective-binding-design",
] as const;

export const WORLD_GATE_TESTS = [
  "packages/core/test/world/verification-matrix.test.ts",
  "packages/core/test/world/slice.test.ts",
  "packages/core/test/world/verification-resources.test.ts",
  "packages/cli/test/world-verification-parity.test.ts",
  "packages/core/test/world/pipeline-noninterference.test.ts",
  "packages/core/test/world/known-history.test.ts",
  "packages/core/test/world/questions-security.test.ts",
  "packages/core/test/world/questions-history.test.ts",
  "packages/core/test/world/evidence.test.ts",
  "packages/core/test/world/skills-security.test.ts",
  "packages/core/test/world/skills-recovery.test.ts",
  "packages/core/test/world/skills.test.ts",
  "packages/core/test/world/people-security.test.ts",
  "packages/core/test/world/people-history.test.ts",
  "packages/core/test/world/people-grouping.test.ts",
  "packages/core/test/serving/people-session.test.ts",
  "packages/core/test/world/verify.test.ts",
  "packages/cli/test/verify-world.test.ts",
  "scripts/world-verify.test.ts",
] as const;

export function verifyOracleCoverage(coverage: OracleCoverage, root = REPOSITORY_ROOT, floor: readonly string[] = ORACLE_COVERAGE_FLOOR): string[] {
  const errors = [...coverage.uncovered.map(unit => `uncovered oracle: ${unit}`), ...coverage.stale.map(unit => `stale oracle: ${unit}`)];
  const executable = new Set<string>();
  const tests = new Set<string>();
  for (const row of coverage.rows) if (row.status?.status === "executable") {
    executable.add(row.unit);
    tests.add(row.status.test);
    errors.push(...boundTestErrors(row.status.test, root, row.unit));
  }
  for (const unit of floor) if (!executable.has(unit)) errors.push(`executable coverage regressed: ${unit}`);
  for (const unit of executable) if (!floor.includes(unit)) errors.push(`record new executable oracle in the coverage floor: ${unit}`);
  if (errors.length) throw new Error(errors.join("\n"));
  return [...tests].sort();
}

export function verifyOperationCoverage(operations: readonly string[], scenarios: readonly string[]): void {
  const expected = new Set(operations), actual = new Set(scenarios);
  if (actual.size !== scenarios.length) throw new Error("duplicate world scenario");
  const errors = [...operations.filter(name => !actual.has(name)).map(name => `missing world scenario: ${name}`),
    ...scenarios.filter(name => !expected.has(name)).map(name => `stale world scenario: ${name}`)];
  if (errors.length) throw new Error(errors.join("\n"));
}

function requireTest(root: string, path: string): void {
  if (isAbsolute(path) || normalize(path) !== path || path.startsWith("..") || !path.endsWith(".test.ts")) throw new Error("invalid world test path");
  if (!lstatSync(join(root, path)).isFile() || !/\b(?:test|it)\s*\(/.test(readFileSync(join(root, path), "utf8"))) throw new Error(`missing executable world test: ${path}`);
}

export function verifyWorldRegistry(root = REPOSITORY_ROOT): { tests: string[]; executable: number; total: number; operations: number } {
  const coverage = oracleCoverage();
  const tests = [...new Set([...WORLD_GATE_TESTS, ...verifyOracleCoverage(coverage, root)])].sort();
  for (const path of tests) requireTest(root, path);
  verifyOperationCoverage(WORLD_OPS.map(op => op.name), WORLD_VERIFICATION_OPERATIONS);
  verifyPacketSeams(root, JSON.parse(readFileSync(join(root, "docs/world/packet-seams.json"), "utf8")));
  verifyWorldSurfaceParity();
  return { tests, executable: coverage.rows.filter(row => row.status?.status === "executable").length,
    total: coverage.rows.length, operations: WORLD_OPS.length };
}
