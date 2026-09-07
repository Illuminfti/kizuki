import { Database } from "bun:sqlite";
import { join } from "node:path";
import { parseRunReceipt, redactReceiptError, redactReceiptText } from "../packages/core/src/serve/receipts";
import { RAIL_IDS } from "../packages/core/src/serve/types";
import { isPlainObject } from "../packages/core/src/util/validate";
import { requireRegularFile } from "./release-artifacts";

type CommandResult = { exit_code: number; stdout: string; stderr: string };
const strings = (value: unknown): string[] => Array.isArray(value)
  ? value.slice(0, 16).map(item => item === "identity-authority-unavailable" ? item : typeof item === "string" ? redactReceiptText(item).slice(0, 240) : "invalid diagnostic") : [];
type RailDiagnostic = {
  rail: string; status: string; finished_at: string; current_instance: boolean;
  errors: string[]; retrieval_degraded: string[];
};
export type NativeRailDiagnostics = {
  complete: boolean; truncated: boolean; error: string | null; receipts: RailDiagnostic[];
};

/** Only the harness-created synthetic vault is admitted by the lifecycle caller.
 * This diagnostic connection permits SQLite WAL access, then forbids SQL writes.
 * It never initializes a schema, migrates a database or repairs a journal.
 */
export function readNativeRailDiagnostics(vault: string, expected: { pid: number; instance_id: string }, since: string): NativeRailDiagnostics {
  let db: Database | undefined;
  let result: NativeRailDiagnostics = { complete: false, truncated: false, error: null, receipts: [] };
  try {
    const path = join(vault, ".kizuki", "kizuki.db"); requireRegularFile(path);
    db = new Database(path, { readwrite: true, create: false });
    db.exec("PRAGMA query_only = ON"); db.exec("PRAGMA busy_timeout = 500");
    const rows = db.query<{ run_id: string; rail: string; status: string; finished_at: string; report: string | null }, [string]>(
      `SELECT run_id,rail,status,finished_at,
        CASE WHEN length(CAST(report AS BLOB)) <= 65536 THEN report ELSE NULL END AS report
        FROM run_receipts WHERE finished_at >= ? ORDER BY finished_at DESC,run_id DESC LIMIT 33`,
    ).all(since);
    const truncated = rows.length > 32;
    const receipts = rows.slice(0, 32).map(row => {
      if (row.report === null) throw Error("run receipt exceeds diagnostic bound");
      const receipt = parseRunReceipt(JSON.parse(row.report));
      if (receipt === null || receipt.run_id !== row.run_id || receipt.rail !== row.rail || receipt.status !== row.status ||
          receipt.finished_at !== row.finished_at || !RAIL_IDS.includes(receipt.rail as typeof RAIL_IDS[number])) throw Error("run receipt diagnostic identity mismatch");
      return { rail: receipt.rail, status: receipt.status, finished_at: receipt.finished_at,
        current_instance: receipt.execution?.instance_id === expected.instance_id && receipt.execution.pid === expected.pid,
        errors: strings(receipt.errors), retrieval_degraded: strings(receipt.retrieval.degraded) };
    });
    result = { complete: RAIL_IDS.every(rail => receipts.some(row => row.current_instance && row.rail === rail)), truncated, error: null, receipts };
  } catch (error) {
    result = { complete: false, truncated: false, error: redactReceiptError(error), receipts: [] };
  } finally {
    try { db?.close(); } catch { result.complete = false; result.error = "diagnostic database close failed"; }
  }
  return result;
}

/** Wait for first-run receipt coverage, never for a failed rail to become healthy. */
export async function waitForFreshRails(read: () => NativeRailDiagnostics, timeoutMs = 30_000): Promise<NativeRailDiagnostics> {
  const deadline = Date.now() + timeoutMs;
  let observed = read();
  while (!observed.complete && observed.error === null && !observed.truncated && Date.now() < deadline) {
    await Bun.sleep(200); observed = read();
  }
  return observed;
}

/** A healthy PID is independent from healthy installed rails. No model is required. */
export function installedRailsHealth(status: CommandResult, diagnostics: NativeRailDiagnostics, since: string, now = Date.now()) {
  try {
    const envelope = JSON.parse(status.stdout);
    if (!isPlainObject(envelope) || !isPlainObject(envelope.data) || !isPlainObject(envelope.data.doctor)) throw Error("public serve doctor unavailable");
    const doctor = envelope.data.doctor, model = isPlainObject(doctor.model) ? doctor.model : {}, stores = isPlainObject(doctor.stores) ? doctor.stores : {};
    const rails = Array.isArray(doctor.rails) ? doctor.rails : [];
    const fresh = RAIL_IDS.every(rail => {
      const matches = rails.filter(row => isPlainObject(row) && row.rail === rail);
      const row = matches[0];
      return matches.length === 1 && row.status === "ok" && typeof row.last_receipt_at === "string" &&
        Date.parse(row.last_receipt_at) >= Date.parse(since) && now - Date.parse(row.last_receipt_at) >= 0 && now - Date.parse(row.last_receipt_at) <= 60_000;
    });
    const passed = status.exit_code === 0 && envelope.schema === "kizuki.cli.serve/v1" && envelope.status === "ok" && doctor.ok === true &&
      model.canon_writing === "off" && model.model_ref === null && fresh && diagnostics.complete && !diagnostics.truncated && diagnostics.error === null &&
      diagnostics.receipts.filter(row => row.current_instance).every(row => row.status === "ok" && row.errors.length === 0 && row.retrieval_degraded.length === 0);
    return { passed, evidence: { exit_code: status.exit_code, doctor_ok: doctor.ok === true, canon_writing: model.canon_writing === "off" ? "off" : "unexpected",
      failures: strings(doctor.failures), identity_degraded: strings(stores.degraded), rails: rails.slice(0, 8).map(row => isPlainObject(row) ? {
        rail: strings([row.rail])[0], status: strings([row.status])[0], reason: row.reason === null ? null : strings([row.reason])[0],
      } : { invalid: true }), diagnostics } };
  } catch (error) { return { passed: false, evidence: { exit_code: status.exit_code, error: redactReceiptError(error), diagnostics } }; }
}

/** Health failure is durable while independent lifecycle steps remain runnable. */
export function recordInstalledHealth(
  steps: { id: string; passed: boolean; evidence: unknown }[], failures: string[], health: ReturnType<typeof installedRailsHealth>,
): void {
  steps.push({ id: "installed-rails-healthy", ...health });
  if (!health.passed) failures.push("installed-rails-healthy failed");
}
