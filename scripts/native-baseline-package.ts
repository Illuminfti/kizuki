import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { runArtifactProof } from "./stranger-proof";
import { CURRENT_PACKAGE_FILES, parseBuildInfo, requireRegularFile, verifyPackageDirectory } from "./release-artifacts";
import { BUN_DISTRIBUTION_PIN } from "./release-notices";
import { selectedReleaseTarget } from "./release-targets";

// This is a previously qualified candidate, not a previously published release.
export const NATIVE_BASELINE_SOURCE_SHA = "5d4c9870797607e22d25e30bdda37a879aba9d69";
const repository = resolve(import.meta.dir, "..");
const lockDigest = "2726abbda9cc9466570398e4297132d00969fee68a8cc486c244ce31a4ab6224";
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function check(condition: unknown, reason: string): asserts condition { if (!condition) throw new Error(reason); }
function fileHash(path: string): string { requireRegularFile(path); return digest(readFileSync(path)); }

export function parseNativeBaselineArgs(argv: readonly string[]): string {
  check(argv.length === 2 && argv[0] === "--out" && typeof argv[1] === "string" && argv[1].length > 0 &&
    !argv[1].startsWith("--"), "usage: bun scripts/native-baseline-package.ts --out DIR");
  return resolve(argv[1]);
}

/** The build lane may use only the exact, frozen dependency graph of the prior candidate. */
export function checkNativeBaselineInputs(current: { source: string; clean: boolean; lock: string; bun: string; revision: string }, priorLock: string): void {
  check(/^[0-9a-f]{40}$/.test(current.source) && current.source !== NATIVE_BASELINE_SOURCE_SHA && current.clean,
    "baseline qualification requires a distinct clean candidate source");
  check(current.bun === BUN_DISTRIBUTION_PIN.version && current.revision === BUN_DISTRIBUTION_PIN.revision,
    "baseline qualification requires the pinned native runtime");
  check(current.lock === lockDigest && priorLock === lockDigest, "baseline dependency graph differs from the reviewed frozen graph");
}

/** Fresh private output only; no supplied path is overwritten or resolved through a symlink. */
export function createNativeBaselineOutput(output: string): void {
  const parent = dirname(output);
  check(realpathSync(parent) === parent && lstatSync(parent).isDirectory(), "baseline output parent must be a canonical directory");
  mkdirSync(output, { mode: 0o700 });
}

