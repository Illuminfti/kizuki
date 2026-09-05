/** Execute the fixed synthetic recovery recipe against one copied native package. */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { absolute, copyPackage, EvidenceError, hash, parents, publishEvidence, reject, SUPPORTED_BUN_VERSION, verifyPackage } from "./native-proof-evidence";
import { releaseTarget, requireNativeHost } from "./release-targets";
import { RECOVERY_RECIPE, RECOVERY_RECIPE_SHA256 } from "./recovery-proof-recipe";
import { SOURCE_ROOT, inspectSource, registeredGenerator, validateRecoveryReceipt } from "./recovery-proof-receipt";
import type { RecoveryReceipt } from "./recovery-proof-receipt";
import { observeRecoveryScenarios } from "./recovery-proof-scenarios";

export function parseRecoveryArgs(args: readonly string[]): { artifact: string; out: string } {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]!, value = args[index + 1];
    if (!["--artifact", "--out"].includes(key) || !value || value.startsWith("--") || values.has(key)) reject("invalid-recovery-arguments"); values.set(key, value);
  }
  if (values.size !== 2) reject("invalid-recovery-arguments");
  return { artifact: absolute(values.get("--artifact")), out: absolute(values.get("--out")) };
}
export async function runRecoveryProof(args: { artifact: string; out: string }): Promise<RecoveryReceipt> {
  absolute(args.artifact); absolute(args.out); const retainedParents = parents(args.out);
  mkdirSync(args.out, { mode: 0o700 }); retainedParents();
  const startedAt = new Date().toISOString(), started = performance.now();
  publishEvidence(join(args.out, "attempt.json"), { schema: "kizuki.native-recovery-attempt/v1", producer: "scripts/recovery-artifact-proof.ts", started_at: startedAt });
  let root: string | null = null;
  try {
    const source = inspectSource();
    if (!source.clean || Bun.version !== SUPPORTED_BUN_VERSION) reject("recovery-requires-clean-pinned-source");
    const generator = registeredGenerator(), artifact = verifyPackage(args.artifact, source.source_sha);
    requireNativeHost(releaseTarget(artifact.build.target));
    root = mkdtempSync(join(realpathSync(tmpdir()), "kizuki-native-recovery-"));
    if (!relative(SOURCE_ROOT, root).startsWith("../")) reject("recovery-execution-must-be-outside-checkout");
    const copied = join(root, "artifact"); copyPackage(args.artifact, copied);
    const copy = verifyPackage(copied, source.source_sha, artifact.build.target);
    if (JSON.stringify(copy.package_sha256) !== JSON.stringify(artifact.package_sha256)) reject("recovery-package-copy-mismatch");
    const scenarios = await observeRecoveryScenarios(root, [join(copied, "kizuki")], [join(copied, "kizuki-mcp")]);
    artifact.unchanged(); copy.unchanged();
    const after = inspectSource();
    if (!after.clean || after.source_sha !== source.source_sha || after.source_tree_sha !== source.source_tree_sha || hash(JSON.stringify(registeredGenerator())) !== hash(JSON.stringify(generator))) reject("recovery-generator-changed");
    const receipt: RecoveryReceipt = { schema: "kizuki.native-recovery-proof/v2", candidate: { source_sha: source.source_sha, source_tree_sha: source.source_tree_sha },
      artifact: { build: artifact.build, package_sha256: artifact.package_sha256, copied_package_sha256: copy.package_sha256 }, generator,
      host: { platform: process.platform, arch: process.arch }, scope: "synthetic-native-recovery",
      recipe: { id: RECOVERY_RECIPE.id, version: RECOVERY_RECIPE.version, sha256: RECOVERY_RECIPE_SHA256 },
      observation: { started_at: startedAt, ended_at: new Date().toISOString(), elapsed_ms: Math.round(performance.now() - started) }, scenarios,
      completion: { state: scenarios.every(scenario => scenario.failure === null) ? "complete" : "failed", cleanup: "complete" } };
    try { rmSync(root, { recursive: true }); root = null; } catch { receipt.completion = { state: "failed", cleanup: "failed" }; }
    if (receipt.completion.state === "complete") {
      // Re-reading the original package verifies this receipt without relying on
      // a deleted temporary copy. Copy identity was checked before cleanup.
      validateRecoveryReceipt(receipt, artifact, generator);
    }
    publishEvidence(join(args.out, "receipt.json"), receipt); return receipt;
  } catch (error) {
    let cleanup = "complete";
    if (root !== null) { try { rmSync(root, { recursive: true }); root = null; } catch { cleanup = "failed"; } }
    publishEvidence(join(args.out, "failure.json"), { schema: "kizuki.native-recovery-attempt-failure/v1", reason: error instanceof EvidenceError ? error.reason : "recovery-producer-failed", cleanup, started_at: startedAt, ended_at: new Date().toISOString() });
    throw error;
  }
}
if (import.meta.main) {
  try { const receipt = await runRecoveryProof(parseRecoveryArgs(Bun.argv.slice(2))); process.stdout.write(JSON.stringify({ schema: receipt.schema, candidate: receipt.candidate.source_sha, completion: receipt.completion }) + "\n"); process.exitCode = receipt.completion.state === "complete" ? 0 : 1; }
  catch (error) {
    const published = error instanceof EvidenceError && error.reason.startsWith("published-report-");
    process.stderr.write(published ? `${error.reason}: complete evidence exists in the requested report directory; use a fresh directory for another attempt\n`
      : "recovery-proof-failed: use --artifact ABSOLUTE_NATIVE_PACKAGE --out ABSOLUTE_NEW_DIRECTORY\n"); process.exitCode = 1;
  }
}
