import { createHash, randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Database, constants as sqlite } from "bun:sqlite";
import { openCredentialDirectory } from "../packages/core/src/agents/credential-file";
import { manageDatabaseLifetime } from "../packages/core/src/ledger/lifetime";
import { configureLedgerWalLifecycle } from "../packages/core/src/ledger/wal-lifecycle";
import { parseRunReceipt } from "../packages/core/src/serve/receipts";

export const MODEL_PHASE_IDS = ["model-absent", "model-configured", "model-unavailable", "model-credential-loss", "model-dependency-offline"] as const;
export type ModelPhaseId = typeof MODEL_PHASE_IDS[number];
export type NativeModelRecovery = {
  stop_confirmed: boolean; receipt_trigger: string; receipt_due_at: string | null; scheduling_override: { rail: "sync"; old: string | null; next: string; reason: "synthetic-due-time-for-recovery" };
  trigger: "service-restart"; unit: string; pid: number; instance_id: string; started_at: string; receipt_run_id: string; receipt_status: string;
  model_calls: number; model_unavailable: number; claims_extracted: number; canon_writes: number; endpoint_requests: number; unexpected_requests: number;
  model_claims: number; model_canon_receipts: number; model_output_readable: boolean; source_event_present: boolean; query_preserved: boolean;
  daemon_active: boolean; config_unchanged: boolean; credential_unchanged: boolean; endpoint_unchanged: boolean;
};
export type NativeModelEvidence = {
  unit: string; instance_id: string; pid: number; started_at: string; receipt_run_id: string; receipt_status: string;
  model_calls: number; model_unavailable: number; claims_extracted: number; canon_writes: number;
  endpoint_requests: number; unexpected_requests: number; credential_present: boolean; model_configured: boolean;
  source_event_present: boolean; query_preserved: boolean; weights_unchanged: boolean; config_unchanged: boolean;
  configuration_unavailable: boolean; daemon_active: boolean; model_ref_sha256: string | null;
  model_claims: number; model_canon_receipts: number; model_output_readable: boolean; recovery: NativeModelRecovery | null;
};
export type NativeModelPhase = { id: ModelPhaseId; passed: boolean; evidence: NativeModelEvidence };
export type NativeModelInstance = { unit: string; pid: number; instance_id: string; started_at: string };
export type NativeModelFailureDiagnostic = {
  phase_id: ModelPhaseId; unit: string;
  original: { receipt_run_id: string; errors: string[] };
  recovery: { receipt_run_id: string; errors: string[] } | null;
};
export type NativeModelHost = {
  executable: string; workspace: string; env: Record<string, string>;
  invoke(args: string[]): { exit_code: number; stdout: string; stderr: string };
  activate(vault: string): Promise<NativeModelInstance>;
  stillActive(vault: string, instance: NativeModelInstance): boolean;
  deactivate(vault: string): Promise<void>;
  record(phase: NativeModelPhase): void;
  diagnostic?(evidence: NativeModelFailureDiagnostic): void;
};
const sha = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const check = (value: unknown, code: string): void => { if (!value) throw new Error(`native_model_${code}`); };
const MODEL = "native-lifecycle-synthetic";
const SOURCE_TEXT = "Ada is the coordinator for Orchard library.\n";

/** Diagnostic projection only: never serialize the receipt or endpoint response.
 * Reserve space for both attempts so an offline error cannot hide recovery's cause. */
export function modelFailureDiagnostic(phase: NativeModelPhase,
  original: { run_id: string; errors: readonly unknown[] },
  recovery: { run_id: string; errors: readonly unknown[] } | null,
  syntheticKey: string): NativeModelFailureDiagnostic | null {
  if (phase.passed) return null;
  check(/^[0-9a-f]{48}$/.test(syntheticKey), "diagnostic_key");
  const project = (receipt: typeof original, limit: number) => ({ receipt_run_id: receipt.run_id,
    errors: receipt.errors.filter((error): error is string => typeof error === "string").slice(0, limit)
      .map(error => error.replaceAll(syntheticKey, "[redacted]").replace(/[\x00-\x1f\x7f-\x9f]/g, " ").slice(0, 160)) });
  return { phase_id: phase.id, unit: phase.evidence.unit,
    original: project(original, recovery ? 4 : 8), recovery: recovery ? project(recovery, 4) : null };
}

