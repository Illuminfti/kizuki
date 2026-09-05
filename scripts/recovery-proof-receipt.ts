/** Offline, closed validation of locally retained observations; no execution attestation. */
import { resolve } from "node:path";
import { PACKAGE_FILES, SUPPORTED_BUN_VERSION, digest, equalJson, exact, hash, read, reject, verifyPackage } from "./native-proof-evidence";
import { releaseTarget } from "./release-targets";
import { NATIVE_LIMITS } from "./native-proof-process";
import { RECOVERY_RECIPE, RECOVERY_RECIPE_SHA256, RECOVERY_SUBGATES, validateObservedCheck } from "./recovery-proof-recipe";
import type { ScenarioObservation } from "./recovery-proof-scenarios";

export const GENERATOR_FILES = ["scripts/recovery-artifact-proof.ts", "scripts/recovery-proof-recipe.ts", "scripts/recovery-proof-scenarios.ts", "scripts/recovery-proof-fixtures.ts", "scripts/recovery-proof-receipt.ts", "scripts/native-proof-process.ts", "scripts/native-proof-evidence.ts", "scripts/stranger-proof.ts", "scripts/release-artifacts.ts", "scripts/release-targets.ts", ".bun-version", "bun.lock"] as const;
export const SOURCE_ROOT = resolve(import.meta.dir, "..");
export function inspectSource() {
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", "-C", SOURCE_ROOT, ...args], { stdout: "pipe", stderr: "pipe", timeout: 10000 });
    if (result.exitCode !== 0 || result.stdout.length > 65536) reject("generator-source-inspection-failed"); return result.stdout.toString().trim();
  };
  return { source_sha: digest(git("rev-parse", "HEAD"), 40), source_tree_sha: digest(git("rev-parse", "HEAD^{tree}"), 40), clean: git("status", "--porcelain").length === 0 };
}
export function registeredGenerator() {
  const source = inspectSource();
  const files = Object.fromEntries(GENERATOR_FILES.map(file => {
    const actual = read(resolve(SOURCE_ROOT, file), 1048576, false);
    const blob = `${source.source_sha}:${file}`;
    const size = Bun.spawnSync(["git", "-C", SOURCE_ROOT, "cat-file", "-s", blob], { stdout: "pipe", stderr: "pipe", timeout: 10000 });
    const count = Number(size.stdout.toString().trim());
    if (size.exitCode !== 0 || !Number.isSafeInteger(count) || count < 0 || count > 1048576) reject("recovery-generator-blob-unregistered");
    const bytes = Bun.spawnSync(["git", "-C", SOURCE_ROOT, "cat-file", "blob", blob], { stdout: "pipe", stderr: "pipe", timeout: 10000 });
    if (bytes.exitCode !== 0 || bytes.stdout.length !== count || hash(bytes.stdout) !== actual.sha256) reject("recovery-generator-local-blob-mismatch");
    actual.unchanged(); return [file, actual.sha256];
  }));
  if (inspectSource().source_sha !== source.source_sha) reject("recovery-generator-source-changed");
  return { id: "scripts/recovery-artifact-proof.ts", source_sha: source.source_sha, source_tree_sha: source.source_tree_sha,
    files_sha256: files, runtime_bun_version: SUPPORTED_BUN_VERSION };
}

