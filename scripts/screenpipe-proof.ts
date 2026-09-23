/**
 * Copied-package local-source proof for `kizuki.screenpipe`.
 *
 * Screenpipe is the one connector in the frozen C3 catalogue whose evidence
 * class is neither a file import nor a live account: it is an offline read of a
 * stopped local SQLite database. This harness builds such a database from
 * synthetic rows, drives the compiled CLI through enrolment, consent, backfill,
 * sync, export, revoke and physical purge, and emits the acceptance receipt.
 *
 * It binds no socket. Everything it touches is a temporary directory it made.
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { Database } from "bun:sqlite";
import { tmpdir, release } from "node:os";
import { join, resolve } from "node:path";
import { requireAbsent } from "./release-artifacts";
import { proofEnvironment } from "./stranger-proof";
import { artifactCustody, check, child, consentObservation, empty, envelope, exact, hash, queryObservation, sourceRevision } from "./file-import-proof";
import type { Observation, Step } from "./file-import-proof";
import { FILE_IMPORT_POLICY } from "./file-import-proof-fixtures";
import {
  SCREENPIPE_AUDIO_SENTINEL, SCREENPIPE_CONNECTOR_ID, SCREENPIPE_CREDENTIAL_SEGMENT, SCREENPIPE_EXPECTED,
  SCREENPIPE_REDACTION_MARKER, SCREENPIPE_SENTINEL, SCREENPIPE_SITE_SENTINEL, screenpipeFixtureShapes, writeScreenpipeFixture,
} from "./screenpipe-proof-fixtures";
import { buildConnectorEvidenceReceipt, connectorProducerRevision, writeConnectorEvidence } from "./connector-evidence";
import type { ConnectorEvidenceEmission, ConnectorEvidenceReceipt } from "./connector-evidence";

const ROOT = resolve(import.meta.dir, "..");
const PRODUCER_FILES = ["scripts/screenpipe-proof.ts", "scripts/screenpipe-proof-fixtures.ts"] as const;

export interface ScreenpipeProofArgs { artifact: string; artifact_proof: string; report: string }
export function parseScreenpipeArgs(argv: string[]): ScreenpipeProofArgs {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]!, value = argv[i + 1];
    if (!["--artifact", "--artifact-proof", "--report"].includes(key) || values.has(key) || !value || value.startsWith("--")) throw new Error("screenpipe proof requires --artifact DIR --artifact-proof FILE --report NEWDIR");
    values.set(key, resolve(value));
  }
  if (values.size !== 3) throw new Error("screenpipe proof requires --artifact DIR --artifact-proof FILE --report NEWDIR");
  return { artifact: values.get("--artifact")!, artifact_proof: values.get("--artifact-proof")!, report: values.get("--report")! };
}

/** The whole local-source arc, in the order the harness must observe it. */
export function expectedScreenpipeSteps(): string[] {
  return [
    "init", "connect", "grant", "backfill", "query", "export", "repeat-backfill", "sync", "repeat-query", "status",
    "revoke", "revoked-query", "resume-revocation", "purged-query", "purge-status", "denied-backfill",
    "locked-init", "locked-connect", "below-floor-init", "below-floor-connect", "below-floor-status",
    "malformed-init", "malformed-connect", "malformed-status",
  ];
}

/** `connect <connector> --source PATH` prints one enrolment line plus the consent hint. */
export function connectObservation(stdout: string, stderr: string, databasePath: string): { sourceKey: string; observation: Observation } {
  check(stderr === "", "unexpected-connect-diagnostics");
  const lines = stdout.split("\n");
  check(lines.pop() === "" && lines.length === 2, "unexpected-connect-output");
  const match = /^connected (\S+) source=([0-9A-HJKMNP-TV-Z]{26}) path=(\S+) health=(ok|degraded)$/.exec(lines[0]!);
  check(match && match[1] === SCREENPIPE_CONNECTOR_ID && match[3] === databasePath, "unexpected-connect-identity");
  check(lines[1] === `consent-required: kizuki connect grant --source ${match![2]} --policy POLICY.json --expected-revision 0 --operation-id UNIQUE_ID`, "missing-consent-hint");
  return { sourceKey: match![2]!, observation: { ...empty(), consent: "required" } };
}

/**
 * Enrolment must refuse with the connector's own message and nothing on stdout.
 * A locked database, a database below the supported migration floor and a
 * database whose capture tables do not match the contract each fail here,
 * before a connection row or a single event exists.
 */