/** Exit zero alone does not establish a healthy query: the CLI can return a
 * degraded envelope. Require its complete public success boundary and hit data. */
export function readStrictNativeQuery(result: { exit_code: number; stdout: string; stderr: string }): { scope: string; authority: string; snippet: string }[] {
  check(result.exit_code === 0 && result.stderr === "" && Buffer.byteLength(result.stdout) <= 65_536, "query_command");
  let body: any; try { body = JSON.parse(result.stdout); } catch { check(false, "query_json"); }
  check(body && typeof body === "object" && !Array.isArray(body) && Object.keys(body).sort().join() === "data,degraded,schema,status,warnings" &&
    body.schema === "kizuki.cli.query/v1" && body.status === "ok" && Array.isArray(body.degraded) && body.degraded.length === 0 && Array.isArray(body.warnings) && body.warnings.length === 0 &&
    body.data && typeof body.data === "object" && !Array.isArray(body.data) && Object.keys(body.data).sort().join() === "hits,withheld" && body.data.withheld === 0 &&
    Array.isArray(body.data.hits) && body.data.hits.length <= 50, "query_envelope");
  for (const hit of body.data.hits) check(hit && typeof hit === "object" && !Array.isArray(hit) && ["canon","ledger"].includes(hit.scope) &&
    typeof hit.authority === "string" && typeof hit.snippet === "string", "query_hit");
  return body.data.hits;
}

/** The observer never migrates the installed daemon's database or retains statements. */
export function readInstalledModelAttempt(vault: string, expected: NativeModelInstance) {
  const path = join(vault, ".kizuki/kizuki.db");
  const db = manageDatabaseLifetime(new Database(path, { readwrite: true, create: false }));
  try {
    configureLedgerWalLifecycle(db, path); db.exec("PRAGMA query_only=ON"); db.exec("PRAGMA busy_timeout=500");
    const rows = db.query<{ report: string | null }, [string]>(`SELECT CASE WHEN length(CAST(report AS BLOB))<=65536 THEN report ELSE NULL END AS report
      FROM run_receipts WHERE rail='sync' AND finished_at>=? ORDER BY finished_at,run_id LIMIT 9`).all(expected.started_at);
    check(rows.length <= 8, "receipt_limit");
    for (const row of rows) {
      check(row.report !== null, "receipt_size");
      const receipt = parseRunReceipt(JSON.parse(row.report!));
      check(receipt !== null, "receipt_invalid");
      if (receipt!.execution?.pid === expected.pid && receipt!.execution.instance_id === expected.instance_id) {
        const present = db.query<{ n: number }, [string]>("SELECT count(*) AS n FROM events WHERE text=?").get(SOURCE_TEXT);
        const claims = db.query<{ n: number }, []>("SELECT count(*) AS n FROM claims WHERE producer='model'").get()!;
        const canon = db.query<{ n: number }, []>("SELECT count(*) AS n FROM canon_receipts WHERE producer='model' OR authority='model_inference'").get()!;
        return { receipt: receipt!, source_event_present: present?.n === 1, model_claims: claims.n, model_canon_receipts: canon.n };
      }
    }
    return null;
  } finally { db.close(true); }
}

/** The native controller has proved this owned fixture stopped. Move only its
 * durable sync due time; do not erase the offline receipt or change cadence. */