export interface RecoveryReceipt {
  schema: "kizuki.native-recovery-proof/v2";
  candidate: { source_sha: string; source_tree_sha: string };
  artifact: { build: ReturnType<typeof verifyPackage>["build"]; package_sha256: Record<string, string>; copied_package_sha256: Record<string, string> };
  generator: ReturnType<typeof registeredGenerator>;
  host: { platform: string; arch: string };
  scope: "synthetic-native-recovery";
  recipe: { id: string; version: number; sha256: string };
  observation: { started_at: string; ended_at: string; elapsed_ms: number };
  scenarios: ScenarioObservation[];
  completion: { state: "complete" | "failed"; cleanup: "complete" | "failed" };
}
function same(actual: unknown, expected: unknown, reason: string) { if (!equalJson(actual, expected)) reject(reason); }
function processObservation(value: unknown, expectedExit: number) {
  const row = exact(value, "exit_code,wall_ms,fault,stdout_bytes,stderr_bytes,stdout_sha256,stderr_sha256");
  if (row.exit_code !== expectedExit || row.fault !== null || !Number.isSafeInteger(row.wall_ms) || (row.wall_ms as number) < 0 || (row.wall_ms as number) > NATIVE_LIMITS.timeout_ms + 1000) reject("recovery-command-failed");
  for (const [name, limit] of [["stdout_bytes", NATIVE_LIMITS.stdout_bytes], ["stderr_bytes", NATIVE_LIMITS.stderr_bytes]] as const) {
    if (!Number.isSafeInteger(row[name]) || (row[name] as number) < 0 || (row[name] as number) > limit) reject("recovery-command-overflow");
  }
  digest(row.stdout_sha256); digest(row.stderr_sha256);
}
export function validateScenarioObservation(value: unknown, index: number): void {
  const row = exact(value, "id,fixtures,commands,tools,sessions,checks,failure"), recipe = RECOVERY_RECIPE.scenarios[index];
  if (!recipe || row.id !== recipe.id || row.failure !== null) reject("recovery-scenario-incomplete");
  const sequence: number[] = [];
  const addSequence = (row: Record<string, unknown>) => { if (!Number.isSafeInteger(row.sequence) || (row.sequence as number) < 1) reject("recovery-order-invalid"); sequence.push(row.sequence as number); };
  const rows = (name: string, length: number): unknown[] => { const items = row[name]; if (!Array.isArray(items) || items.length !== length) reject("recovery-operation-set-mismatch"); return items; };
  let previous = 0;
  for (const [i, value] of rows("fixtures", recipe.fixtures.length).entries()) {
    const item = exact(value, "sequence,id,action,target,observation"); addSequence(item); const expected = recipe.fixtures[i]!;
    if (item.action !== expected.action || item.target !== expected.target || (expected.action === null && item.observation !== null)) reject("recovery-fixture-set-mismatch");
    if (expected.action !== null) processObservation(item.observation, 0);
    if (item.id !== expected.id || (item.sequence as number) <= previous) reject("recovery-fixture-set-mismatch"); previous = item.sequence as number;
  }
  previous = 0;
  for (const [i, value] of rows("commands", recipe.commands.length).entries()) {
    const item = exact(value, "sequence,id,template,target,observation"), expected = recipe.commands[i]!; addSequence(item);
    if (item.id !== expected.id || item.target !== expected.target || (item.sequence as number) <= previous) reject("recovery-command-substituted"); previous = item.sequence as number;
    same(item.template, expected.args, "recovery-command-substituted"); processObservation(item.observation, expected.expected_exit);
  }
  previous = 0;
  for (const [i, value] of rows("tools", recipe.tools.length).entries()) {
    const item = exact(value, "sequence,id,session,request_id,name,arguments,response_sha256"), expected = recipe.tools[i]!; addSequence(item);
    if (item.id !== expected.id || item.name !== expected.name || item.session !== 1 || item.request_id !== i + 2 || (item.sequence as number) <= previous) reject("recovery-retained-session-mismatch"); previous = item.sequence as number;
    same(item.arguments, expected.arguments, "recovery-tool-substituted"); digest(item.response_sha256);
  }
  for (const value of rows("sessions", recipe.tools.length ? 1 : 0)) {
    const item = exact(value, "sequence,ordinal,request_ids,observation"); addSequence(item);
    if (item.ordinal !== 1) reject("recovery-retained-session-mismatch"); same(item.request_ids, Array.from({ length: recipe.tools.length + 1 }, (_, i) => i + 1), "recovery-retained-session-mismatch");
    // Session duration spans intervening bounded CLI operations; its close and
    // every request have their own fixed deadlines, not one lifetime deadline.
    const observation = exact(item.observation, "exit_code,wall_ms,fault,stdout_bytes,stderr_bytes,stdout_sha256,stderr_sha256");
    if (!Number.isSafeInteger(observation.wall_ms) || (observation.wall_ms as number) < 0 || (observation.wall_ms as number) > 1800000) reject("recovery-session-duration-invalid");
    processObservation({ ...observation, wall_ms: 0 }, 0);
  }
  previous = 0;
  for (const [i, value] of rows("checks", recipe.checks.length).entries()) {
    const item = exact(value, "sequence,id,observed"); addSequence(item);
    if (item.id !== recipe.checks[i]!.id || (item.sequence as number) <= previous) reject("recovery-assertion-set-mismatch"); previous = item.sequence as number;
    validateObservedCheck(recipe, { id: item.id as string, observed: item.observed });
  }
  same(sequence.sort((a, b) => a - b), Array.from({ length: sequence.length }, (_, i) => i + 1), "recovery-order-invalid");
  const typed = value as ScenarioObservation;
  if (recipe.id === "revocation-retained-consumers") {
    const cli = (id: string) => typed.commands.find(row => row.id === id)!.sequence, tool = (id: string) => typed.tools.find(row => row.id === id)!.sequence;
    const order = [cli("engine-rebuild"), tool("positive-search"), tool("positive-independent"), tool("positive-context"), cli("revoke"), tool("denied-search"), tool("denied-context"), tool("retained-independent"), cli("resume-busy"), tool("pending-search"), typed.sessions[0]!.sequence, cli("resume-fresh")];
    if (order.some((number, i) => i > 0 && number <= order[i - 1]!)) reject("recovery-retained-session-order-invalid");
  }
  if (recipe.id === "pending-decision-restore") {
    const fact = (id: string) => typed.checks.find(row => row.id === id)!.observed as Record<string, unknown>;
    const first = fact("replay-state"), retry = fact("retry-state");
    for (const field of ["claim_sha256", "receipt_sha256", "provenance_sha256", "expected_provenance_sha256", "deferred_ids_sha256", "expected_deferred_ids_sha256"]) same(first[field], retry[field], "recovery-retry-identity-mismatch");
    for (const [id, field] of [["stable-claim", "claim_sha256"], ["stable-receipt", "receipt_sha256"], ["stable-provenance", "provenance_sha256"]]) {
      const pair = fact(id!); if (pair.before_sha256 !== first[field!] || pair.after_sha256 !== retry[field!]) reject("recovery-retry-identity-mismatch");
    }
    same(fact("exported-journal"), fact("restored-journal"), "recovery-journal-mismatch");
  }
}
export function validateRecoveryReceipt(value: unknown, artifact: ReturnType<typeof verifyPackage>, generator = registeredGenerator()): RecoveryReceipt {
  const row = exact(value, "schema,candidate,artifact,generator,host,scope,recipe,observation,scenarios,completion");
  const candidate = exact(row.candidate, "source_sha,source_tree_sha"), target = releaseTarget(artifact.build.target);
  if (row.schema !== "kizuki.native-recovery-proof/v2" || row.scope !== RECOVERY_RECIPE.scope || candidate.source_sha !== artifact.build.source_sha || candidate.source_sha !== generator.source_sha || candidate.source_tree_sha !== generator.source_tree_sha) reject("recovery-candidate-mismatch");
  same(exact(row.generator, "id,source_sha,source_tree_sha,files_sha256,runtime_bun_version"), generator, "recovery-generator-mismatch");
  const supplied = exact(row.artifact, "build,package_sha256,copied_package_sha256");
  same(supplied.build, artifact.build, "recovery-artifact-mismatch");
  for (const field of ["package_sha256", "copied_package_sha256"]) {
    const hashes = exact(supplied[field], PACKAGE_FILES.join());
    for (const file of PACKAGE_FILES) if (hashes[file] !== artifact.package_sha256[file]) reject("recovery-artifact-mismatch");
  }
  same(exact(row.host, "platform,arch"), { platform: target.platform, arch: target.arch }, "recovery-native-host-mismatch");
  same(exact(row.recipe, "id,version,sha256"), { id: RECOVERY_RECIPE.id, version: RECOVERY_RECIPE.version, sha256: RECOVERY_RECIPE_SHA256 }, "recovery-recipe-mismatch");
  const observation = exact(row.observation, "started_at,ended_at,elapsed_ms");
  if (typeof observation.started_at !== "string" || typeof observation.ended_at !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(observation.started_at) || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(observation.ended_at)) reject("recovery-observation-invalid");
  const start = Date.parse(observation.started_at), end = Date.parse(observation.ended_at), elapsed = observation.elapsed_ms;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || !Number.isSafeInteger(elapsed) || (elapsed as number) < 0 || (elapsed as number) > 3600000 || Math.abs(end - start - (elapsed as number)) > 30000) reject("recovery-observation-invalid");
  if (!Array.isArray(row.scenarios) || row.scenarios.length !== RECOVERY_RECIPE.scenarios.length) reject("recovery-scenario-set-mismatch");
  for (const [index, scenario] of row.scenarios.entries()) validateScenarioObservation(scenario, index);
  same(exact(row.completion, "state,cleanup"), { state: "complete", cleanup: "complete" }, "recovery-incomplete");
  artifact.unchanged(); return value as RecoveryReceipt;
}
export function verifiedRecoveryCredit(receipt: RecoveryReceipt, receiptSha256: string) {
  return { target: receipt.artifact.build.target, producer: receipt.schema, producer_revision: receipt.generator.source_sha,
    scope: "synthetic-native-observation", receipt_sha256: receiptSha256, package_sha256: receipt.artifact.package_sha256,
    subgates: [...RECOVERY_SUBGATES], observation_interval: receipt.observation, calendar_credit_ms: 0 };
}
