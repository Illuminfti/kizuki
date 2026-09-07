import { CURRENT_PACKAGE_FILES, LEGACY_PACKAGE_FILES, parseBuildInfoValue, type BuildInfo } from "./release-artifacts";
import { distributionIdentity } from "./release-notices";
import { ArtifactProofError } from "./proof-json";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parseSqliteRuntime } from "../packages/core/src/ledger/runtime";
import type { SqliteRuntime } from "../packages/core/src/ledger/runtime";
import { releaseTarget } from "./release-targets";

export const ARTIFACT_PACKAGE_FILES = LEGACY_PACKAGE_FILES;
export const ARTIFACT_PACKAGE_FILES_V3 = CURRENT_PACKAGE_FILES;
export type ArtifactPackageFile = typeof ARTIFACT_PACKAGE_FILES[number];
export type ArtifactProofSchema = "kizuki.artifact-proof/v1" | "kizuki.artifact-proof/v2" | "kizuki.artifact-proof/v3";
export interface ArtifactProofPaths { executable: string; home: string; config: string; vault: string; restored_vault: string; }
export interface ArtifactProofStep { id: string; command: string[]; timeout_ms: number; }
export interface CliEngineObservation {
  executable_sha256: string; runtime: SqliteRuntime; exit_code: 0 | 1; doctor_status: "ok" | "error";
}
export interface McpEngineObservation {
  executable_sha256: string; runtime: SqliteRuntime; exit_code: 0; mcp_is_error: false;
}
export interface EngineObservations { kizuki: CliEngineObservation | null; kizuki_mcp: McpEngineObservation | null; }
export interface ArtifactProofIdentity {
  source_sha: string; target: string; bun_version: string; package_sha256: Record<ArtifactPackageFile, string> & Partial<Record<"LICENSE" | "THIRD-PARTY-NOTICES.txt", string>>; build?: BuildInfo;
}
export interface EngineQualification { status: "PASS" | "MISSING" | "FAIL"; reason: string; }

/** Exact upstream or native-vendor observations; never a version-range exemption. */
export const SQLITE_ENGINE_POLICY = {
  schema: "kizuki.sqlite-engine-policy/v2",
  accepted: [{
    targets: ["bun-linux-x64-baseline", "bun-darwin-arm64"],
    sqlite_version: "3.53.0",
    sqlite_source_id: "2026-04-09 11:41:38 4525003a53a7fc63ca75c59b22c79608659ca12f0131f52c18637f829977f20b",
    source_url: "https://www.sqlite.org/releaselog/3_53_0.html",
  }, {
    targets: ["bun-darwin-arm64"],
    bun_version: "1.3.14",
    host_kernel_release: "24.6.0",
    sqlite_version: "3.43.2",
    sqlite_source_id: "2023-10-10 13:08:14 1b37c146ee9ebb7acd0160c0ab1fd11017a419fa8a3187386ed8cb32b709aapl",
    source_url: "https://api.github.com/repositories/1353875622/actions/jobs/101692661138/logs",
    evidence: "docs/sqlite-vendor-qualification.md",
  }],
} as const;
export { ArtifactProofError, PROOF_JSON_LIMITS, parseProofJson } from "./proof-json";
function reject(reason: string): never { throw new ArtifactProofError(reason); }

function exact(value: unknown, keys: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) reject("invalid-proof-schema");
  const fields = keys.split(",");
  if (Object.keys(value).length !== fields.length || fields.some(field => !Object.hasOwn(value, field))) reject("invalid-proof-schema");
  return value as Record<string, unknown>;
}
function text(value: unknown, limit = 4096): string {
  if (typeof value !== "string" || !value.length || value.length > limit || /[\x00-\x1f\x7f]/.test(value)) reject("invalid-proof-string");
  return value;
}
function digest(value: unknown, length = 64): string {
  if (typeof value !== "string" || value.length !== length || !/^[a-f0-9]+$/.test(value)) reject("invalid-proof-digest");
  return value;
}
function runtime(value: unknown): SqliteRuntime {
  try { return parseSqliteRuntime(value); } catch { reject("invalid-runtime-observation"); }
}