/** Native compilation and copied-package proof; never installs a user service. */
export async function buildNativeBaseline(output: string): Promise<string> {
  output = resolve(output);
  const target = selectedReleaseTarget();
  const git = (args: string[], cwd = repository): string => {
    const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", timeout: 30_000 });
    check(result.exitCode === 0, "baseline Git operation failed");
    return result.stdout.toString().trim();
  };
  const candidate = git(["rev-parse", "HEAD"]);
  // Git text trimming is inappropriate for content identity; retain the exact blob bytes.
  const lockBlob = Bun.spawnSync(["git", "show", `${NATIVE_BASELINE_SOURCE_SHA}:bun.lock`],
    { cwd: repository, stdout: "pipe", stderr: "pipe", timeout: 30_000 });
  check(lockBlob.exitCode === 0 && lockBlob.stdout.length > 0, "baseline lock blob unavailable");
  checkNativeBaselineInputs({ source: candidate, clean: git(["status", "--porcelain"]) === "",
    lock: fileHash(join(repository, "bun.lock")), bun: Bun.version, revision: Bun.revision }, digest(lockBlob.stdout));
  git(["merge-base", "--is-ancestor", NATIVE_BASELINE_SOURCE_SHA, candidate]);
  createNativeBaselineOutput(output);
  const source = join(output, "source"), home = join(output, "home"), artifact = join(output, "package");
  mkdirSync(home, { mode: 0o700 });
  let ownedWorktree = false;
  const commandReceipts: { command: string[]; exit_code: number; signal: string | null; output_sha256: string; duration_ms: number }[] = [];
  try {
    git(["worktree", "add", "--detach", source, NATIVE_BASELINE_SOURCE_SHA]); ownedWorktree = true;
    check(git(["rev-parse", "HEAD"], source) === NATIVE_BASELINE_SOURCE_SHA, "baseline source changed");
    const priorTree = git(["rev-parse", "HEAD^{tree}"], source);
    cpSync(join(repository, "node_modules"), join(source, "node_modules"), { recursive: true, dereference: false, verbatimSymlinks: true, errorOnExist: true, force: false });
    for (const entry of readdirSync(join(repository, "packages"), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const modules = join(repository, "packages", entry.name, "node_modules");
      if (existsSync(modules)) cpSync(modules, join(source, "packages", entry.name, "node_modules"),
        { recursive: true, dereference: false, verbatimSymlinks: true, errorOnExist: true, force: false });
    }
    check(git(["status", "--porcelain"], source) === "", "baseline source or dependencies changed tracked files");
    const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home,
      LANG: "C.UTF-8", KIZUKI_TARGET: target.target, KIZUKI_SUPERVISOR: "none" };
    if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR;
    const command = [process.execPath, "run", "build:release"], started = performance.now();
    const built = Bun.spawnSync(command, { cwd: source, env, stdout: "pipe", stderr: "pipe", timeout: 180_000 });
    commandReceipts.push({ command: ["bun", "run", "build:release"], exit_code: built.exitCode, signal: built.signalCode ?? null,
      output_sha256: digest(Buffer.concat([built.stdout, built.stderr])), duration_ms: Math.ceil(performance.now() - started) });
    writeFileSync(join(output, "build.log"), Buffer.concat([built.stdout, built.stderr]), { mode: 0o600, flag: "wx" });
    check(built.exitCode === 0 && built.signalCode === undefined, "baseline native build failed; retained build.log");
    check(git(["rev-parse", "HEAD"], source) === NATIVE_BASELINE_SOURCE_SHA && git(["status", "--porcelain"], source) === "",
      "baseline source changed during compilation");
    const version = (JSON.parse(readFileSync(join(source, "packages/cli/package.json"), "utf8")) as { version: string }).version;
    check(/^\d+\.\d+\.\d+$/.test(version), "baseline package version malformed");
    const builtArtifact = join(source, "dist", `kizuki-${version}`, target.target);
    const build = parseBuildInfo(join(builtArtifact, "BUILD.json"));
    check(build.schema === "kizuki.release-build/v2" && build.source_sha === NATIVE_BASELINE_SOURCE_SHA &&
      build.target === target.target && build.bun_version === BUN_DISTRIBUTION_PIN.version, "baseline package identity mismatch");
    verifyPackageDirectory(builtArtifact, build);
    cpSync(builtArtifact, artifact, { recursive: true, dereference: false, errorOnExist: true, force: false });
    verifyPackageDirectory(artifact, build);
    const hashes = Object.fromEntries(CURRENT_PACKAGE_FILES.map(name => [name, fileHash(join(artifact, name))]));
    const proofPath = await runArtifactProof({ artifact, report: join(output, "proof") });
    verifyPackageDirectory(artifact, build);
    for (const name of CURRENT_PACKAGE_FILES) check(fileHash(join(artifact, name)) === hashes[name], "baseline package changed during proof");
    check(git(["rev-parse", "HEAD"]) === candidate && git(["status", "--porcelain"]) === "", "candidate source changed during baseline proof");
    git(["worktree", "remove", "--force", source]); ownedWorktree = false;
    const receipt = { schema: "kizuki.native-baseline-package/v1", candidate_source_sha: candidate,
      source_sha: NATIVE_BASELINE_SOURCE_SHA, source_tree: priorTree, target: target.target,
      bun_version: Bun.version, bun_revision: Bun.revision, dependency_lock_sha256: lockDigest,
      package_sha256: hashes, proof_sha256: fileHash(proofPath), proof: JSON.parse(readFileSync(proofPath, "utf8")),
      commands: commandReceipts, prior_published_release: false, worktree_removed: true };
    const receiptPath = join(output, "receipt.json");
    writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    return receiptPath;
  } catch (error) {
    // Retain the owned source, build log and any package for diagnosis. Never delete an unverified tree.
    writeFileSync(join(output, "failure.json"), JSON.stringify({ schema: "kizuki.native-baseline-failure/v1",
      candidate_source_sha: candidate, source_sha: NATIVE_BASELINE_SOURCE_SHA, worktree_retained: ownedWorktree,
      commands: commandReceipts }) + "\n", { mode: 0o600, flag: "wx" });
    throw error;
  }
}

if (import.meta.main) {
  try { console.log(`baseline package qualified: ${await buildNativeBaseline(parseNativeBaselineArgs(process.argv.slice(2)))}`); }
  catch (error) { console.error(error instanceof Error ? error.message : "baseline qualification failed"); process.exitCode = 1; }
}