export function prepareModelRecoverySchedule(vault: string, stopConfirmed: boolean): NativeModelRecovery["scheduling_override"] {
  check(stopConfirmed && !existsSync(join(vault, ".kizuki/serve.pid")), "schedule_service_not_stopped");
  const directory = openCredentialDirectory(join(vault, ".kizuki")), path = join(vault, ".kizuki/kizuki.db");
  let db: Database | undefined;
  try {
    const before = directory.inspectFileIdentity("kizuki.db"); check(before, "schedule_ledger_missing");
    for (const name of ["kizuki.db-wal", "kizuki.db-shm"]) directory.inspectFileIdentity(name);
    check(!directory.inspectFileIdentity("kizuki.db-journal"), "schedule_hot_journal");
    db = manageDatabaseLifetime(new Database(path, sqlite.SQLITE_OPEN_READWRITE | sqlite.SQLITE_OPEN_NOFOLLOW));
    configureLedgerWalLifecycle(db, path); db.exec("PRAGMA busy_timeout=500");
    const binding = () => { directory.observe(); const current = directory.inspectFileIdentity("kizuki.db"); check(current?.dev === before!.dev && current?.ino === before!.ino, "schedule_identity_changed"); };
    binding();
    return db.transaction(() => {
      binding();
      const schedules = db!.query<Record<string, string | number | null>, []>("SELECT * FROM schedules ORDER BY rail LIMIT 9").all();
      check(schedules.length === 7, "schedule_inventory");
      const sync = schedules.find(row => row.rail === "sync"); check(sync && (sync.next_run_at === null || typeof sync.next_run_at === "string"), "schedule_sync_missing");
      const old = sync!.next_run_at as string | null, next = new Date(Date.now() - 1000).toISOString();
      const receipts = () => { const rows = db!.query("SELECT * FROM run_receipts ORDER BY run_id LIMIT 129").all(); const text = JSON.stringify(rows); check(rows.length <= 128 && text.length <= 1_048_576, "schedule_receipts_bound"); return text; };
      const priorReceipts = receipts();
      const result = db!.query("UPDATE schedules SET next_run_at=? WHERE rail='sync' AND next_run_at IS ?").run(next, old);
      check(result.changes === 1, "schedule_cas_conflict");
      const after = db!.query<Record<string, string | number | null>, []>("SELECT * FROM schedules ORDER BY rail LIMIT 9").all();
      const changed = after.find(row => row.rail === "sync"); check(changed?.next_run_at === next, "schedule_due_not_written"); changed!.next_run_at = old;
      check(JSON.stringify(after) === JSON.stringify(schedules) && receipts() === priorReceipts, "schedule_unrelated_mutation"); binding();
      return { rail: "sync" as const, old, next, reason: "synthetic-due-time-for-recovery" as const };
    }).immediate();
  } finally { try { db?.close(true); } finally { directory.close(); } }
}

/** Closed phase predicate: a prior successful receipt cannot certify a later failure case. */
export function modelPhasePassed(id: ModelPhaseId, e: NativeModelEvidence): boolean {
  const common = e.daemon_active && e.pid > 1 && e.instance_id.length > 0 && e.receipt_run_id.length > 0 &&
    e.source_event_present && e.query_preserved && e.weights_unchanged && e.config_unchanged && e.unexpected_requests === 0;
  if (!common || (id !== "model-dependency-offline" && e.recovery !== null)) return false;
  const noAuthority = e.model_claims === 0 && e.model_canon_receipts === 0 && !e.model_output_readable;
  if (id === "model-absent") return noAuthority && !e.model_configured && !e.credential_present && e.model_calls === 0 && e.endpoint_requests === 0 && e.model_ref_sha256 === null && !e.configuration_unavailable;
  if (!e.model_configured) return false;
  if (id === "model-credential-loss") return noAuthority && !e.credential_present && e.configuration_unavailable && e.model_calls === 0 && e.endpoint_requests === 0 && e.claims_extracted === 0 && e.canon_writes === 0;
  if (!e.credential_present || e.configuration_unavailable || e.model_ref_sha256 === null) return false;
  if (id === "model-configured") return e.receipt_status === "ok" && e.model_calls === 1 && e.model_unavailable === 0 && e.endpoint_requests === 1 && e.claims_extracted === 1 && e.canon_writes > 0 && e.model_claims === 1 && e.model_canon_receipts > 0 && e.model_output_readable;
  if (id === "model-dependency-offline") {
    const r = e.recovery;
    if (r === null || !r.stop_confirmed || r.receipt_trigger !== "scheduled" || r.scheduling_override.rail !== "sync" || (r.receipt_due_at !== r.scheduling_override.next || !(Date.parse(r.started_at) - Date.parse(r.scheduling_override.next) > 0 && Date.parse(r.started_at) - Date.parse(r.scheduling_override.next) < 60_000)) || r.scheduling_override.reason !== "synthetic-due-time-for-recovery" || r.trigger !== "service-restart" || r.unit !== e.unit || r.instance_id === e.instance_id || r.receipt_run_id === e.receipt_run_id ||
      r.pid <= 1 || !r.instance_id || !r.receipt_run_id || r.started_at <= e.started_at || r.receipt_status !== "ok" || r.model_calls !== 1 || r.model_unavailable !== 0 ||
      r.claims_extracted !== 1 || r.canon_writes <= 0 || r.endpoint_requests !== 1 || r.unexpected_requests !== 0 || r.model_claims !== 1 || r.model_canon_receipts <= 0 ||
      !r.model_output_readable || !r.source_event_present || !r.query_preserved || !r.daemon_active || !r.config_unchanged || !r.credential_unchanged || !r.endpoint_unchanged) return false;
  }
  return e.model_calls === 1 && e.model_unavailable === 1 && e.claims_extracted === 0 && e.model_claims === 0 && e.model_canon_receipts === 0 && !e.model_output_readable &&
    e.endpoint_requests === (id === "model-unavailable" ? 1 : 0) && e.receipt_status !== "ok";
}

