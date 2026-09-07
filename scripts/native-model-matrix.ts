import { createHash, randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { manageDatabaseLifetime } from "../packages/core/src/ledger/lifetime";
import { configureLedgerWalLifecycle } from "../packages/core/src/ledger/wal-lifecycle";
import { parseRunReceipt } from "../packages/core/src/serve/receipts";

export const MODEL_PHASE_IDS = ["model-absent", "model-configured", "model-unavailable", "model-credential-loss", "model-dependency-offline"] as const;
export type ModelPhaseId = typeof MODEL_PHASE_IDS[number];
export type NativeModelEvidence = {
  instance_id: string; pid: number; started_at: string; receipt_run_id: string; receipt_status: string;
  model_calls: number; model_unavailable: number; claims_extracted: number; canon_writes: number;
  endpoint_requests: number; unexpected_requests: number; credential_present: boolean; model_configured: boolean;
  source_event_present: boolean; query_preserved: boolean; weights_unchanged: boolean; config_unchanged: boolean;
  configuration_unavailable: boolean; daemon_active: boolean; model_ref_sha256: string | null;
  model_claims: number; model_canon_receipts: number; model_output_readable: boolean;
};
export type NativeModelPhase = { id: ModelPhaseId; passed: boolean; evidence: NativeModelEvidence };
export type NativeModelInstance = { pid: number; instance_id: string; started_at: string };
export type NativeModelHost = {
  executable: string; workspace: string; env: Record<string, string>;
  invoke(args: string[]): { exit_code: number; stdout: string; stderr: string };
  activate(vault: string): Promise<NativeModelInstance>;
  stillActive(vault: string, instance: NativeModelInstance): boolean;
  deactivate(vault: string): Promise<void>;
  record(phase: NativeModelPhase): void;
};
const sha = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const check = (value: unknown, code: string): void => { if (!value) throw new Error(`native_model_${code}`); };
const MODEL = "native-lifecycle-synthetic";
const SOURCE_TEXT = "Ada is the coordinator for Orchard library.\n";

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

/** Closed phase predicate: a prior successful receipt cannot certify a later failure case. */
export function modelPhasePassed(id: ModelPhaseId, e: NativeModelEvidence): boolean {
  const common = e.daemon_active && e.pid > 1 && e.instance_id.length > 0 && e.receipt_run_id.length > 0 &&
    e.source_event_present && e.query_preserved && e.weights_unchanged && e.config_unchanged && e.unexpected_requests === 0;
  if (!common) return false;
  if (id === "model-absent") return !e.model_configured && !e.credential_present && e.model_calls === 0 && e.endpoint_requests === 0 && e.model_ref_sha256 === null && !e.configuration_unavailable;
  if (!e.model_configured) return false;
  if (id === "model-credential-loss") return !e.credential_present && e.configuration_unavailable && e.model_calls === 0 && e.endpoint_requests === 0 && e.claims_extracted === 0 && e.canon_writes === 0;
  if (!e.credential_present || e.configuration_unavailable || e.model_ref_sha256 === null) return false;
  if (id === "model-configured") return e.receipt_status === "ok" && e.model_calls === 1 && e.model_unavailable === 0 && e.endpoint_requests === 1 && e.claims_extracted === 1 && e.canon_writes > 0 && e.model_claims === 1 && e.model_canon_receipts > 0 && e.model_output_readable;
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

export async function startNativeModelEndpoint(workspace: string, mode: "ok" | "unavailable") {
  mkdirSync(workspace, { recursive: true, mode: 0o700 });
  const keyPath = join(workspace, "fixture.key"), readyPath = join(workspace, "ready.json"), observationPath = join(workspace, "observation.json");
  writeFileSync(keyPath, randomBytes(24).toString("hex"), { flag: "wx", mode: 0o600 });
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "native-model-endpoint.ts"), workspace, mode], {
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
    return { endpoint: `http://127.0.0.1:${ready.port}/v1`, key: readFileSync(keyPath, "utf8"), stop,
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
      const result = host.invoke(["query", "Orchard", "--degraded", "--vault", vault]);
      const modelQuery = host.invoke(["query", "operations", "--json", "--degraded", "--vault", vault]);
      const modelOutputReadable = modelQuery.exit_code === 0 && modelQuery.stdout.includes("model_inference") && modelQuery.stdout.includes("operations");
      const counts = endpoint.observation(), receipt = observation!.receipt;
      const evidence: NativeModelEvidence = { ...instance, receipt_run_id: receipt.run_id, receipt_status: receipt.status,
        model_calls: receipt.model.calls, model_unavailable: receipt.model.unavailable, claims_extracted: receipt.claims_extracted, canon_writes: receipt.canon_writes,
        endpoint_requests: counts.requests, unexpected_requests: counts.unexpected, credential_present: existsSync(key), model_configured: id !== "model-absent",
        source_event_present: observation!.source_event_present, query_preserved: result.exit_code === 0 && result.stdout.includes("Orchard"),
        weights_unchanged: modelFiles(vault) === weightsHash, config_unchanged: sha(readFileSync(config)) === configHash,
        configuration_unavailable: receipt.errors.includes("model configuration unavailable"), daemon_active: host.stillActive(vault, instance),
        model_ref_sha256: receipt.model.model_ref_sha256 ?? null, model_claims: observation!.model_claims, model_canon_receipts: observation!.model_canon_receipts, model_output_readable: modelOutputReadable };
      host.record({ id, passed: modelPhasePassed(id, evidence), evidence });
    } finally {
      try { if (activated) await host.deactivate(vault); } finally { await endpoint.stop(); }
    }
  }
}