export function refusalObservation(stdout: string, stderr: string, detail: string): Observation {
  check(stdout === "", "unexpected-refusal-stdout");
  check(stderr.startsWith("error: ") && stderr.endsWith("\n") && stderr.slice(0, -1).split("\n").length === 1, "unexpected-refusal-shape");
  check(stderr.includes(detail), "unexpected-refusal-detail");
  return { ...empty(), degraded: [detail] };
}

/** `backfill`/`sync` print one run-count line; any error text is explicit. */
export function runCounts(stdout: string, stderr: string, expected: { stored: number; duplicates: number; proposals: number; errors: readonly string[]; degraded: readonly string[] }): Observation {
  const match = /^(?:kizuki\.screenpipe source=[0-9A-HJKMNP-TV-Z]{26} )?events_stored=(\d+) duplicates=(\d+) proposals_created=(\d+) withdrawn=(\d+) retractions_filed=(\d+) errors=(\d+)\n$/.exec(stdout);
  check(match, "run-count-shape");
  const values = match!.slice(1).map(Number);
  check(values.every(Number.isSafeInteger), "run-count-shape");
  check(values[0] === expected.stored && values[1] === expected.duplicates && values[2] === expected.proposals, "unexpected-run-counts");
  check(values[3] === 0 && values[4] === 0 && values[5] === expected.errors.length, "unexpected-run-counts");
  const lines = stderr === "" ? [] : stderr.split("\n");
  if (lines.length > 0) check(lines.pop() === "", "unexpected-run-diagnostics");
  const errorLines = lines.filter(line => line.startsWith("error: "));
  check(errorLines.length === expected.errors.length && expected.errors.every(text => errorLines.some(line => line.includes(text))), "unexpected-run-diagnostics");
  const degradedLines = lines.filter(line => line.startsWith("degraded: "));
  check(degradedLines.every(line => expected.degraded.some(code => line.includes(code))), "unexpected-run-diagnostics");
  const rest = lines.filter(line => !line.startsWith("error: ") && !line.startsWith("degraded: "));
  check(rest.every(line => line.startsWith("source consent denied") || line.startsWith("consent-required: ")), "unexpected-run-diagnostics");
  return { ...empty(), stored: values[0]!, duplicates: values[1]!, proposals: values[2]!, errors: values[5]! };
}

/**
 * The exported ledger is the public seam that shows what was stored. A
 * credential-shaped path segment must be gone from every event, and the
 * connector's documented redaction marker must record that it was dropped.
 */
export function exportObservation(stdout: string, stderr: string, directory: string): Observation {
  check(stderr === "", "unexpected-export-diagnostics");
  const lines = stdout.split("\n");
  check(lines.pop() === "" && lines.length === 3, "unexpected-export-output");
  check(lines[0] === `manifest=${directory}/manifest.json`, "unexpected-export-output");
  check(/^schema=\S+ complete=true$/.test(lines[1]!), "incomplete-export");
  const events = readFileSync(join(directory, "ledger", "events.jsonl"), "utf8").split("\n").filter(line => line !== "");
  check(events.length === SCREENPIPE_EXPECTED.backfill_stored, "unexpected-exported-event-count");
  const body = events.join("\n");
  check(!body.includes(SCREENPIPE_CREDENTIAL_SEGMENT), "credential-shaped-value-retained");
  check(body.includes(SCREENPIPE_REDACTION_MARKER), "credential-drop-not-recorded");
  for (const sentinel of [SCREENPIPE_SENTINEL, SCREENPIPE_SITE_SENTINEL, SCREENPIPE_AUDIO_SENTINEL]) check(body.includes(sentinel), "missing-exported-evidence");
  return { ...empty(), stored: events.length };
}

/** After purge the unchanged source must be refused capture, not swept again. */
export function deniedCaptureObservation(stdout: string, stderr: string, source: string): Observation {
  check(stdout === "", "unexpected-denial-stdout");
  check(stderr === `error: source_capture_denied; consent-required: kizuki connect grant --source ${source} --policy POLICY.json --expected-revision 3 --operation-id UNIQUE_ID\n`, "missing-or-extra-capture-denial");
  return { ...empty(), consent: "denied" };
}