function modelFiles(vault: string): string {
  const names: string[] = [];
  for (const rel of ["models", ".kizuki/models"]) {
    const path = join(vault, rel);
    if (existsSync(path)) {
      check(lstatSync(path).isDirectory() && !lstatSync(path).isSymbolicLink(), "models_directory");
      for (const name of readdirSync(path).sort()) { check(names.length < 32, "models_limit"); names.push(`${rel}/${name}`); }
    }
  }
  return sha(JSON.stringify(names));
}

export async function startNativeModelEndpoint(workspace: string, mode: "ok" | "unavailable", reuse?: { port: number; key: string }) {
  mkdirSync(workspace, { recursive: true, mode: 0o700 });
  const keyPath = join(workspace, "fixture.key"), readyPath = join(workspace, "ready.json"), observationPath = join(workspace, "observation.json");
  check(reuse === undefined || (Number.isInteger(reuse.port) && reuse.port > 0 && reuse.port <= 65535 && /^[0-9a-f]{48}$/.test(reuse.key)), "endpoint_reuse");
  writeFileSync(keyPath, reuse?.key ?? randomBytes(24).toString("hex"), { flag: "wx", mode: 0o600 });
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "native-model-endpoint.ts"), workspace, mode, String(reuse?.port ?? 0)], {
    env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" }, stdin: "ignore", stdout: "ignore", stderr: "ignore",
  });
  let stopped = false;
  const stop = async () => {
    if (stopped) return; stopped = true;
    if (child.exitCode === null) child.kill("SIGTERM");
    const timer = setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); }, 2000);
    try { await child.exited; } finally { clearTimeout(timer); }
  };
  try {
    const deadline = Date.now() + 5000;
    while (!existsSync(readyPath) && child.exitCode === null && Date.now() < deadline) await Bun.sleep(20);
    check(existsSync(readyPath) && child.exitCode === null, "endpoint_start");
    const ready = JSON.parse(readFileSync(readyPath, "utf8"));
    check(Object.keys(ready).sort().join() === "pid,port" && ready.pid === child.pid && Number.isInteger(ready.port) && ready.port > 0 && ready.port <= 65535, "endpoint_identity");
    check(reuse === undefined || ready.port === reuse.port, "endpoint_port");
    return { port: ready.port as number, endpoint: `http://127.0.0.1:${ready.port}/v1`, key: readFileSync(keyPath, "utf8"), stop,
      observation: () => {
        const stat = lstatSync(observationPath); check(stat.isFile() && !stat.isSymbolicLink() && stat.size < 1024, "endpoint_observation");
        const row = JSON.parse(readFileSync(observationPath, "utf8"));
        check(Object.keys(row).sort().join() === "requests,unexpected" && [row.requests,row.unexpected].every(n => Number.isSafeInteger(n) && n >= 0 && n <= 32), "endpoint_counts");
        return row as { requests: number; unexpected: number };
      } };
  } catch (error) { await stop(); throw error; }
}

