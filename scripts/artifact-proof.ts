import { dirname, isAbsolute, join, resolve } from "node:path";
import { parseSqliteRuntime } from "../packages/core/src/ledger/runtime";
import type { SqliteRuntime } from "../packages/core/src/ledger/runtime";
import { releaseTarget } from "./release-targets";

export const ARTIFACT_PACKAGE_FILES = ["kizuki", "kizuki-mcp", "README.txt", "BUILD.json", "SHA256SUMS"] as const;
export type ArtifactPackageFile = typeof ARTIFACT_PACKAGE_FILES[number];
export type ArtifactProofSchema = "kizuki.artifact-proof/v1" | "kizuki.artifact-proof/v2";
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
  source_sha: string; target: string; bun_version: string; package_sha256: Record<ArtifactPackageFile, string>;
}
export interface EngineQualification { status: "PASS" | "MISSING" | "FAIL"; reason: string; }

/** Exact source identity checked against the official release record on 2026-09-06. */
export const SQLITE_ENGINE_POLICY = {
  schema: "kizuki.sqlite-engine-policy/v1",
  accepted: [{
    sqlite_version: "3.53.0",
    sqlite_source_id: "2026-04-09 11:41:38 4525003a53a7fc63ca75c59b22c79608659ca12f0131f52c18637f829977f20b",
    source_url: "https://www.sqlite.org/releaselog/3_53_0.html",
  }],
} as const;
export const PROOF_JSON_LIMITS = { bytes: 1_048_576, depth: 32 } as const;

export class ArtifactProofError extends Error {
  constructor(readonly reason: string) { super(reason); }
}
function reject(reason: string): never { throw new ArtifactProofError(reason); }

/** Bound decoding and nesting; JSON.parse alone loses duplicate object keys. */
export function parseProofJson(bytes: string | Uint8Array): unknown {
  try {
    if ((typeof bytes === "string" ? Buffer.byteLength(bytes) : bytes.byteLength) > PROOF_JSON_LIMITS.bytes) reject("json-byte-limit");
    const raw = typeof bytes === "string" ? bytes : new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    const stack: (Set<string> | null)[] = [];
    for (const token of raw.matchAll(/"(?:[^"\\]|\\.)*"|[{}\[\]]/g)) {
      const value = token[0];
      if (value === "{" || value === "[") {
        stack.push(value === "{" ? new Set() : null);
        if (stack.length > PROOF_JSON_LIMITS.depth) reject("json-depth-limit");
      } else if (value === "}" || value === "]") stack.pop();
      else {
        let after = token.index + value.length;
        while (after < raw.length && /\s/.test(raw[after]!)) after++;
        if (raw[after] === ":") {
          const keys = stack.at(-1), key = JSON.parse(value) as string;
          if (keys?.has(key)) reject("duplicate-json-key");
          keys?.add(key);
        }
      }
    }
    return JSON.parse(raw) as unknown;
  } catch (error) {
    if (error instanceof ArtifactProofError) throw error;
    reject("invalid-json");
  }
}

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
  if (schema !== "kizuki.artifact-proof/v1" && schema !== "kizuki.artifact-proof/v2") reject("unknown-proof-schema");
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
  if (schema === "kizuki.artifact-proof/v2") steps.splice(2, 0,
    { id: "cli-engine", command: ["kizuki", "doctor", "--json", "--vault", vault], timeout_ms: 30_000 },
    { id: "mcp-engine", command: ["kizuki-mcp", "--vault", vault, "--owner"], timeout_ms: 30_000 },
  );
  return steps;
}

/** Validate a successful recorded journey; matching observations can remain unqualified. */
export function validateArtifactProof(value: unknown, expected: ArtifactProofIdentity): { schema: ArtifactProofSchema; engine: EngineQualification } {
  const schema = value && typeof value === "object" && "schema" in value ? value.schema : null;
  if (schema !== "kizuki.artifact-proof/v1" && schema !== "kizuki.artifact-proof/v2") reject("unknown-proof-schema");
  const row = exact(value, "schema,source_sha,target,host_platform,host_arch,binary_sha256,bun_version,package_sha256,paths,steps,failures" +
    (schema === "kizuki.artifact-proof/v2" ? ",host_kernel_release,engine_observations" : ""));
  const target = releaseTarget(expected.target);
  if (digest(row.source_sha, 40) !== expected.source_sha || row.target !== target.target || row.host_platform !== target.platform || row.host_arch !== target.arch || text(row.bun_version, 64) !== expected.bun_version || digest(row.binary_sha256) !== expected.package_sha256.kizuki) reject("proof-identity-mismatch");
  const hashes = exact(row.package_sha256, ARTIFACT_PACKAGE_FILES.join());
  for (const name of ARTIFACT_PACKAGE_FILES) if (digest(hashes[name]) !== expected.package_sha256[name]) reject("proof-package-mismatch");
  if (!Array.isArray(row.failures) || row.failures.length !== 0) reject("proof-has-failures");

  let cliExit = 0;
  let engine: EngineQualification = { status: "MISSING", reason: "missing-engine-proof" };
  if (schema === "kizuki.artifact-proof/v2") {
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
    engine = SQLITE_ENGINE_POLICY.accepted.some(entry => entry.sqlite_version === cliRuntime.sqlite_version && entry.sqlite_source_id === cliRuntime.sqlite_source_id)
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
