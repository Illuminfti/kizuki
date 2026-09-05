import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PACKAGE_FILES, hash, verifyPackage } from "./native-proof-evidence";
import { RECOVERY_RECIPE, RECOVERY_RECIPE_SHA256 } from "./recovery-proof-recipe";
import { registeredGenerator, validateRecoveryReceipt } from "./recovery-proof-receipt";
import type { RecoveryReceipt } from "./recovery-proof-receipt";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
import { syntheticScenario } from "./recovery-proof-test-fixtures";
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "kizuki-recovery-validator-")); roots.push(directory);
  const generator = registeredGenerator();
  const build = { schema: "kizuki.release-build/v1", source_sha: generator.source_sha, target: "bun-linux-x64-baseline", bun_version: "1.3.10" };
  for (const name of PACKAGE_FILES.slice(0, -1)) writeFileSync(join(directory, name), name === "BUILD.json" ? JSON.stringify(build) : "synthetic evaluator bytes, never executed");
  writeFileSync(join(directory, "SHA256SUMS"), PACKAGE_FILES.slice(0, -1).map(name => `${hash(readFileSync(join(directory, name)))}  ${name}`).join("\n") + "\n");
  const artifact = verifyPackage(directory, generator.source_sha);
  const receipt: RecoveryReceipt = { schema: "kizuki.native-recovery-proof/v2", candidate: { source_sha: generator.source_sha, source_tree_sha: generator.source_tree_sha }, artifact: { build: artifact.build, package_sha256: artifact.package_sha256, copied_package_sha256: artifact.package_sha256 }, generator: structuredClone(generator),
    host: { platform: "linux", arch: "x64" }, scope: "synthetic-native-recovery", recipe: { id: RECOVERY_RECIPE.id, version: 2, sha256: RECOVERY_RECIPE_SHA256 },
    observation: { started_at: "2026-09-05T00:00:00.000Z", ended_at: "2026-09-05T00:00:00.010Z", elapsed_ms: 10 }, scenarios: [0, 1, 2].map(syntheticScenario), completion: { state: "complete", cleanup: "complete" } };
  return { receipt, artifact, generator };
}
const fact = (receipt: RecoveryReceipt, scenario: number, id: string) => receipt.scenarios[scenario]!.checks.find(row => row.id === id)!;