/** Services belong to the existing native controller; this helper only supplies fixture data and observations. */
export async function runNativeModelMatrix(host: NativeModelHost): Promise<void> {
  for (const id of MODEL_PHASE_IDS) {
    const workspace = join(host.workspace, id), vault = join(workspace, "vault"), notes = join(workspace, "notes");
    mkdirSync(notes, { recursive: true, mode: 0o700 });
    const endpoint = await startNativeModelEndpoint(join(workspace, "endpoint"), id === "model-unavailable" ? "unavailable" : "ok");
    let activated = false;
    let recoveredEndpoint: Awaited<ReturnType<typeof startNativeModelEndpoint>> | null = null;
    try {
      check(host.invoke(["init", vault, "--no-service", "--no-default"]).exit_code === 0, "init");
      const key = join(vault, ".kizuki/model-fixture.key"), config = join(vault, ".kizuki/serve.toml");
      if (id !== "model-absent") writeFileSync(key, endpoint.key, { flag: "wx", mode: 0o600 });
      writeFileSync(config, `[serve]\nbind_port=0\n` + (id === "model-absent" ? "" :
        `[ports.llm]\nid="kizuki.llm.openai-compatible"\nbase_url=${JSON.stringify(endpoint.endpoint)}\nmodel=${JSON.stringify(MODEL)}\nsecret_ref=${JSON.stringify(`file:${key}`)}\ntimeout_ms=1000\nmax_retries=0\n`), { mode: 0o600 });
      const configHash = sha(readFileSync(config)), weightsHash = modelFiles(vault);
      writeFileSync(join(notes, "ada.md"), SOURCE_TEXT, { mode: 0o600 });
      const policy = join(workspace, "policy.json");
      writeFileSync(policy, JSON.stringify({ purposes: ["capture","recall","session","derive","extract","export"], allowed_fields: ["text","subjects","attachments","metadata"],
        retention: "persistent_owned_until_revoked", egress: id === "model-absent" ? "local_only" : { model_endpoint: `${endpoint.endpoint}/chat/completions`, model: MODEL, external_retention: "provider_managed" }, sensitivity_floor: "public" }), { mode: 0o600 });
      check(host.invoke(["import", "markdown-folder", "--source", notes, "--policy", policy, "--expected-revision", "0", "--operation-id", id, "--vault", vault]).exit_code === 0, "import");
      if (id === "model-credential-loss") unlinkSync(key);
      if (id === "model-dependency-offline") await endpoint.stop();
      const instance = await host.activate(vault); activated = true;
      let observation: ReturnType<typeof readInstalledModelAttempt> = null;
      const deadline = Date.now() + 30_000;
      while (observation === null && Date.now() < deadline) { observation = readInstalledModelAttempt(vault, instance); if (observation === null) await Bun.sleep(100); }
      check(observation !== null, "receipt_missing");
      const result = host.invoke(["query", "Orchard", "--json", "--vault", vault]);
      const modelQuery = host.invoke(["query", "operations", "--json", "--vault", vault]);
      const sourceHits = readStrictNativeQuery(result), modelHits = readStrictNativeQuery(modelQuery);
      const modelOutputReadable = modelHits.some(hit => hit.scope === "canon" && hit.authority === "model_inference" && hit.snippet.includes("operations"));
      const counts = endpoint.observation(), receipt = observation!.receipt;
      const evidence: NativeModelEvidence = { ...instance, receipt_run_id: receipt.run_id, receipt_status: receipt.status,
        model_calls: receipt.model.calls, model_unavailable: receipt.model.unavailable, claims_extracted: receipt.claims_extracted, canon_writes: receipt.canon_writes,
        endpoint_requests: counts.requests, unexpected_requests: counts.unexpected, credential_present: existsSync(key), model_configured: id !== "model-absent",
        source_event_present: observation!.source_event_present, query_preserved: sourceHits.some(hit => hit.scope === "ledger" && hit.authority === "connector_evidence" && hit.snippet === SOURCE_TEXT),
        weights_unchanged: modelFiles(vault) === weightsHash, config_unchanged: sha(readFileSync(config)) === configHash,
        configuration_unavailable: receipt.errors.includes("model configuration unavailable"), daemon_active: host.stillActive(vault, instance),
        model_ref_sha256: receipt.model.model_ref_sha256 ?? null, model_claims: observation!.model_claims, model_canon_receipts: observation!.model_canon_receipts, model_output_readable: modelOutputReadable, recovery: null };
      let recoveryReceipt: typeof receipt | null = null;
      if (id === "model-dependency-offline") {
        // Preserve the unavailable startup observation; recovery is a new installed-service instance.
        await host.deactivate(vault); activated = false;
        const stopConfirmed = !host.stillActive(vault, instance) && !existsSync(join(vault, ".kizuki/serve.pid"));
        const schedulingOverride = prepareModelRecoverySchedule(vault, stopConfirmed);
        recoveredEndpoint = await startNativeModelEndpoint(join(workspace, "recovered-endpoint"), "ok", { port: endpoint.port, key: endpoint.key });
        const recovered = await host.activate(vault); activated = true;
        let next: ReturnType<typeof readInstalledModelAttempt> = null;
        const recoveryDeadline = Date.now() + 30_000;
        while (next === null && Date.now() < recoveryDeadline) { next = readInstalledModelAttempt(vault, recovered); if (next === null) await Bun.sleep(100); }
        check(next !== null, "recovery_receipt_missing");
        const recoveredSource = host.invoke(["query", "Orchard", "--json", "--vault", vault]);
        const recoveredModel = host.invoke(["query", "operations", "--json", "--vault", vault]);
        const recoveredCounts = recoveredEndpoint.observation(), nextReceipt = next!.receipt;
        recoveryReceipt = nextReceipt;
        const recoveredSourceHits = readStrictNativeQuery(recoveredSource), recoveredModelHits = readStrictNativeQuery(recoveredModel);
        evidence.recovery = { stop_confirmed: stopConfirmed, receipt_trigger: nextReceipt.execution?.trigger ?? "absent", receipt_due_at: nextReceipt.execution?.due_at ?? null, scheduling_override: schedulingOverride, trigger: "service-restart", ...recovered, receipt_run_id: nextReceipt.run_id, receipt_status: nextReceipt.status,
          model_calls: nextReceipt.model.calls, model_unavailable: nextReceipt.model.unavailable, claims_extracted: nextReceipt.claims_extracted, canon_writes: nextReceipt.canon_writes,
          endpoint_requests: recoveredCounts.requests, unexpected_requests: recoveredCounts.unexpected, model_claims: next!.model_claims, model_canon_receipts: next!.model_canon_receipts,
          model_output_readable: recoveredModelHits.some(hit => hit.scope === "canon" && hit.authority === "model_inference" && hit.snippet.includes("operations")),
          source_event_present: next!.source_event_present, query_preserved: recoveredSourceHits.some(hit => hit.scope === "ledger" && hit.authority === "connector_evidence" && hit.snippet === SOURCE_TEXT),
          daemon_active: host.stillActive(vault, recovered), config_unchanged: sha(readFileSync(config)) === configHash,
          credential_unchanged: readFileSync(key, "utf8") === endpoint.key, endpoint_unchanged: recoveredEndpoint.endpoint === endpoint.endpoint };
      }
      const phase = { id, passed: modelPhasePassed(id, evidence), evidence };
      host.record(phase);
      const diagnostic = modelFailureDiagnostic(phase, receipt, recoveryReceipt, endpoint.key);
      if (diagnostic !== null) host.diagnostic?.(diagnostic);
    } finally {
      try { if (activated) await host.deactivate(vault); } finally { try { await recoveredEndpoint?.stop(); } finally { await endpoint.stop(); } }
    }
  }
}
