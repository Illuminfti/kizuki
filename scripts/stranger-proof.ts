import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { release as kernelRelease, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { requireRegularFile, verifyChecksumManifest } from "./release-artifacts";

import { releaseTarget, requireNativeHost, selectedReleaseTarget } from "./release-targets";
import { ArtifactProofError, validateArtifactProof } from "./artifact-proof";
import type { CliEngineObservation, McpEngineObservation } from "./artifact-proof";
import { EngineProofError, collectEngineProcess, mcpObservationFromOutput, parseDoctorObservation } from "./artifact-engine";

const root = resolve(import.meta.dir, "..");
const schema = "kizuki.artifact-proof/v2" as const;
const supportedBunVersion = readFileSync(join(root, ".bun-version"), "utf8").trim();

const packaged = ["kizuki", "kizuki-mcp", "README.txt", "BUILD.json"] as const;
const CHILD_TIMEOUT_MS = 30_000;

interface BuildInfo {
  schema: "kizuki.release-build/v1";
  source_sha: string;
  target: string;
  bun_version: string;
}

export interface StepReceipt {
  id: string;
  command: readonly string[];
  exit_code: number;
  passed: boolean;
  timeout_ms: number;
}

interface ProofReceipt {
  schema: typeof schema;
  source_sha: string;
  target: string;
  host_platform: string;
  host_arch: string;
  host_kernel_release: string;
  binary_sha256: string;
  bun_version: string;
  package_sha256: Record<string, string>;
  paths: {
    executable: string;
    home: string;
    config: string;
    vault: string;
    restored_vault: string;
  };
  steps: StepReceipt[];
  failures: string[];
  engine_observations: { kizuki: CliEngineObservation | null; kizuki_mcp: McpEngineObservation | null };
}

export interface ProofArgs {
  artifact: string;
  report: string;
}

export function parseProofArgs(args: readonly string[]): ProofArgs {
  let artifact: string | undefined;
  let report: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument !== "--artifact" && argument !== "--report") {
      throw new Error("usage: bun run proof:artifact -- [--artifact DIR] --report DIR");
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error("usage: bun run proof:artifact -- [--artifact DIR] --report DIR");
    }
    index += 1;
    if (argument === "--artifact") artifact = resolve(value);
    else report = resolve(value);
  }
  if (report === undefined) {
    throw new Error("artifact proof requires --report DIR so its receipt is retained");
  }
  return {
    artifact: artifact ?? resolve(root, "dist", `kizuki-${packageVersion()}`, selectedReleaseTarget().target),
    report,
  };
}

function packageVersion(): string {
  const manifest = JSON.parse(readFileSync(resolve(root, "packages/cli/package.json"), "utf8")) as unknown;
  if (!isObject(manifest) || typeof manifest["version"] !== "string") {
    throw new Error("CLI package version is unreadable");
  }
  return manifest["version"];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseBuildInfo(path: string): BuildInfo {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    throw new Error("release BUILD.json is unreadable");
  }
  return parseBuildInfoValue(value);
}

/** Allows bounded readers to validate the exact bytes they already hashed. */
export function parseBuildInfoValue(value: unknown): BuildInfo {
  if (!isObject(value) || Object.keys(value).sort().join(",") !== "bun_version,schema,source_sha,target" ||
      value["schema"] !== "kizuki.release-build/v1" || typeof value["source_sha"] !== "string" ||
      !/^[0-9a-f]{40}$/.test(value["source_sha"]) || typeof value["target"] !== "string" ||
      typeof value["bun_version"] !== "string") {
    throw new Error("release BUILD.json has an invalid shape");
  }
  return value as unknown as BuildInfo;
}

export function proofEnvironment(directory: string): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: join(directory, "home"),
    XDG_CONFIG_HOME: join(directory, "config"),
    KIZUKI_CONFIG: join(directory, "config", "kizuki.toml"),
    KIZUKI_SUPERVISOR: "none",
    LANG: "C.UTF-8",
  };
}

function sha256(path: string): string {
  requireRegularFile(path);
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function safeSha256(path: string): string {
  try {
    return sha256(path);
  } catch {
    return "unavailable";
  }
}

function checkedArtifact(path: string): BuildInfo {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("artifact must be a regular directory");
  }
  for (const name of [...packaged, "SHA256SUMS"]) requireRegularFile(join(path, name));
  verifyChecksumManifest(path, packaged);
  const build = parseBuildInfo(join(path, "BUILD.json"));
  requireNativeHost(releaseTarget(build.target));
  if (build.bun_version !== Bun.version || Bun.version !== supportedBunVersion) throw new Error("artifact Bun version mismatch");
  return build;
}