test("fixed recipe recognizes a complete synthetic validator baseline and keeps floor typo recall diagnostic", () => {
  const f = fixture(); expect(validateRecoveryReceipt(f.receipt, f.artifact, f.generator)).toEqual(f.receipt);
  expect((fact(f.receipt, 0, "floor-typos").observed as { rank: number }[]).map(row => row.rank)).toEqual([0, 0, 0, 0]);
});
test.each([
  ["candidate", (r: RecoveryReceipt) => { r.candidate.source_sha = "b".repeat(40); }],
  ["tree", (r: RecoveryReceipt) => { r.candidate.source_tree_sha = "b".repeat(40); }],
  ["host", (r: RecoveryReceipt) => { r.host.arch = "arm64"; }],
  ["Bun", (r: RecoveryReceipt) => { r.generator.runtime_bun_version = "9.9.9"; }],
  ["generator", (r: RecoveryReceipt) => { r.generator.files_sha256["scripts/recovery-proof-scenarios.ts"] = "b".repeat(64); }],
  ["recipe", (r: RecoveryReceipt) => { r.recipe.sha256 = "b".repeat(64); }],
  ["cleanup", (r: RecoveryReceipt) => { r.completion.cleanup = "failed"; }],
  ["incomplete", (r: RecoveryReceipt) => { r.completion.state = "failed"; }],
  ["clock", (r: RecoveryReceipt) => { r.observation.elapsed_ms = Infinity; }],
  ["scope", (r: RecoveryReceipt) => { Object.assign(r, { scope: "human-owner" }); }],
] as const)("receipt refuses altered %s", (_name, mutate) => { const f = fixture(); mutate(f.receipt); expect(() => validateRecoveryReceipt(f.receipt, f.artifact, f.generator)).toThrow(); });
test.each([...PACKAGE_FILES])("each %s hash binds both the original and copied package", file => {
  for (const copy of ["package_sha256", "copied_package_sha256"] as const) { const f = fixture(); f.receipt.artifact[copy] = { ...f.receipt.artifact[copy], [file]: "0".repeat(64) }; expect(() => validateRecoveryReceipt(f.receipt, f.artifact, f.generator)).toThrow(); }
});
test("omitted, duplicated, reordered or fabricated checks and commands cannot receive credit", () => {
  for (const mutate of [
    (r: RecoveryReceipt) => { r.scenarios.pop(); },
    (r: RecoveryReceipt) => { r.scenarios[0]!.checks.pop(); },
    (r: RecoveryReceipt) => { r.scenarios[0]!.checks.reverse(); },
    (r: RecoveryReceipt) => { r.scenarios[0]!.checks[1] = r.scenarios[0]!.checks[0]!; },
    (r: RecoveryReceipt) => { Object.assign(r.scenarios[0]!.checks[0]!, { passed: true }); },
    (r: RecoveryReceipt) => { r.scenarios[0]!.commands[0]!.template = ["--help"]; },
    (r: RecoveryReceipt) => { r.scenarios[0]!.commands.pop(); },
    (r: RecoveryReceipt) => { r.scenarios[0]!.fixtures.pop(); },
  ]) { const f = fixture(); mutate(f.receipt); expect(() => validateRecoveryReceipt(f.receipt, f.artifact, f.generator)).toThrow(); }
});
test("timeouts cannot masquerade as denial and fixture children must finish within bounds", () => {
  for (const index of [0, 1]) { const f = fixture(); const command = index ? f.receipt.scenarios[1]!.commands.find(row => row.id.startsWith("denied."))! : f.receipt.scenarios[0]!.commands[0]!;
    command.observation.fault = "deadline"; expect(() => validateRecoveryReceipt(f.receipt, f.artifact, f.generator)).toThrow(); }
  const f = fixture(); f.receipt.scenarios[0]!.fixtures[0]!.observation!.stdout_bytes = 1048577; expect(() => validateRecoveryReceipt(f.receipt, f.artifact, f.generator)).toThrow();
});
test("same-process positive controls, request identity, prefix replacement and busy erasure are mandatory", () => {
  for (const mutate of [
    (r: RecoveryReceipt) => { r.scenarios[1]!.tools[3]!.session = 2; },
    (r: RecoveryReceipt) => { r.scenarios[1]!.tools[3]!.request_id = 2; },
    (r: RecoveryReceipt) => { r.scenarios[1]!.sessions[0]!.observation.fault = "early-eof"; },
    (r: RecoveryReceipt) => { fact(r, 1, "mcp-positive-revoked").observed = 0; },
    (r: RecoveryReceipt) => { fact(r, 1, "historical-fts-positive").observed = [1, 0]; },
    (r: RecoveryReceipt) => { fact(r, 1, "prefix-delivery").observed = "delta"; },
    (r: RecoveryReceipt) => { fact(r, 1, "busy-store").observed = { purge: "complete", postgres: "maintained" }; },
    (r: RecoveryReceipt) => { (fact(r, 1, "completed-stores").observed as { existing_generations: number }).existing_generations = 1; },
  ]) { const f = fixture(); mutate(f.receipt); expect(() => validateRecoveryReceipt(f.receipt, f.artifact, f.generator)).toThrow(); }
});
test("pending journal identity, zero-model replay and exact retry membership are indispensable", () => {
  for (const mutate of [
    (r: RecoveryReceipt) => { fact(r, 2, "replay-model-requests").observed = 1; },
    (r: RecoveryReceipt) => { fact(r, 2, "retry-model-requests").observed = 1; },
    (r: RecoveryReceipt) => { fact(r, 2, "legacy-warning").observed = "historical migration verified"; },
    (r: RecoveryReceipt) => { (fact(r, 2, "missing-journal-refusal").observed as { target_exists: boolean }).target_exists = true; },
    (r: RecoveryReceipt) => { (fact(r, 2, "exported-journal").observed as Record<string, { after_sha256: string }>).drafts!.after_sha256 = hash("changed"); },
    (r: RecoveryReceipt) => { (fact(r, 2, "retry-state").observed as { provenance_sha256: string }).provenance_sha256 = hash("changed"); },
    (r: RecoveryReceipt) => { (fact(r, 2, "retry-state").observed as { deferred_ids_sha256: string[] }).deferred_ids_sha256 = [hash("changed"), hash("also-changed")]; },
    (r: RecoveryReceipt) => { (fact(r, 2, "stable-receipt").observed as { before_sha256: string }).before_sha256 = hash("another-receipt"); },
  ]) { const f = fixture(); mutate(f.receipt); expect(() => validateRecoveryReceipt(f.receipt, f.artifact, f.generator)).toThrow(); }
});

test("reported HEAD cannot register a modified local trust dependency", () => {
  const script = `
    import { mock } from "bun:test";
    const modulePath = ${JSON.stringify(join(import.meta.dir, "native-proof-evidence.ts"))};
    const real = await import(modulePath), originalRead = real.read;
    mock.module(modulePath, () => ({ ...real, read(path, ...args) {
      const result = originalRead(path, ...args);
      return path.endsWith("/scripts/recovery-proof-recipe.ts") ? { ...result, sha256: "b".repeat(64) } : result;
    } }));
    const { registeredGenerator } = await import(${JSON.stringify(join(import.meta.dir, "recovery-proof-receipt.ts"))});
    try { registeredGenerator(); process.stdout.write("unexpected success"); } catch (error) { process.stdout.write(error.reason); }
  `;
  const child = Bun.spawnSync([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe", timeout: 30000 });
  expect(child.exitCode).toBe(0); expect(child.stdout.toString()).toBe("recovery-generator-local-blob-mismatch");
});
