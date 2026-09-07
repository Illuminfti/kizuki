import { Database, constants as sqlite } from "bun:sqlite";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { openCredentialDirectory } from "../packages/core/src/agents/credential-file";
import { openLedger, LEDGER_SCHEMA_VERSION } from "../packages/core/src/ledger/db";
import { manageDatabaseLifetime } from "../packages/core/src/ledger/lifetime";
import { configureLedgerWalLifecycle } from "../packages/core/src/ledger/wal-lifecycle";
import { openLedgerRead } from "../packages/core/src/ledger/read-context";
import { getProposal, initStaging } from "../packages/core/src/staging/proposals";
import { openCanonFiles } from "../packages/core/src/vault/canon-files";
import { parseBuildInfo, verifyPackageDirectory } from "./release-artifacts";

const repository = resolve(import.meta.dir, "..");
const sha = (bytes: string | Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const encode = (value: unknown): string => JSON.stringify(value);
const quote = (value: string): string => `"${value.replaceAll('"', '""')}"`;
function requireThat(value: unknown, code: string): asserts value { if (!value) throw new RecoveryFixtureError(code); }
class RecoveryFixtureError extends Error { constructor(readonly code: string) { super(code); } }

export const HISTORICAL_RECOVERY_INPUTS = Object.freeze([
  { id: "ledger15", file: "doctor-ledger15-legacy.sql", sha256: "1d93c78885930f42bb01c579f4a6d272c5998ffd4b11bd4afe95318b90e8a2ed", writer_commit: "5c50bdc8bf14915ffa3c4e1a011ecc8af45d20a9", writer_bun: "1.3.10", ledger: 15 },
  { id: "ledger16", file: "agent-enrollment-ledger16-claim.sql", sha256: "e9eaa16285ccce0b0d88bfbafde44dc32c698ec9e8ec5ac87b6f9f8394860144", writer_commit: "c5a3aa54c366c1f0f8242448732a797663fb65c1", writer_bun: "1.3.10", ledger: 16 },
  { id: "backup16", file: "agent-enrollment-ledger16-backup.json", sha256: "989a4dab3f3f995e4fd0b6583d9e531aa8edb53228f3d6bf4c355fd3dd82e113", writer_commit: "c5a3aa54c366c1f0f8242448732a797663fb65c1", writer_bun: "1.3.10", ledger: 16 },
  { id: "claim-backup16", file: "agent-enrollment-ledger16-claim-backup.json", sha256: "47c1e866da61b3bdf141e20fbea4cfc9edba6ba6393036ecfc6261f422ea4120", writer_commit: "c5a3aa54c366c1f0f8242448732a797663fb65c1", writer_bun: "1.3.10", ledger: 16 },
].map(row => Object.freeze(row)));
export type RecoveryInputId = typeof HISTORICAL_RECOVERY_INPUTS[number]["id"];
export const NATIVE_RECOVERY_PHASE_IDS = ["migrate-ledger15", "migrate-ledger16", "migration-failure-preserved", "migration-backup-recovery", "restore-backup16", "restore-claim-backup16"] as const;
export type NativeRecoveryPhaseId = typeof NATIVE_RECOVERY_PHASE_IDS[number];
export interface NativeRecoveryOptions { executable: string; candidate_source_sha: string; helper_source_sha: string; workspace: string; }
export interface NativeRecoverySnapshot { schema_version: number; schema_sha256: string; rows_sha256: string; table_count: number; row_count: number; events: number; claims: number; integrity: "ok"; foreign_key_errors: 0; }
export interface NativeRecoveryCommand { step: "initialize" | "doctor-before" | "migrate" | "rebuild" | "query" | "restore-verify" | "restore"; argv: string[]; expected_exit: 0 | 1; exit_code: number; signal: string | null; duration_ms: number; stdout_sha256: string; stderr_sha256: string; diagnostic: "none" | "migration_required" | "migration_rejected"; }
export interface NativeRecoveryEvidence {
  fixture_id: string; fixture_sha256: string; writer_commit: string; writer_bun: string;
  candidate_source_sha: string; helper_source_sha: string; executable_sha256: string;
  commands: NativeRecoveryCommand[];
  snapshots: { role: "before" | "doctor-after" | "migrated" | "admission-before" | "admission-after" | "late-ddl-before" | "late-ddl-after" | "recovery-preimage" | "restored"; value: NativeRecoverySnapshot }[];
  preservation: { events: number; claims: number; event_sha256: string; claim_sha256: string; original_columns_equal: boolean; current_claim_consumer: "not_applicable" | "passed"; public_query: "not_run" | "passed" };
  recovery_copy_sha256: string | null;
  failure_scope: "none" | "admission-and-late-ddl-transaction-rollback";
  retained_failed_vaults: string[];
  failure_code: string | null;
}
export interface NativeRecoveryResult { phases: { id: NativeRecoveryPhaseId; passed: boolean; evidence: NativeRecoveryEvidence }[]; service_vaults: { id: NativeRecoveryPhaseId; vault: string; event_text_sha256: string }[]; }
type Row = Record<string, string | number | null>;
interface Snapshot { summary: NativeRecoverySnapshot; schema: Row[]; tables: Record<string, Row[]>; }

export function historicalRecoveryInput(id: string): { identity: typeof HISTORICAL_RECOVERY_INPUTS[number]; bytes: Buffer } {
  const identity = HISTORICAL_RECOVERY_INPUTS.find(row => row.id === id);
  requireThat(identity, "unknown-historical-input");
  const path = join(repository, "packages/core/test/fixtures", identity.file), stat = lstatSync(path);
  requireThat(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 2_097_152, "historical-input-custody");
  const bytes = readFileSync(path);
  requireThat(sha(bytes) === identity.sha256 && Buffer.from(bytes.toString("utf8")).equals(bytes), "historical-input-hash");
  return { identity, bytes };
}

/** Query-only legacy inspection uses the same managed SQLite lifecycle as current readers.
 * It intentionally does not call openLedgerRead, which correctly rejects old schemas. */
export function inspectRecoveryFixture(vault: string): Snapshot {
  const path = join(vault, ".kizuki/kizuki.db"), directory = openCredentialDirectory(dirname(path));
  let db: Database | undefined;
  try {
    const before = directory.inspectFileIdentity("kizuki.db");
    requireThat(before, "missing-fixture-ledger");
    for (const suffix of ["-wal", "-shm"]) directory.inspectFileIdentity(`kizuki.db${suffix}`);
    requireThat(!directory.inspectFileIdentity("kizuki.db-journal"), "fixture-hot-journal");
    db = manageDatabaseLifetime(new Database(path, sqlite.SQLITE_OPEN_READWRITE | sqlite.SQLITE_OPEN_NOFOLLOW));
    configureLedgerWalLifecycle(db, path); db.exec("PRAGMA query_only=ON; PRAGMA foreign_keys=ON");
    const integrity = db.query<{ integrity_check: string }, []>("PRAGMA integrity_check").all();
    requireThat(integrity.length === 1 && integrity[0]?.integrity_check === "ok", "fixture-integrity");
    requireThat(db.query("PRAGMA foreign_key_check").all().length === 0, "fixture-foreign-keys");
    const schema = db.query<Row, []>("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all();
    const names = schema.filter(row => row.type === "table").map(row => String(row.name));
    requireThat(names.length <= 256, "fixture-table-bound");
    const tables: Record<string, Row[]> = {};
    let rows = 0;
    for (const name of names) {
      const values = db.query<Row, []>(`SELECT * FROM ${quote(name)} LIMIT 10001`).all();
      rows += values.length; requireThat(rows <= 10000, "fixture-row-bound");
      tables[name] = values.sort((a,b) => encode(a).localeCompare(encode(b)));
    }
    const text = encode(tables); requireThat(Buffer.byteLength(text) <= 8_388_608, "fixture-byte-bound");
    const version = Number(tables.schema_version?.[0]?.version); requireThat(Number.isSafeInteger(version) && version >= 1 && version <= LEDGER_SCHEMA_VERSION, "fixture-version");
    directory.observe(); const after = directory.inspectFileIdentity("kizuki.db");
    requireThat(after?.dev === before.dev && after.ino === before.ino, "fixture-identity-changed");
    return { schema, tables, summary: { schema_version: version, schema_sha256: sha(encode(schema)), rows_sha256: sha(text), table_count: names.length, row_count: rows, events: tables.events?.length ?? 0, claims: tables.claims?.length ?? 0, integrity: "ok", foreign_key_errors: 0 } };
  } finally { try { db?.close(); } finally { directory.close(); } }
}

function writableFixture(path: string, operation: (db: Database) => void): void {
  const db = manageDatabaseLifetime(new Database(path, sqlite.SQLITE_OPEN_READWRITE | sqlite.SQLITE_OPEN_NOFOLLOW));
  try { configureLedgerWalLifecycle(db, path); db.exec("PRAGMA foreign_keys=ON"); operation(db); }
  finally { db.close(); }
}
/** Replay the frozen SQLite dump in its original dump-loader mode, then inspect
 * the complete database with foreign-key checks enabled. This is fixture setup. */
export function replayHistoricalRecoverySql(vault: string, id: string): NativeRecoverySnapshot {
  requireThat(id === "ledger15" || id === "ledger16", "not-historical-sql");
  const input = historicalRecoveryInput(id);
  writableFixture(join(vault, ".kizuki/kizuki.db"), db => {
    db.exec("PRAGMA foreign_keys=OFF");
    db.exec(input.bytes.toString("utf8"));
  });
  return inspectRecoveryFixture(vault).summary;
}
function ensureQuiescent(vault: string): void {
  const directory = openCredentialDirectory(join(vault, ".kizuki"));
  try { for (const suffix of ["-wal", "-shm", "-journal"]) requireThat(!directory.inspectFileIdentity(`kizuki.db${suffix}`), "fixture-not-quiescent"); }
  finally { directory.close(); }
}
function replaceClosedLedger(vault: string, bytes: Uint8Array): void {
  ensureQuiescent(vault);
  const files = openCanonFiles(vault);
  try { const prior = files.readPrivate(".kizuki/kizuki.db"); requireThat(prior, "missing-initialized-ledger"); const created = files.create(".kizuki/recovery-fixture.tmp", bytes); files.replace(created, prior); }
  finally { files.close(); }
}
function privateBytes(vault: string): Buffer {
  ensureQuiescent(vault); const files = openCanonFiles(vault);
  try { const file = files.readPrivate(".kizuki/kizuki.db"); requireThat(file, "missing-fixture-ledger"); return Buffer.from(file.bytes); }
  finally { files.close(); }
}
function equalLogical(a: Snapshot, b: Snapshot): boolean { return a.summary.schema_sha256 === b.summary.schema_sha256 && a.summary.rows_sha256 === b.summary.rows_sha256; }
function projectedRows(before: Row[], after: Row[], key: string): Row[] {
  requireThat(before.length === after.length, "preservation-cardinality");
  return before.map(row => { const match = after.find(item => item[key] === row[key]); requireThat(match, "preservation-identity"); return Object.fromEntries(Object.keys(row).map(field => [field, match[field] ?? null])); });
}
function preserve(before: Snapshot, after: Snapshot, evidence: NativeRecoveryEvidence): void {
  const events = before.tables.events ?? [], claims = before.tables.claims ?? [];
  const afterEvents = projectedRows(events, after.tables.events ?? [], "event_id");
  const afterClaims = projectedRows(claims, after.tables.claims ?? [], "claim_id");
  requireThat(encode(events) === encode(afterEvents) && encode(claims) === encode(afterClaims), "legacy-row-changed");
  for (const event of after.tables.events ?? []) requireThat(event.text_hash === sha(String(event.text)) && (event.content_hash_version === 1 || event.content_hash_version === 2) && event.origin === "external", "current-event-metadata");
  evidence.preservation = { events: events.length, claims: claims.length, event_sha256: sha(encode(events)), claim_sha256: sha(encode(claims)), original_columns_equal: true, current_claim_consumer: "not_applicable", public_query: "not_run" };
}
function claimConsumer(vault: string, before: Snapshot, evidence: NativeRecoveryEvidence): void {
  const claims = before.tables.claims ?? []; if (!claims.length) return;
  // The documented signature upgrade is a current Core consumer operation, separately
  // source-bound to this helper; migration and event query remain compiled CLI calls.
  const db = openLedger(join(vault, ".kizuki/kizuki.db"));
  try {
    initStaging(db);
    for (const claim of claims) {
      const value = getProposal(db, String(claim.claim_id));
      requireThat(value && value.proposal_id === claim.claim_id && value.body === claim.body && encode(value.provenance) === String(claim.provenance) && /^[a-f0-9]{64}$/.test(value.content_hash), "current-claim-consumer");
    }
  } finally { db.close(); }
  evidence.preservation.current_claim_consumer = "passed";
}

export async function runNativeRecoveryFixtures(options: NativeRecoveryOptions): Promise<NativeRecoveryResult> {
  requireThat(Object.keys(options).sort().join() === "candidate_source_sha,executable,helper_source_sha,workspace", "invalid-recovery-options");
  for (const value of [options.candidate_source_sha, options.helper_source_sha]) requireThat(/^[a-f0-9]{40}$/.test(value), "invalid-source-sha");
  const executable = resolve(options.executable), workspace = resolve(options.workspace);
  requireThat(executable === options.executable && workspace === options.workspace && basename(executable) === "kizuki" && realpathSync(executable) === executable, "recovery-path-custody");
  const build = parseBuildInfo(join(dirname(executable), "BUILD.json"));
  requireThat(build.schema === "kizuki.release-build/v2" && build.source_sha === options.candidate_source_sha, "candidate-source-mismatch");
  verifyPackageDirectory(dirname(executable), build);
  const executableHash = sha(readFileSync(executable));
  const head = Bun.spawnSync(["git", "-C", repository, "rev-parse", "HEAD"], { stdout: "pipe", stderr: "pipe" });
  requireThat(head.exitCode === 0 && head.stdout.toString().trim() === options.helper_source_sha, "helper-source-mismatch");
  const dirty = Bun.spawnSync(["git", "-C", repository, "diff", "--exit-code", "HEAD", "--", "scripts/native-recovery-fixtures.ts", "packages/core/src", "packages/core/test/fixtures"], { stdout: "pipe", stderr: "pipe" });
  requireThat(dirty.exitCode === 0, "helper-source-dirty");
  const root = openCredentialDirectory(workspace); root.close();
  requireThat(readdirSync(workspace).length === 0, "recovery-workspace-not-empty");
  const home = join(workspace, "home"), config = join(workspace, "config");
  mkdirSync(home, { mode: 0o700 }); mkdirSync(config, { mode: 0o700 });
  const env: Record<string,string> = { HOME: home, XDG_CONFIG_HOME: config, TMPDIR: process.env.TMPDIR ?? "/tmp", PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C.UTF-8", KIZUKI_CONFIG: join(config,"kizuki.toml") };
  const result: NativeRecoveryResult = { phases: [], service_vaults: [] };
  const inputs = ["ledger15", "ledger16", "ledger15", "ledger15", "backup16", "claim-backup16"];
  let goodCopy: Buffer | null = null, goodBefore: Snapshot | null = null;
  for (const [index,id] of NATIVE_RECOVERY_PHASE_IDS.entries()) {
    const input = historicalRecoveryInput(inputs[index]!);
    const evidence: NativeRecoveryEvidence = { fixture_id: input.identity.id, fixture_sha256: input.identity.sha256, writer_commit: input.identity.writer_commit, writer_bun: input.identity.writer_bun, candidate_source_sha: options.candidate_source_sha, helper_source_sha: options.helper_source_sha, executable_sha256: executableHash, commands: [], snapshots: [], preservation: { events: 0, claims: 0, event_sha256: sha("[]"), claim_sha256: sha("[]"), original_columns_equal: false, current_claim_consumer: "not_applicable", public_query: "not_run" }, recovery_copy_sha256: null, failure_scope: "none", retained_failed_vaults: [], failure_code: null };
    const phase = { id, passed: false, evidence }; result.phases.push(phase);
    const vault = join(workspace, id);
    const command = (step: NativeRecoveryCommand["step"], args: string[], expected: 0 | 1 = 0, diagnostic: NativeRecoveryCommand["diagnostic"] = "none"): { stdout: string; stderr: string } => {
      const started = performance.now();
      const child = Bun.spawnSync([executable, ...args], { cwd: workspace, env, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 30_000, maxBuffer: 1_048_576 });
      const stdout = child.stdout.toString(), stderr = child.stderr.toString();
      evidence.commands.push({ step, argv: ["kizuki", ...args.map(arg => arg.startsWith(workspace + "/") ? "$WORKSPACE/" + arg.slice(workspace.length + 1) : arg)], expected_exit: expected, exit_code: child.exitCode, signal: child.signalCode ?? null, duration_ms: Math.ceil(performance.now()-started), stdout_sha256: sha(child.stdout), stderr_sha256: sha(child.stderr), diagnostic });
      requireThat(!child.signalCode && child.exitCode === expected && child.stdout.length + child.stderr.length <= 1_048_576, `command-${step}`);
      return { stdout, stderr };
    };
    const initialize = (target: string): void => { command("initialize", ["init", target, "--no-service", "--no-default"]); };
    const makeSql = (target: string): Snapshot => {
      initialize(target); replaceClosedLedger(target, new Uint8Array());
      replayHistoricalRecoverySql(target, input.identity.id);
      return inspectRecoveryFixture(target);
    };
    const publicQuery = (target: string, baseline: Snapshot): void => {
      command("rebuild", ["rebuild", "--json", "--vault", target]);
      const output = command("query", ["query", "synthetic", "--scope", "ledger", "--json", "--vault", target]);
      const value = JSON.parse(output.stdout);
      const expected = baseline.tables.events ?? [];
      requireThat(value.schema === "kizuki.cli.query/v1" && value.status === "ok" && Array.isArray(value.degraded) && value.degraded.length === 0 && Array.isArray(value.warnings) && value.warnings.length === 0 && value.data.hits.length === expected.length && value.data.withheld === 0 && output.stderr === "", "public-query-envelope");
      for (const event of expected) requireThat(value.data.hits.some((hit: Record<string,unknown>) => hit.scope === "ledger" && hit.snippet === event.text && hit.connector_id === event.connector_id), "public-query-content");
      evidence.preservation.public_query = "passed";
    };
    const migrate = (target: string, baseline: Snapshot): void => {
      const doctor = command("doctor-before", ["doctor", "--json", "--vault", target], 1, "migration_required");
      requireThat(doctor.stderr.includes("migration_required"), "doctor-migration-diagnostic");
      const unchanged = inspectRecoveryFixture(target); evidence.snapshots.push({ role: "doctor-after", value: unchanged.summary });
      requireThat(equalLogical(baseline, unchanged), "doctor-mutated-legacy");
      command("migrate", ["init", target, "--no-service", "--no-default"]);
      const after = inspectRecoveryFixture(target); evidence.snapshots.push({ role: "migrated", value: after.summary });
      requireThat(after.summary.schema_version === LEDGER_SCHEMA_VERSION, "migration-version");
      const read = openLedgerRead(target); try { read.assertCurrent(); } finally { read.close(); }
      preserve(baseline, after, evidence); claimConsumer(target, baseline, evidence); publicQuery(target, baseline);
    };
    try {
      if (id === "migrate-ledger15" || id === "migrate-ledger16") {
        const before = makeSql(vault); evidence.snapshots.push({ role: "before", value: before.summary });
        requireThat(before.summary.schema_version === input.identity.ledger && before.summary.events === 1, "historical-sql-shape");
        if (id === "migrate-ledger15") { goodCopy = privateBytes(vault); goodBefore = before; const backup = join(workspace, "verified-preimage.db"); writeFileSync(backup, goodCopy, {flag:"wx",mode:0o600}); evidence.recovery_copy_sha256 = sha(goodCopy); }
        migrate(vault, before);
      } else if (id === "migration-failure-preserved") {
        for (const fault of ["admission", "late-ddl"] as const) {
          const failed = join(workspace, `failed-${fault}`); makeSql(failed);
          writableFixture(join(failed,".kizuki/kizuki.db"), db => db.exec(fault === "admission" ? "UPDATE events SET text='Synthetic deliberately mismatched text.'" : "CREATE TABLE canon_projection_sources (synthetic_collision TEXT NOT NULL); INSERT INTO canon_projection_sources VALUES ('fixture')"));
          const before = inspectRecoveryFixture(failed); evidence.snapshots.push({ role: `${fault}-before`, value: before.summary });
          const output = command("migrate", ["init", failed, "--no-service", "--no-default"], 1, "migration_rejected");
          requireThat(output.stderr.includes(fault === "admission" ? "text" : "canon_projection_sources"), "negative-rejection-point");
          const after = inspectRecoveryFixture(failed); evidence.snapshots.push({ role: `${fault}-after`, value: after.summary });
          requireThat(equalLogical(before, after) && after.summary.schema_version === 15, "failed-migration-mutated-legacy");
          evidence.retained_failed_vaults.push(`failed-${fault}`);
        }
        requireThat(goodCopy && goodBefore && sha(readFileSync(join(workspace,"verified-preimage.db"))) === sha(goodCopy), "recovery-preimage-changed");
        evidence.recovery_copy_sha256 = sha(goodCopy); evidence.failure_scope = "admission-and-late-ddl-transaction-rollback";
      } else if (id === "migration-backup-recovery") {
        requireThat(goodCopy && goodBefore, "recovery-preimage-missing");
        const copy = readFileSync(join(workspace,"verified-preimage.db")); requireThat(sha(copy) === sha(goodCopy), "recovery-preimage-changed");
        initialize(vault); replaceClosedLedger(vault, copy);
        const before = inspectRecoveryFixture(vault); requireThat(equalLogical(goodBefore, before), "recovery-copy-logical-mismatch");
        evidence.snapshots.push({role:"recovery-preimage",value:before.summary}); evidence.recovery_copy_sha256 = sha(copy);
        migrate(vault,before);
      } else {
        const fixture = JSON.parse(input.bytes.toString());
        requireThat(fixture.writer_commit === input.identity.writer_commit && fixture.bun_version === input.identity.writer_bun && fixture.files && typeof fixture.files === "object", "historical-backup-shape");
        const backup = join(workspace,`${id}-input`); mkdirSync(backup,{mode:0o700});
        for (const [path,text] of Object.entries(fixture.files)) {
          requireThat(/^[a-zA-Z0-9._/-]+$/.test(path) && !path.startsWith("/") && path.split("/").every(part => part && part !== "." && part !== "..") && typeof text === "string", "historical-backup-path");
          const target = join(backup,path); mkdirSync(dirname(target),{recursive:true,mode:0o700}); writeFileSync(target,text,{flag:"wx",mode:0o600});
        }
        command("restore-verify",["restore","--from",backup,"--verify"]);
        command("restore",["restore","--from",backup,"--into",vault]);
        const after = inspectRecoveryFixture(vault); evidence.snapshots.push({role:"restored",value:after.summary}); requireThat(after.summary.schema_version === 21 && after.summary.events === 1, "restored-shape");
        const events = Object.entries(fixture.files).filter(([path]) => path === "ledger/events.jsonl").flatMap(([,text]) => String(text).trim().split("\n").filter(Boolean).map(line=>JSON.parse(line)));
        const claims = String(fixture.files["claims/claims.jsonl"] ?? "").trim().split("\n").filter(Boolean).map(line=>JSON.parse(line));
        // Backup event rows are a public serialization; prove preserved event/claim
        // identities and content without pretending JSON fields are SQL columns.
        requireThat(events.length === 1 && after.summary.claims === claims.length, "backup-row-count");
        for (const event of events) requireThat(after.tables.events?.some(row => row.event_id === event.event_id && row.text === event.text && row.content_hash === event.content_hash), "backup-event-preservation");
        for (const claim of claims) requireThat(after.tables.claims?.some(row=>row.claim_id===claim.claim_id && row.body===claim.body && row.provenance===encode(claim.provenance)), "backup-claim-preservation");
        evidence.preservation = {events:events.length,claims:claims.length,event_sha256:sha(encode(events)),claim_sha256:sha(encode(claims)),original_columns_equal:true,current_claim_consumer:"not_applicable",public_query:"not_run"};
        claimConsumer(vault, after, evidence); publicQuery(vault,after);
        for (const [path,text] of Object.entries(fixture.files)) requireThat(sha(readFileSync(join(backup,path)))===sha(String(text)),"backup-input-mutated");
      }
      verifyPackageDirectory(dirname(executable),build); requireThat(sha(readFileSync(executable))===executableHash,"candidate-bytes-changed"); historicalRecoveryInput(input.identity.id);
      phase.passed=true;
      if (id!=="migration-failure-preserved") { const current=inspectRecoveryFixture(vault); result.service_vaults.push({id,vault,event_text_sha256:sha(String(current.tables.events![0]!.text))}); }
    } catch(error) { evidence.failure_code = error instanceof RecoveryFixtureError ? error.code : "fixture-operation-failed"; }
  }
  return result;
}

if (import.meta.main) {
  const [executable,candidate_source_sha,helper_source_sha,workspace,output]=process.argv.slice(2);
  requireThat(executable && candidate_source_sha && helper_source_sha && workspace && output && process.argv.length===7,"recovery-cli-arguments");
  const result = await runNativeRecoveryFixtures({executable,candidate_source_sha,helper_source_sha,workspace});
  writeFileSync(output,`${JSON.stringify(result,null,2)}\n`,{flag:"wx",mode:0o600});
  process.exitCode=result.phases.every(phase=>phase.passed)?0:1;
}