function run(
  executable: string,
  cwd: string,
  env: Record<string, string>,
  id: string,
  args: readonly string[],
  steps: StepReceipt[],
): string {
  const result = Bun.spawnSync([executable, ...args], {
    cwd,
    env,
    stderr: "pipe",
    stdout: "pipe",
    timeout: CHILD_TIMEOUT_MS,
  });
  const step = {
    id,
    command: ["kizuki", ...args],
    exit_code: result.exitCode,
    passed: result.exitCode === 0,
    timeout_ms: CHILD_TIMEOUT_MS,
  };
  steps.push(step);
  if (result.exitCode !== 0) throw new Error(`${id} exited ${result.exitCode}`);
  return new TextDecoder().decode(result.stdout);
}

export function requireFixture(id: string, output: string, steps: StepReceipt[]): void {
  const passed = output.includes("Ada");
  steps.push({
    id,
    command: ["assert", "fixture is recalled"],
    exit_code: passed ? 0 : 1,
    passed,
    timeout_ms: 0,
  });
  if (!passed) throw new Error(`${id} did not return the imported fixture`);
}

function writeReceipt(report: string, receipt: ProofReceipt): string {
  mkdirSync(report, { recursive: true, mode: 0o700 });
  const stat = lstatSync(report);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("report must be a regular directory");
  const output = join(report, "receipt.json");
  writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  return output;
}