export function statusCount(stdout: string, stderr: string, expected: number): Observation {
  check(stderr === "", "unexpected-status-diagnostics");
  const body = envelope(stdout, "connect"), data = exact(body.data, "connections");
  check(Array.isArray(data.connections) && data.connections.length === expected, "connection-cardinality");
  return { ...empty(), stored: data.connections.length };
}

export function enrolledStatus(stdout: string, stderr: string, source: string, stored: number): Observation {
  check(stderr === "", "unexpected-status-diagnostics");
  const body = envelope(stdout, "connect"), data = exact(body.data, "connections");
  check(Array.isArray(data.connections) && data.connections.length === 1, "connection-cardinality");
  const row = exact(data.connections[0], "connector_id,source_key,state,consent,revision,purge_blockers,sensitivity,last_run,stored,errors");
  check(row.connector_id === SCREENPIPE_CONNECTOR_ID && row.source_key === source, "connection-identity");
  check(row.state === "enrolled" && row.consent === "active" && row.revision === 1 && row.purge_blockers.length === 0, "connection-checkpoint-summary");
  check(row.sensitivity === "private" && row.stored === stored && row.errors === 0, "connection-checkpoint-summary");
  check(typeof row.last_run === "string" && Number.isFinite(Date.parse(row.last_run)), "connection-last-run");
  return { ...empty(), stored: row.stored, errors: row.errors, consent: row.consent, last_run: row.last_run };
}

export function grantObservation(stdout: string, stderr: string, source: string, operation: string): Observation {
  check(stderr === "", "unexpected-grant-diagnostics");
  const body = envelope(stdout, "connect"), data = exact(body.data, "source_key,receipt,grant,purge,maintenance_error");
  check(body.status === "ok" && data.source_key === source && data.maintenance_error === null && data.purge === "not_requested", "unexpected-grant-state");
  check(data.grant?.status === "active" && data.grant.revision === 1 && data.grant.connector_id === SCREENPIPE_CONNECTOR_ID, "unexpected-grant-state");
  const receipt = exact(data.receipt, "operation_id,source_key,action,prior_revision,revision,status,at,policy_digest");
  check(receipt.operation_id === operation && receipt.source_key === source && receipt.action === "grant" && receipt.prior_revision === 0 && receipt.revision === 1 && receipt.status === "active", "contradictory-grant-receipt");
  return { ...empty(), consent: "active" };
}

const TIMEOUT_EXIT = -1;
/** Substrings the connector's own refusals must carry, one per denial shape. */
export const SCREENPIPE_REFUSALS = {
  locked: "screenpipe database is locked",
  "below-floor": "schema older than supported",
  malformed: "screenpipe schema mismatch: missing",
} as const;