/** One ordered command contract for both consumers and the producer's checks. */
export function artifactProofSteps(schema: ArtifactProofSchema, paths: ArtifactProofPaths): ArtifactProofStep[] {
  if (schema !== "kizuki.artifact-proof/v1" && schema !== "kizuki.artifact-proof/v2" && schema !== "kizuki.artifact-proof/v3") reject("unknown-proof-schema");
  exact(paths, "executable,home,config,vault,restored_vault");
  for (const value of Object.values(paths)) {
    const path = text(value);
    if (!isAbsolute(path) || resolve(path) !== path) reject("noncanonical-proof-path");
  }
  const vault = paths.vault, execution = dirname(vault), root = dirname(execution);
  const restored = join(execution, "restored"), exported = join(execution, "export");
  if (vault !== join(execution, "vault") || paths.home !== join(execution, "home") || paths.config !== join(execution, "config/kizuki.toml") || paths.restored_vault !== restored || paths.executable !== join(root, "artifact/kizuki") || execution !== join(root, "execution")) reject("proof-isolation-mismatch");
  const commands: [string, string[]][] = [
    ["help", ["--help"]], ["init", ["init", vault, "--no-service"]],
    ["import", ["import", "markdown-folder", "--source", join(execution, "notes"), "--policy", join(execution, "source-policy.json"), "--expected-revision", "0", "--operation-id", "synthetic-import", "--vault", vault]],
    ["query", ["query", "Ada", "--vault", vault]], ["query-result", []],
    ["context", ["context", "--query", "Ada", "--vault", vault]], ["context-result", []],
    ["export", ["export", "--out", exported, "--vault", vault]], ["restore-verify", ["restore", "--from", exported, "--verify"]],
    ["restore", ["restore", "--from", exported, "--into", restored]],
    ["restored-query", ["query", "Ada", "--degraded", "--vault", restored]], ["restored-query-result", []],
    ["restored-context", ["context", "--query", "Ada", "--vault", restored]], ["restored-context-result", []],
  ];
  const steps = commands.map(([id, args]) => ({ id, command: args.length ? ["kizuki", ...args] : ["assert", "fixture is recalled"], timeout_ms: args.length ? 30_000 : 0 }));
  if (schema !== "kizuki.artifact-proof/v1") steps.splice(2, 0,
    { id: "cli-engine", command: ["kizuki", "doctor", "--json", "--vault", vault], timeout_ms: 30_000 },
    { id: "mcp-engine", command: ["kizuki-mcp", "--vault", vault, "--owner"], timeout_ms: 30_000 },
  );
  return steps;
}