export async function runArtifactProof(args: ProofArgs): Promise<string> {
  const proofRoot = mkdtempSync(join(tmpdir(), "kizuki-artifact-proof-"));
  const copiedArtifact = join(proofRoot, "artifact");
  const execution = join(proofRoot, "execution");
  const steps: StepReceipt[] = [];
  const failures: string[] = [];
  let receipt: ProofReceipt | undefined;
  let sourceSha = "unavailable";
  let artifactTarget = "unavailable";
  const engineObservations: ProofReceipt["engine_observations"] = { kizuki: null, kizuki_mcp: null };
  let packageHashes: Record<string, string> = {};
  try {
    checkedArtifact(args.artifact);
    cpSync(args.artifact, copiedArtifact, { recursive: true, dereference: false, errorOnExist: true });
    // The copied snapshot supplies both provenance and the bytes we execute.
    const build = checkedArtifact(copiedArtifact);
    sourceSha = build.source_sha;
    artifactTarget = build.target;
    packageHashes = Object.fromEntries([...packaged, "SHA256SUMS"].map(name => [name, sha256(join(copiedArtifact, name))]));
    const requireUnchangedPackage = () => {
      for (const [name, digest] of Object.entries(packageHashes)) {
        if (sha256(join(args.artifact, name)) !== digest || sha256(join(copiedArtifact, name)) !== digest) {
          throw new Error("artifact identity changed");
        }
      }
    };
    requireUnchangedPackage();
    const executable = join(copiedArtifact, "kizuki");
    const env = proofEnvironment(execution);
    const home = env.HOME!;
    const config = env.KIZUKI_CONFIG!;
    const vault = join(execution, "vault");
    const notes = join(execution, "notes");
    const exported = join(execution, "export");
    const restored = join(execution, "restored");
    mkdirSync(notes, { recursive: true, mode: 0o700 });
    writeFileSync(join(notes, "welcome.md"), "Ada met Grace at the library.\n", { encoding: "utf8", mode: 0o600 });

    // This isolated synthetic source receives explicit fixture consent before capture.
    const policy = join(execution, "source-policy.json");
    writeFileSync(policy, JSON.stringify({ purposes: ["capture", "recall", "session", "derive", "export"], allowed_fields: ["text", "subjects", "attachments", "metadata"], retention: "persistent_owned_until_revoked", egress: "local_only", sensitivity_floor: "private" }), { mode: 0o600 });

    run(executable, execution, env, "help", ["--help"], steps);
    run(executable, execution, env, "init", ["init", vault, "--no-service"], steps);
    for (const kind of ["cli", "mcp"] as const) {
      const binary = kind === "cli" ? "kizuki" : "kizuki-mcp";
      const command = kind === "cli" ? ["doctor", "--json", "--vault", vault] : ["--vault", vault, "--owner"];
      const step: StepReceipt = { id: `${kind}-engine`, command: [binary, ...command], exit_code: -1, passed: false, timeout_ms: CHILD_TIMEOUT_MS };
      steps.push(step);
      const result = await collectEngineProcess(join(copiedArtifact, binary), command, execution, env, kind === "mcp");
      step.exit_code = result.exit_code;
      if (kind === "cli") engineObservations.kizuki = parseDoctorObservation(result.stdout, result.exit_code, packageHashes[binary]!);
      else engineObservations.kizuki_mcp = mcpObservationFromOutput(result.stdout, packageHashes[binary]!);
      requireUnchangedPackage();
      step.passed = true;
    }
    run(executable, execution, env, "import", ["import", "markdown-folder", "--source", notes, "--policy", policy, "--expected-revision", "0", "--operation-id", "synthetic-import", "--vault", vault], steps);
    requireFixture("query-result", run(executable, execution, env, "query", ["query", "Ada", "--vault", vault], steps), steps);
    requireFixture("context-result", run(executable, execution, env, "context", ["context", "--query", "Ada", "--vault", vault], steps), steps);
    run(executable, execution, env, "export", ["export", "--out", exported, "--vault", vault], steps);
    run(executable, execution, env, "restore-verify", ["restore", "--from", exported, "--verify"], steps);
    run(executable, execution, env, "restore", ["restore", "--from", exported, "--into", restored], steps);
    if (!existsSync(join(restored, ".kizuki"))) throw new Error("restore did not create a vault");
    requireFixture("restored-query-result", run(executable, execution, env, "restored-query", ["query", "Ada", "--degraded", "--vault", restored], steps), steps);
    requireFixture("restored-context-result", run(executable, execution, env, "restored-context", ["context", "--query", "Ada", "--vault", restored], steps), steps);
    requireUnchangedPackage();

    receipt = {
      schema,
      source_sha: sourceSha,
      target: artifactTarget,
      host_platform: process.platform,
      host_arch: process.arch,
      host_kernel_release: kernelRelease(),
      binary_sha256: sha256(executable),
      bun_version: Bun.version,
      package_sha256: packageHashes,
      paths: { executable, home, config, vault, restored_vault: restored },
      steps,
      failures,
      engine_observations: engineObservations,
    };
    const checked = validateArtifactProof(receipt, {
      source_sha: sourceSha, target: artifactTarget, bun_version: build.bun_version,
      package_sha256: packageHashes as Record<(typeof packaged)[number] | "SHA256SUMS", string>,
    });
    if (checked.engine.status !== "PASS") throw new ArtifactProofError(checked.engine.reason);
  } catch (error) {
    const last = steps.at(-1);
    failures.push(error instanceof EngineProofError ? error.message : error instanceof ArtifactProofError ? error.reason :
      last?.passed === false ? `${last.id}-failed` : "artifact-proof-failed");
    receipt = {
      schema,
      source_sha: sourceSha,
      target: artifactTarget,
      host_platform: process.platform,
      host_arch: process.arch,
      host_kernel_release: kernelRelease(),
      binary_sha256: safeSha256(join(copiedArtifact, "kizuki")),
      bun_version: Bun.version,
      package_sha256: packageHashes,
      paths: {
        executable: join(copiedArtifact, "kizuki"),
        home: join(execution, "home"),
        config: join(execution, "config", "kizuki.toml"),
        vault: join(execution, "vault"),
        restored_vault: join(execution, "restored"),
      },
      steps,
      failures,
      engine_observations: engineObservations,
    };
  }

  let output: string | undefined;
  let receiptError: unknown;
  try {
    output = writeReceipt(args.report, receipt!);
  } catch (error) {
    receiptError = error;
  }
  try {
    rmSync(proofRoot, { force: true, recursive: true });
  } catch (error) {
    if (receiptError === undefined) receiptError = error;
  }
  if (receiptError !== undefined) throw receiptError;
  if (failures.length > 0) throw new Error(`artifact proof failed; receipt=${output}`);
  return output!;
}

if (import.meta.main) {
  const output = await runArtifactProof(parseProofArgs(Bun.argv.slice(2)));
  process.stdout.write(`artifact proof passed: ${output}\n`);
}