export async function runScreenpipeProof(args: ScreenpipeProofArgs): Promise<string> {
  requireAbsent(args.report); mkdirSync(args.report, { mode: 0o700 });
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), "kizuki-screenpipe-proof-")));
  const steps: Step[] = [], failures: string[] = [];
  const diagnostics: { step: string; stdout: string; stderr: string }[] = [];
  const fixtureFiles: { shape: string; path: string; bytes: number; sha256: string }[] = [];
  let identity: unknown = null, sourceSha = "unavailable", sourceKey: string | null = null;
  const producerHashes = Object.fromEntries(PRODUCER_FILES.map(path => [path, hash(readFileSync(join(ROOT, path)))]));
  let locker: Database | null = null;
  try {
    const revision = sourceRevision(ROOT); sourceSha = revision.source_sha; revision.clean();
    const custody = artifactCustody(args.artifact, args.artifact_proof, sourceSha, workspace);
    identity = custody.identity;
    const executable = custody.executable;

    const scenarios = new Map<string, { directory: string; vault: string; database: string; env: Record<string, string> }>();
    for (const row of screenpipeFixtureShapes()) for (const name of row.shape === "valid" ? ["valid", "locked"] : [row.shape]) {
      const directory = join(workspace, name), vault = join(directory, "vault"), database = join(directory, "source", "db.sqlite");
      mkdirSync(join(directory, "source"), { recursive: true, mode: 0o700 });
      writeScreenpipeFixture(database, row.shape);
      const bytes = readFileSync(database);
      fixtureFiles.push({ shape: name, path: "source/db.sqlite", bytes: bytes.byteLength, sha256: hash(bytes) });
      scenarios.set(name, { directory, vault, database, env: { ...proofEnvironment(directory), TZ: "UTC" } });
    }
    const policy = join(workspace, "policy.json"), policyBytes = JSON.stringify(FILE_IMPORT_POLICY) + "\n";
    writeFileSync(policy, policyBytes, { mode: 0o600 });
    fixtureFiles.push({ shape: "shared", path: "policy.json", bytes: Buffer.byteLength(policyBytes), sha256: hash(policyBytes) });

    const run = async (id: string, scenario: string, argv: string[], expectedExit: number, verify: (stdout: string, stderr: string) => Observation) => {
      const target = scenarios.get(scenario)!;
      const full = [...argv, "--vault", target.vault];
      const step: Step = { id, command: ["kizuki", ...full], expected_exit: expectedExit, exit_code: TIMEOUT_EXIT, passed: false, stdout_sha256: hash(""), stderr_sha256: hash(""), observation: empty(), failure: null };
      steps.push(step);
      try {
        const result = await child(executable, full, target.directory, target.env);
        step.exit_code = result.exit_code; step.stdout_sha256 = hash(result.stdout); step.stderr_sha256 = hash(result.stderr);
        try { check(result.exit_code === expectedExit, "unexpected-command-exit"); step.observation = verify(result.stdout, result.stderr); custody.unchanged(); step.passed = true; }
        catch (error) { diagnostics.push({ step: id, stdout: result.stdout, stderr: result.stderr }); throw error; }
        return step.observation;
      } catch (error) { step.failure = error instanceof Error ? error.message : "command-failed"; throw new Error(`${id}:${step.failure}`); }
    };
    const initOutput = (vault: string) => (stdout: string, stderr: string) => {
      check(stdout === `${vault}\nservice: opted out (--no-service)\nnext: import a file source, then query and doctor\n` && stderr === "", "unexpected-init-output");
      return empty();
    };
    const initialise = (id: string, scenario: string) => {
      const target = scenarios.get(scenario)!;
      return run(id, scenario, ["init", target.vault, "--no-service", "--no-default"], 0, initOutput(target.vault));
    };
    const queryFor = (id: string, sentinel: string, expected: number) => run(id, "valid", ["query", sentinel, "--scope", "ledger", "--json", ...(expected === 0 ? ["--degraded"] : [])], 0,
      (stdout, stderr) => queryObservation(stdout, stderr, { connector: SCREENPIPE_CONNECTOR_ID, sentinel }, expected, id === "purged-query" ? "post_purge" : "ordinary"));

    const valid = scenarios.get("valid")!;
    const operation = "synthetic-screenpipe-revoke";
    await initialise("init", "valid");
    // The enrolment line is the only place the new source key appears, so the
    // proof reads it there rather than running an unrecorded extra command.
    const enrolment = await run("connect", "valid", ["connect", "screenpipe", "--source", valid.database], 0,
      (stdout, stderr) => { const observed = connectObservation(stdout, stderr, valid.database); sourceKey = observed.sourceKey; return observed.observation; });
    check(enrolment.consent === "required" && sourceKey !== null, "unexpected-enrolment-consent");
    const granted = await run("grant", "valid", ["connect", "grant", "--source", sourceKey!, "--policy", policy, "--expected-revision", "0", "--operation-id", "synthetic-screenpipe-grant", "--json"], 0,
      (stdout, stderr) => grantObservation(stdout, stderr, sourceKey!, "synthetic-screenpipe-grant"));
    check(granted.consent === "active", "grant-not-active");
    await run("backfill", "valid", ["backfill", "screenpipe"], 0, (stdout, stderr) => runCounts(stdout, stderr, {
      stored: SCREENPIPE_EXPECTED.backfill_stored, duplicates: SCREENPIPE_EXPECTED.backfill_duplicates,
      proposals: SCREENPIPE_EXPECTED.proposals_created, errors: [], degraded: [],
    }));
    const first = await queryFor("query", SCREENPIPE_SENTINEL, SCREENPIPE_EXPECTED.query_hits);
    const exported = join(valid.directory, "export");
    await run("export", "valid", ["export", "--out", exported], 0, (stdout, stderr) => exportObservation(stdout, stderr, exported));
    await run("repeat-backfill", "valid", ["backfill", "screenpipe"], 0, (stdout, stderr) => runCounts(stdout, stderr, {
      stored: SCREENPIPE_EXPECTED.repeat_stored, duplicates: SCREENPIPE_EXPECTED.repeat_duplicates, proposals: 0, errors: [], degraded: [],
    }));
    await run("sync", "valid", ["sync", "screenpipe"], 0, (stdout, stderr) => runCounts(stdout, stderr, {
      stored: SCREENPIPE_EXPECTED.sync_stored, duplicates: SCREENPIPE_EXPECTED.sync_duplicates, proposals: 0, errors: [], degraded: [],
    }));
    const second = await queryFor("repeat-query", SCREENPIPE_SENTINEL, SCREENPIPE_EXPECTED.query_hits);
    check(JSON.stringify(first.hit_ids) === JSON.stringify(second.hit_ids), "repeat-query-identities-changed");
    await run("status", "valid", ["connect", "status", "--json"], 0, (stdout, stderr) => enrolledStatus(stdout, stderr, sourceKey!, 0));
    await run("revoke", "valid", ["connect", "revoke", "--source", sourceKey!, "--expected-revision", "1", "--operation-id", operation, "--json"], 0,
      (stdout, stderr) => { check(stderr === "", "unexpected-revoke-diagnostics"); return consentObservation(stdout, sourceKey!, "denied", SCREENPIPE_CONNECTOR_ID, operation); });
    await queryFor("revoked-query", SCREENPIPE_SENTINEL, 0);
    await run("resume-revocation", "valid", ["connect", "resume-revocation", "--source", sourceKey!, "--operation-id", operation, "--json"], 0,
      (stdout, stderr) => { check(stderr === "", "unexpected-purge-diagnostics"); return consentObservation(stdout, sourceKey!, "purged", SCREENPIPE_CONNECTOR_ID, operation); });
    await queryFor("purged-query", SCREENPIPE_SENTINEL, 0);
    await run("purge-status", "valid", ["connect", "status", "--source", sourceKey!, "--json"], 0,
      (stdout, stderr) => { check(stderr === "", "unexpected-purge-diagnostics"); return consentObservation(stdout, sourceKey!, "purged", SCREENPIPE_CONNECTOR_ID, operation); });
    await run("denied-backfill", "valid", ["backfill", "screenpipe"], 1, (stdout, stderr) => deniedCaptureObservation(stdout, stderr, sourceKey!));

    // A running screenpipe holds its database. Reading it would tear state, so
    // enrolment must refuse rather than observe a half-written snapshot.
    const locked = scenarios.get("locked")!;
    await initialise("locked-init", "locked");
    locker = new Database(locked.database, { readwrite: true, create: false });
    locker.exec("PRAGMA busy_timeout = 0");
    locker.exec("BEGIN EXCLUSIVE");
    locker.exec("CREATE TABLE IF NOT EXISTS synthetic_exclusive_lock (id INTEGER PRIMARY KEY)");
    await run("locked-connect", "locked", ["connect", "screenpipe", "--source", locked.database], 1,
      (stdout, stderr) => refusalObservation(stdout, stderr, SCREENPIPE_REFUSALS.locked));
    locker.exec("ROLLBACK"); locker.close(); locker = null;

    for (const name of ["below-floor", "malformed"] as const) {
      const target = scenarios.get(name)!;
      await initialise(`${name}-init`, name);
      await run(`${name}-connect`, name, ["connect", "screenpipe", "--source", target.database], 1,
        (stdout, stderr) => refusalObservation(stdout, stderr, SCREENPIPE_REFUSALS[name]));
      await run(`${name}-status`, name, ["connect", "status", "--json"], 0, (stdout, stderr) => statusCount(stdout, stderr, 0));
    }

    custody.unchanged(); revision.clean();
    check(JSON.stringify(steps.map(step => step.id)) === JSON.stringify(expectedScreenpipeSteps()), "missing-or-extra-step");
    for (const file of fixtureFiles) {
      const path = file.shape === "shared" ? join(workspace, file.path) : join(workspace, file.shape, file.path);
      check(hash(readFileSync(path)) === file.sha256, "fixture-source-changed");
    }
  } catch (error) { failures.push(error instanceof Error ? error.message : "screenpipe-proof-failed"); }
  finally {
    if (locker !== null) { try { locker.close(); } catch { /* the original failure is the actionable one */ } }
    rmSync(workspace, { recursive: true, force: true });
  }
  const passed = failures.length === 0 && steps.length > 0 && steps.every(step => step.passed);
  const receipt = {
    schema: "kizuki.screenpipe-fixture-proof/v1", scope: "synthetic_stopped_local_database_only", acceptance_credit: false,
    source_sha: sourceSha, producer_files_sha256: producerHashes,
    host: { platform: process.platform, arch: process.arch, kernel_release: release() },
    artifact: identity, fixture_files: fixtureFiles, source_key: sourceKey, steps, failures, passed,
  };
  const output = join(args.report, "receipt.json");
  writeFileSync(output, JSON.stringify(receipt, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  if (diagnostics.length) writeFileSync(join(args.report, "synthetic-diagnostics.json"), JSON.stringify({ scope: "generated_synthetic_inputs_only", diagnostics }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  emitScreenpipeConnectorEvidence(args.report, sourceSha, steps, passed);
  if (!passed) throw new Error(`screenpipe fixture proof failed; receipt retained at ${output}`);
  return output;
}

export function emitScreenpipeConnectorEvidence(report: string, sourceSha: string, steps: readonly Step[], passed: boolean): void {
  const unresolved: string[] = [];
  const entries: { receipt: ConnectorEvidenceReceipt; emission: ConnectorEvidenceEmission }[] = [];
  const executed = steps.filter(step => step.exit_code >= 0);
  const failed = steps.filter(step => !step.passed);
  let producer_revision = "";
  try { producer_revision = connectorProducerRevision(ROOT); }
  catch (error) { unresolved.push(`producer-revision-unavailable:${error instanceof Error ? error.message : "unknown"}`); }
  if (executed.length === 0) unresolved.push(`${SCREENPIPE_CONNECTOR_ID}:no-command-was-executed`);
  else {
    for (const step of failed) unresolved.push(`${SCREENPIPE_CONNECTOR_ID}:failed-step:${step.id}${step.failure ? `:${step.failure}` : ""}`);
    if (!passed) unresolved.push(`${SCREENPIPE_CONNECTOR_ID}:run-integrity:proof-failed`);
    try {
      entries.push({
        receipt: buildConnectorEvidenceReceipt({
          connector_id: SCREENPIPE_CONNECTOR_ID, candidate_source_sha: sourceSha, producer_revision, acceptance_credit: passed,
          steps: executed.map(step => ({ id: step.id, command: step.command, exit_code: step.exit_code, passed: step.passed, stdout_sha256: step.stdout_sha256, stderr_sha256: step.stderr_sha256 })),
        }),
        emission: {
          connector_id: SCREENPIPE_CONNECTOR_ID, evidence_class: "local-source", acceptance_credit: passed,
          row_counts: observedScreenpipeCounts(steps),
          limits: SCREENPIPE_LIMITS,
        },
      });
    } catch (error) { unresolved.push(`${SCREENPIPE_CONNECTOR_ID}:${error instanceof Error ? error.message : "receipt-refused"}`); }
  }
  writeConnectorEvidence(report, entries, unresolved);
}

/** Emissions record only counters a successful named step actually observed. */
function observedScreenpipeCounts(steps: readonly Step[]): Record<string, number> {
  const count = (id: string, key: "stored" | "duplicates" | "proposals"): number | undefined => {
    const step = steps.find(candidate => candidate.id === id && candidate.passed);
    const value = step?.observation[key];
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  };
  const counts: Record<string, number> = {};
  const backfill = count("backfill", "stored"), proposals = count("backfill", "proposals"), repeat = count("repeat-backfill", "duplicates"), sync = count("sync", "stored");
  if (backfill !== undefined) counts.events_stored = backfill;
  if (proposals !== undefined) counts.proposals_created = proposals;
  if (repeat !== undefined) counts.repeat_duplicates = repeat;
  if (sync !== undefined) counts.sync_stored = sync;
  return counts;
}

/** Stated by the connector's own README and witnessed by the steps above. */
export const SCREENPIPE_LIMITS = [
  "offline read of a stopped local database; a running or locked screenpipe is refused rather than read torn",
  "screenpipe publishes no per-row deletion log, so the manifest declares no tombstones and no source-side purge; ledger purge is the path that removes imported evidence",
  "browser URLs keep origin plus a redacted path: userinfo, query and fragment are dropped",
  "databases below the supported migration floor, and databases whose capture tables do not match the declared contract, are refused before any event is stored",
] as const;

if (import.meta.main) {
  try { console.log(await runScreenpipeProof(parseScreenpipeArgs(process.argv.slice(2)))); }
  catch (error) { console.error(error instanceof Error ? error.message : "screenpipe fixture proof failed"); process.exitCode = 1; }
}