/** Validate a successful recorded journey; matching observations can remain unqualified. */
export function validateArtifactProof(value: unknown, expected: ArtifactProofIdentity): { schema: ArtifactProofSchema; engine: EngineQualification } {
  const schema = value && typeof value === "object" && "schema" in value ? value.schema : null;
  if (schema !== "kizuki.artifact-proof/v1" && schema !== "kizuki.artifact-proof/v2" && schema !== "kizuki.artifact-proof/v3") reject("unknown-proof-schema");
  const row = exact(value, "schema,source_sha,target,host_platform,host_arch,binary_sha256,bun_version,package_sha256,paths,steps,failures" +
    (schema !== "kizuki.artifact-proof/v1" ? ",host_kernel_release,engine_observations" : "") +
    (schema === "kizuki.artifact-proof/v3" ? ",distribution_identity" : ""));
  const target = releaseTarget(expected.target);
  if (digest(row.source_sha, 40) !== expected.source_sha || row.target !== target.target || row.host_platform !== target.platform || row.host_arch !== target.arch || text(row.bun_version, 64) !== expected.bun_version || digest(row.binary_sha256) !== expected.package_sha256.kizuki) reject("proof-identity-mismatch");
  if (expected.build && (expected.build.source_sha !== expected.source_sha || expected.build.target !== expected.target || expected.build.bun_version !== expected.bun_version)) reject("proof-build-identity-mismatch");
  const files = schema === "kizuki.artifact-proof/v3" ? CURRENT_PACKAGE_FILES : LEGACY_PACKAGE_FILES;
  if (schema === "kizuki.artifact-proof/v3") {
    if (!expected.build || parseBuildInfoValue(expected.build).schema !== "kizuki.release-build/v2" || expected.build.schema !== "kizuki.release-build/v2") reject("proof-build-version-mismatch");
    const identity = exact(row.distribution_identity, "build_schema,inventory_sha256"), wanted = distributionIdentity(expected.build.distribution);
    if (identity.build_schema !== wanted.build_schema || digest(identity.inventory_sha256) !== wanted.inventory_sha256) reject("proof-distribution-mismatch");
  } else if (expected.build?.schema === "kizuki.release-build/v2") reject("proof-build-version-mismatch");
  const hashes = exact(row.package_sha256, files.join());
  for (const name of files) if (digest(hashes[name]) !== expected.package_sha256[name]) reject("proof-package-mismatch");
  if (!Array.isArray(row.failures) || row.failures.length !== 0) reject("proof-has-failures");

  let cliExit = 0;
  let engine: EngineQualification = { status: "MISSING", reason: "missing-engine-proof" };
  if (schema !== "kizuki.artifact-proof/v1") {
    const kernel = text(row.host_kernel_release, 256);
    if (kernel.trim() !== kernel || /[^\x20-\x7e]/.test(kernel)) reject("invalid-kernel-release");
    const observations = exact(row.engine_observations, "kizuki,kizuki_mcp");
    if (observations.kizuki === null || observations.kizuki_mcp === null) reject("missing-engine-observation");
    const cli = exact(observations.kizuki, "executable_sha256,runtime,exit_code,doctor_status");
    const mcp = exact(observations.kizuki_mcp, "executable_sha256,runtime,exit_code,mcp_is_error");
    if (!((cli.exit_code === 0 && cli.doctor_status === "ok") || (cli.exit_code === 1 && cli.doctor_status === "error")) || mcp.exit_code !== 0 || mcp.mcp_is_error !== false) reject("invalid-engine-outcome");
    if (digest(cli.executable_sha256) !== expected.package_sha256.kizuki || digest(mcp.executable_sha256) !== expected.package_sha256["kizuki-mcp"]) reject("engine-executable-mismatch");
    const cliRuntime = runtime(cli.runtime), mcpRuntime = runtime(mcp.runtime);
    if (cliRuntime.bun_version !== expected.bun_version || mcpRuntime.bun_version !== expected.bun_version) reject("engine-bun-mismatch");
    if (cliRuntime.sqlite_version !== mcpRuntime.sqlite_version || cliRuntime.sqlite_source_id !== mcpRuntime.sqlite_source_id) reject("engine-sqlite-mismatch");
    cliExit = cli.exit_code as 0 | 1;
    engine = SQLITE_ENGINE_POLICY.accepted.some(entry => entry.targets.some(admitted => admitted === expected.target) &&
      (!("bun_version" in entry) || entry.bun_version === cliRuntime.bun_version) &&
      (!("host_kernel_release" in entry) || entry.host_kernel_release === kernel) &&
      entry.sqlite_version === cliRuntime.sqlite_version && entry.sqlite_source_id === cliRuntime.sqlite_source_id)
      ? { status: "PASS", reason: "effective-sqlite-identity-qualified" }
      : { status: "FAIL", reason: "unqualified-sqlite-identity" };
  }
  const steps = artifactProofSteps(schema, exact(row.paths, "executable,home,config,vault,restored_vault") as unknown as ArtifactProofPaths);
  if (!Array.isArray(row.steps) || row.steps.length !== steps.length) reject("proof-step-set-mismatch");
  for (const [index, expectedStep] of steps.entries()) {
    const step = exact(row.steps[index], "id,command,exit_code,passed,timeout_ms");
    const exit = expectedStep.id === "cli-engine" ? cliExit : 0;
    if (step.id !== expectedStep.id || step.passed !== true || step.exit_code !== exit || step.timeout_ms !== expectedStep.timeout_ms ||
        !Array.isArray(step.command) || step.command.length !== expectedStep.command.length ||
        step.command.some((part, index) => part !== expectedStep.command[index])) reject("proof-step-failed-or-substituted");
  }
  return { schema, engine };
}
