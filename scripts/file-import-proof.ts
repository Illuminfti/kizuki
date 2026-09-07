import { createHash } from "node:crypto";
import { cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, release } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseProofJson, validateArtifactProof } from "./artifact-proof";
import { packageFiles, parseBuildInfo, requireAbsent, requireRegularFile, verifyPackageDirectory } from "./release-artifacts";
import { distributionIdentity } from "./release-notices";
import { requireNativeHost, releaseTarget } from "./release-targets";
import { proofEnvironment } from "./stranger-proof";
import { FILE_FORMATS, FILE_IMPORT_POLICY, fileImportFixtures } from "./file-import-proof-fixtures";
import type { FileCase, FileFormat } from "./file-import-proof-fixtures";

const ROOT = resolve(import.meta.dir, "..");
const PRODUCER_FILES = ["scripts/file-import-proof.ts", "scripts/file-import-proof-fixtures.ts"] as const;
const TIMEOUT = 30_000, STREAM_LIMIT = 65_536;
const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function check(ok: unknown, code: string): asserts ok { if (!ok) throw new Error(code); }
type Observation = { stored: number | null; duplicates: number | null; proposals: number | null; errors: number | null; withheld: number | null; hit_ids: string[]; consent: string | null; purge: string | null; last_run: string | null };
const empty = (): Observation => ({ stored: null, duplicates: null, proposals: null, errors: null, withheld: null, hit_ids: [], consent: null, purge: null, last_run: null });
interface Step { id: string; command: string[]; expected_exit: number; exit_code: number; passed: boolean; stdout_sha256: string; stderr_sha256: string; observation: Observation; failure: string | null; }
interface CaseReceipt { format: FileFormat; connector_id: string; source_key: string | null; invalid_source_key: string | null; expected_events: number; expected_proposals: number; expected_repeat_duplicates: number; expected_last_batch_stored: number; steps: Step[]; failures: string[]; }
export interface FileImportArgs { artifact: string; artifact_proof: string; report: string; }
export function parseFileImportArgs(argv: string[]): FileImportArgs {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]!, value = argv[i + 1];
    if (!["--artifact", "--artifact-proof", "--report"].includes(key) || values.has(key) || !value || value.startsWith("--")) throw new Error("file-import proof requires --artifact DIR --artifact-proof FILE --report NEWDIR");
    values.set(key, resolve(value));
  }
  if (values.size !== 3) throw new Error("file-import proof requires --artifact DIR --artifact-proof FILE --report NEWDIR");
  return { artifact: values.get("--artifact")!, artifact_proof: values.get("--artifact-proof")!, report: values.get("--report")! };
}
function exact(value: unknown, keys: string): Record<string, any> {
  check(value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join() === keys.split(",").sort().join(), "unexpected-object-fields");
  return value as Record<string, any>;
}
function envelope(stdout: string, command: string) {
  const body = exact(parseProofJson(stdout), "schema,status,data,degraded,warnings");
  check(body.schema === `kizuki.cli.${command}/v1` && ["ok", "degraded"].includes(body.status), "unexpected-envelope-status");
  check(Array.isArray(body.degraded) && body.degraded.every((x: unknown) => typeof x === "string") && Array.isArray(body.warnings) && body.warnings.length === 0, "unexpected-envelope-diagnostics");
  check((body.status === "ok") === (body.degraded.length === 0), "contradictory-envelope-status");
  return body;
}
export function importCounts(stdout: string, expectedStored: number, expectedErrors: number, expectedProposals = 0, expectedDuplicates = 0): Observation {
  const match = /^events_stored=(\d+) duplicates=(\d+) proposals_created=(\d+) withdrawn=(\d+) retractions_filed=(\d+) errors=(\d+)\n$/.exec(stdout);
  check(match, "import-count-shape");
  const values = match.slice(1).map(Number);
  check(values.every(Number.isSafeInteger) && values[0] === expectedStored && values[1] === expectedDuplicates && values[2] === expectedProposals && values[3] === 0 && values[4] === 0 && values[5] === expectedErrors, "unexpected-import-counts");
  return { ...empty(), stored: values[0]!, duplicates: values[1]!, proposals: values[2]!, errors: values[5]! };
}
export function queryObservation(stdout: string, stderr: string, fixture: Pick<FileCase, "connector" | "sentinel">, expected: number): Observation {
  const body = envelope(stdout, "query"), data = exact(body.data, "hits,withheld");
  check(Array.isArray(data.hits) && data.hits.length === expected && Number.isSafeInteger(data.withheld) && data.withheld >= 0, "query-cardinality");
  if (expected > 0) check(data.withheld === 0, "positive-query-withheld");
  const ids: string[] = [];
  for (const raw of data.hits) {
    const hit = exact(raw, "doc_id,scope,title,path,page_type,sensitivity,taint,authority,occurred_at,connector_id,subjects,snippet,rank");
    check(typeof hit.doc_id === "string" && hit.doc_id.startsWith("event:") && hit.scope === "ledger" && hit.connector_id === fixture.connector && hit.authority === "connector_evidence" && hit.taint === "quoted", "query-authority");
    check(typeof hit.snippet === "string" && hit.snippet.includes(fixture.sentinel) && hit.sensitivity === "private", "query-sentinel-or-sensitivity");
    check(!ids.includes(hit.doc_id), "duplicate-query-hit"); ids.push(hit.doc_id);
  }
  const expectedStderr = (data.withheld ? `withheld=${data.withheld} (excluded by access policy)\n` : "") + (body.degraded.length ? `degraded=${body.degraded.join(",")}\n` : "");
  check(stderr === expectedStderr, "unexpected-query-diagnostics");
  return { ...empty(), withheld: data.withheld, hit_ids: ids.sort() };
}
async function child(executable: string, argv: string[], cwd: string, env: Record<string, string>) {
  const proc = Bun.spawn([executable, ...argv], { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; proc.kill("SIGKILL"); }, TIMEOUT);
  const stream = async (reader: ReadableStream<Uint8Array>) => {
    const chunks: Uint8Array[] = []; let size = 0;
    for await (const chunk of reader) { size += chunk.byteLength; if (size > STREAM_LIMIT) { proc.kill("SIGKILL"); throw new Error("child-output-limit"); } chunks.push(chunk); }
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  };
  try {
    const [stdout, stderr, exit_code] = await Promise.all([stream(proc.stdout), stream(proc.stderr), proc.exited]);
    check(!timedOut, "child-timeout"); return { stdout, stderr, exit_code };
  } finally { clearTimeout(timer); if (proc.exitCode === null) proc.kill("SIGKILL"); await proc.exited; }
}
function statusObservation(stdout: string, connector: string, sourceKey: string | null, stored: number, errors: number, expectedCount = 1) {
  const body = envelope(stdout, "connect"), data = exact(body.data, "connections");
  check(body.status === "ok" && Array.isArray(data.connections) && data.connections.length === expectedCount, "connection-cardinality");
  if (expectedCount === 0) return { sourceKey: null, observation: empty() };
  const row = exact(data.connections[0], "connector_id,source_key,state,consent,revision,purge_blockers,sensitivity,last_run,stored,errors");
  check(row.connector_id === connector && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(row.source_key) && (sourceKey === null || row.source_key === sourceKey), "connection-identity");
  check(row.state === "enrolled" && row.consent === "active" && row.revision === 1 && row.purge_blockers.length === 0 && row.stored === stored && row.errors === errors, "connection-checkpoint-summary");
  check(typeof row.last_run === "string" && Number.isFinite(Date.parse(row.last_run)), "connection-last-run");
  return { sourceKey: row.source_key as string, observation: { ...empty(), stored: row.stored, errors: row.errors, consent: row.consent, last_run: row.last_run } };
}
function consentObservation(stdout: string, source: string, expected: "denied" | "purged") {
  const body = envelope(stdout, "connect"), data = exact(body.data, "source_key,receipt,grant,purge,maintenance_error");
  check(body.status === "ok" && data.source_key === source && data.maintenance_error === null && data.grant?.status === expected && data.grant.revision === (expected === "purged" ? 3 : 2), "unexpected-consent-state");
  check(data.purge === (expected === "purged" ? "complete" : "pending"), "unexpected-purge-state");
  if (expected === "purged") check(Array.isArray(data.grant.purge_blockers) && data.grant.purge_blockers.length === 0, "purge-still-blocked");
  return { ...empty(), consent: data.grant.status, purge: data.purge };
}
export function expectedFileImportSteps(fixture: FileCase): string[] {
  return ["init", "import", "query", "status", "repeat-import", "repeat-query", "repeat-status", "revoke", "revoked-query", "resume-revocation", "purged-query", "purge-status", "denied-reimport", "denied-reimport-query",
    "invalid-init", "invalid-import", "invalid-query", "invalid-status", ...(fixture.invalid_mode !== "blocked" ? ["invalid-repeat", "invalid-repeat-query", "invalid-repeat-status"] : [])];
}
export async function runFileImportProof(args: FileImportArgs): Promise<string> {
  requireAbsent(args.report); mkdirSync(args.report, { mode: 0o700 });
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), "kizuki-file-import-proof-")));
  const cases: CaseReceipt[] = [], fixtureFiles: { format: FileFormat; scenario: string; path: string; bytes: number; sha256: string }[] = [];
  const diagnostics: { format: FileFormat; step: string; stdout: string; stderr: string }[] = [], failures: string[] = [];
  const referenceDay = new Date().toISOString().slice(0, 10);
  let identity: unknown = null, sourceSha = "unavailable";
  const producerHashes = Object.fromEntries(PRODUCER_FILES.map(path => [path, hash(readFileSync(join(ROOT, path)))]));
  try {
    const git = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
    check(git.exitCode === 0, "source-revision-unavailable"); sourceSha = git.stdout.toString().trim();
    const clean = () => { const state = Bun.spawnSync(["git", "status", "--porcelain"], { cwd: ROOT, stdout: "pipe", stderr: "pipe" }); const head = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: ROOT, stdout: "pipe", stderr: "pipe" }); check(state.exitCode === 0 && state.stdout.length === 0 && head.exitCode === 0 && head.stdout.toString().trim() === sourceSha, "source-revision-dirty-or-changed"); };
    clean();
    const build = parseBuildInfo(join(args.artifact, "BUILD.json"));
    check(build.schema === "kizuki.release-build/v2" && build.source_sha === sourceSha, "artifact-source-or-version-mismatch");
    requireNativeHost(releaseTarget(build.target)); verifyPackageDirectory(args.artifact, build);
    requireRegularFile(args.artifact_proof); check(lstatSync(args.artifact_proof).size <= 1_048_576, "artifact-proof-size");
    const artifactProof = readFileSync(args.artifact_proof), names = packageFiles(build);
    const hashes = Object.fromEntries(names.map(name => [name, hash(readFileSync(join(args.artifact, name)))]));
    const validated = validateArtifactProof(parseProofJson(artifactProof), { source_sha: sourceSha, target: build.target, bun_version: build.bun_version, package_sha256: hashes as any, build });
    check(validated.schema === "kizuki.artifact-proof/v3" && validated.engine.status === "PASS", "artifact-proof-not-qualified");
    identity = { build_schema: build.schema, source_sha: build.source_sha, target: build.target, bun_version: build.bun_version, package_sha256: hashes, artifact_proof_sha256: hash(artifactProof), distribution_identity: distributionIdentity(build.distribution) };
    const copied = join(workspace, "package"); cpSync(args.artifact, copied, { recursive: true, dereference: false, errorOnExist: true });
    const unchanged = () => { check(hash(readFileSync(args.artifact_proof)) === hash(artifactProof), "artifact-proof-changed"); for (const directory of [args.artifact, copied]) { verifyPackageDirectory(directory, build); for (const name of names) check(hash(readFileSync(join(directory, name))) === hashes[name], "package-changed"); } };
    unchanged();
    const executable = join(copied, "kizuki"), fixtures = fileImportFixtures(referenceDay);
    for (const fixture of fixtures) {
      const entry: CaseReceipt = { format: fixture.format, connector_id: fixture.connector, source_key: null, invalid_source_key: null, expected_events: fixture.events, expected_proposals: fixture.proposals, expected_repeat_duplicates: fixture.repeat_duplicates, expected_last_batch_stored: fixture.last_batch_stored, steps: [], failures: [] }; cases.push(entry);
      for (const scenario of ["valid", "invalid"] as const) {
        const directory = join(workspace, fixture.format, scenario), vault = join(directory, "vault"), source = join(directory, "source", fixture.source);
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        const files = fixture[scenario];
        for (const [path, bytes] of Object.entries(files)) {
          const full = join(directory, "source", path); mkdirSync(dirname(full), { recursive: true, mode: 0o700 }); writeFileSync(full, bytes, { mode: 0o600, flag: "wx" });
          fixtureFiles.push({ format: fixture.format, scenario, path, bytes: Buffer.byteLength(bytes), sha256: hash(bytes) });
        }
        const policy = join(directory, "policy.json"), policyBytes = JSON.stringify(FILE_IMPORT_POLICY) + "\n"; writeFileSync(policy, policyBytes, { mode: 0o600 });
        fixtureFiles.push({ format: fixture.format, scenario, path: "policy.json", bytes: Buffer.byteLength(policyBytes), sha256: hash(policyBytes) });
        const env = { ...proofEnvironment(directory), TZ: "UTC" };
        const run = async (id: string, argv: string[], expectedExit: number, verify: (stdout: string, stderr: string) => Observation) => {
          const step: Step = { id, command: ["kizuki", ...argv, "--vault", vault], expected_exit: expectedExit, exit_code: -1, passed: false, stdout_sha256: hash(""), stderr_sha256: hash(""), observation: empty(), failure: null }; entry.steps.push(step);
          try {
            const result = await child(executable, [...argv, "--vault", vault], directory, env);
            step.exit_code = result.exit_code; step.stdout_sha256 = hash(result.stdout); step.stderr_sha256 = hash(result.stderr);
            try { check(result.exit_code === expectedExit, "unexpected-command-exit"); step.observation = verify(result.stdout, result.stderr); unchanged(); step.passed = true; }
            catch (error) { diagnostics.push({ format: fixture.format, step: id, stdout: result.stdout, stderr: result.stderr }); throw error; }
            return step.observation;
          } catch (error) { step.failure = error instanceof Error ? error.message : "command-failed"; throw new Error(`${id}:${step.failure}`); }
        };
        const query = (id: string, expected: number) => run(id, ["query", fixture.sentinel, "--scope", "ledger", "--json", ...(expected === 0 ? ["--degraded"] : [])], 0, (stdout, stderr) => { const observation = queryObservation(stdout, stderr, fixture, expected); if (id !== "revoked-query") check(observation.withheld === 0, "unexpected-withheld-evidence"); return observation; });
        const importArgs = ["import", fixture.connector, "--source", source];
        const grant = ["--policy", policy, "--expected-revision", "0", "--operation-id", `synthetic-${fixture.format}-${scenario}-grant`];
        const counts = (stored: number, errors: number, error?: string, proposals = 0, duplicates = 0) => (stdout: string, stderr: string) => {
          if (errors === 0) check(stderr === "", "unexpected-import-diagnostics");
          else check(stderr.includes(error!) && stderr.trim().split("\n").every(line => /^(error: |degraded: Claude health check before capture found partial or unsupported content\.$)/.test(line)), "missing-or-extra-import-error");
          return importCounts(stdout, stored, errors, proposals, duplicates);
        };
        try {
          await run(scenario === "valid" ? "init" : "invalid-init", ["init", vault, "--no-service", "--no-default"], 0, (stdout, stderr) => { check(stdout === `${vault}\nservice: opted out (--no-service)\nnext: import a file source, then query and doctor\n` && stderr === "", "unexpected-init-output"); return empty(); });
          if (scenario === "valid") {
            await run("import", [...importArgs, ...grant], 0, counts(fixture.events, 0, undefined, fixture.proposals));
            const first = await query("query", fixture.events);
            await run("status", ["connect", "status", "--json"], 0, (stdout, stderr) => { check(stderr === "", "unexpected-status-diagnostics"); const result = statusObservation(stdout, fixture.connector, null, fixture.last_batch_stored, 0); entry.source_key = result.sourceKey; return result.observation; });
            await run("repeat-import", importArgs, 0, counts(0, 0, undefined, 0, fixture.repeat_duplicates));
            const second = await query("repeat-query", fixture.events); check(JSON.stringify(first.hit_ids) === JSON.stringify(second.hit_ids), "repeat-query-identities-changed");
            await run("repeat-status", ["connect", "status", "--json"], 0, (stdout, stderr) => { check(stderr === "", "unexpected-status-diagnostics"); return statusObservation(stdout, fixture.connector, entry.source_key, 0, 0).observation; });
            const operation = `synthetic-${fixture.format}-revoke`, selector = ["--source", entry.source_key!];
            await run("revoke", ["connect", "revoke", ...selector, "--expected-revision", "1", "--operation-id", operation, "--json"], 0, (stdout, stderr) => { check(stderr === "", "unexpected-revoke-diagnostics"); return consentObservation(stdout, entry.source_key!, "denied"); });
            await query("revoked-query", 0);
            await run("resume-revocation", ["connect", "resume-revocation", ...selector, "--operation-id", operation, "--json"], 0, (stdout, stderr) => { check(stderr === "", "unexpected-purge-diagnostics"); return consentObservation(stdout, entry.source_key!, "purged"); });
            await query("purged-query", 0);
            await run("purge-status", ["connect", "status", ...selector, "--json"], 0, (stdout, stderr) => { check(stderr === "", "unexpected-purge-diagnostics"); return consentObservation(stdout, entry.source_key!, "purged"); });
            await run("denied-reimport", importArgs, 1, (stdout, stderr) => { check(stderr.includes("source_capture_denied"), "missing-capture-denial"); return importCounts(stdout, 0, 1); });
            await query("denied-reimport-query", 0);
          } else {
            await run("invalid-import", [...importArgs, ...grant], 1, fixture.invalid_mode !== "blocked" ? counts(fixture.invalid_events, 1, fixture.invalid_error, fixture.invalid_events ? fixture.proposals : 0) : (stdout, stderr) => { check(stdout === "" && stderr.includes(fixture.invalid_error) && /^error: [^\n]+\n$/.test(stderr), "malformed-source-not-refused"); return empty(); });
            const first = await query("invalid-query", fixture.invalid_events);
            await run("invalid-status", ["connect", "status", "--json"], 0, (stdout, stderr) => { check(stderr === "", "unexpected-status-diagnostics"); const result = statusObservation(stdout, fixture.connector, null, 0, 1, fixture.invalid_mode !== "blocked" ? 1 : 0); entry.invalid_source_key = result.sourceKey; return result.observation; });
            if (fixture.invalid_mode !== "blocked") {
              await run("invalid-repeat", importArgs, 1, counts(0, 1, fixture.invalid_error));
              const second = await query("invalid-repeat-query", fixture.invalid_events); check(JSON.stringify(first.hit_ids) === JSON.stringify(second.hit_ids), "partial-repeat-identities-changed");
              await run("invalid-repeat-status", ["connect", "status", "--json"], 0, (stdout, stderr) => { check(stderr === "", "unexpected-status-diagnostics"); return statusObservation(stdout, fixture.connector, entry.invalid_source_key, 0, 1).observation; });
            }
          }
        } catch (error) { entry.failures.push(`${scenario}:${error instanceof Error ? error.message : "case-failed"}`); }
      }
      check(entry.failures.length > 0 || JSON.stringify(entry.steps.map(x => x.id)) === JSON.stringify(expectedFileImportSteps(fixture)), "missing-or-extra-case-step");
    }
    unchanged(); clean();
    for (const file of fixtureFiles) {
      const path = file.path === "policy.json" ? join(workspace, file.format, file.scenario, "policy.json") : join(workspace, file.format, file.scenario, "source", file.path);
      check(hash(readFileSync(path)) === file.sha256, "fixture-source-changed");
    }
  } catch (error) { failures.push(error instanceof Error ? error.message : "file-import-proof-failed"); }
  finally { rmSync(workspace, { recursive: true, force: true }); }
  const passed = failures.length === 0 && cases.length === FILE_FORMATS.length && cases.every(x => x.failures.length === 0 && x.steps.every(step => step.passed));
  const receipt = { schema: "kizuki.file-import-fixture-proof/v1", scope: "synthetic_file_formats_only", acceptance_credit: false,
    source_sha: sourceSha, producer_files_sha256: producerHashes, host: { platform: process.platform, arch: process.arch, kernel_release: release() }, reference_day: referenceDay,
    artifact: identity, fixture_files: fixtureFiles, cases, failures, passed };
  const output = join(args.report, "receipt.json"); writeFileSync(output, JSON.stringify(receipt, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  if (diagnostics.length) writeFileSync(join(args.report, "synthetic-diagnostics.json"), JSON.stringify({ scope: "generated_synthetic_inputs_only", diagnostics }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  if (!passed) throw new Error(`file-import fixture proof failed; receipt retained at ${output}`);
  return output;
}
if (import.meta.main) {
  try { console.log(await runFileImportProof(parseFileImportArgs(process.argv.slice(2)))); }
  catch (error) { console.error(error instanceof Error ? error.message : "file-import fixture proof failed"); process.exitCode = 1; }
}
