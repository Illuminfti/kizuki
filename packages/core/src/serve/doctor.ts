import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { isMachineOriginPath } from "../canon/origin";
import { formatProducerDiagnostic } from "../producer/diagnostics";
import { pendingRetrievalOps } from "../claims/store";
import { readDerivedMeta } from "../derived-meta";
import { ConnectionStateStore } from "../ledger/connection-state";
import { inspectCheckpoints, inspectConnections } from "../ledger/connections";
import { tableExists } from "../ledger/schema";
import { inspectPurgeHealth } from "../ledger/purge";
import { listCanonPagesReport } from "../vault/pages";
import { loadConfiguredModelRef, loadServeConfig } from "./config";
import { readServeIntent } from "./intent";
import { serviceFile } from "./service-files";
import { isRedactedModelReference, listRunReceipts, orphanJournalReceipts, readModelRunHistory, redactReceiptText, type ModelRunHistory } from "./receipts";
import { sha256Hex } from "../util/hash";
import { listSchedules } from "./schema";
import type { SupervisorHost } from "./supervisor";
import { queryServeService } from "./supervisor";
import {
  CALIBRATION_BAND,
  CONFIDENCE_SPREAD_MIN,
  DEFAULT_RAILS,
  EMPTY_STREAK,
  RETRIEVAL_SLA_SECONDS,
  RUN_RECEIPT_RETENTION_DAYS,
  type CalibrationDoctor,
  type ModelDoctor,
  type RailDoctor,
  type RailId,
  type RunReceipt,
  type ServeDoctorReport,
  type ServeIntent,
  type StoreDoctor,
  type SupervisorStatus,
} from "./types";

export interface ServeDoctorOptions {
  readonly now?: string;
  readonly supervisor?: SupervisorHost;
  readonly model_ref?: string | null;
  /** Raw config intent is shown as unverified until a host binds its port. */
  readonly configured_model_ref?: string | null;
}

function ageSeconds(from: string | null, now: string): number | null {
  if (from === null) return null;
  const start = Date.parse(from);
  const end = Date.parse(now);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, Math.floor((end - start) / 1000));
}

function produced(receipt: RunReceipt): boolean {
  return (
    receipt.events_stored > 0 ||
    receipt.claims_written > 0 ||
    receipt.canon_writes > 0 ||
    receipt.retrieval.upserts > 0 ||
    receipt.retrieval.removals > 0
  );
}

function railDoctor(
  rail: RailId,
  receipts: RunReceipt[],
  period_s: number,
  now: string,
  expectLiveness: boolean,
): RailDoctor {
  const forRail = receipts.filter((receipt) => receipt.rail === rail);
  const last = forRail.at(-1) ?? null;
  const age = ageSeconds(last?.finished_at ?? null, now);
  let empty = 0;
  for (let index = forRail.length - 1; index >= 0; index -= 1) {
    const receipt = forRail[index];
    if (receipt === undefined || produced(receipt)) break;
    empty += 1;
  }
  const grace = period_s;
  const stale = age !== null && age > 2 * period_s + grace;
  const failed = last?.status === "failed";
  const emptyDown = empty >= EMPTY_STREAK;
  const neverRan = last === null && expectLiveness;
  let status: RailDoctor["status"] = "ok";
  let reason: string | null = null;
  if (neverRan) {
    status = "down";
    reason = "no receipt";
  } else if (stale && expectLiveness) {
    status = "down";
    reason = `stale ${age}s (period ${period_s}s)`;
  } else if (failed) {
    status = "down";
    reason = "last run failed";
  } else if (emptyDown && expectLiveness) {
    status = "down";
    reason = `empty streak ${empty}`;
  } else if (last === null) {
    status = "idle";
  }
  return {
    rail,
    last_receipt_at: last?.finished_at ?? null,
    age_s: age,
    period_s,
    status,
    reason,
    empty_streak: empty,
  };
}

function stdev(values: number[]): number | null {
  if (values.length === 0) return null;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance =
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function calibration(db: Database, receipts: RunReceipt[], now: string): CalibrationDoctor {
  const failures: string[] = [];
  if (receipts.length === 0) {
    return {
      window_days: RUN_RECEIPT_RETENTION_DAYS,
      write_rate: null,
      dedup_rate: null,
      confidence_spread: null,
      canon_writes_today: 0,
      top_subjects: [],
      failures,
    };
  }
  const extracted = receipts.reduce((sum, receipt) => sum + receipt.claims_extracted, 0);
  const written = receipts.reduce((sum, receipt) => sum + receipt.claims_written, 0);
  const deduped = receipts.reduce((sum, receipt) => sum + receipt.claims_deduped, 0);
  const writeRate = written / Math.max(1, extracted);
  const dedupRate = deduped / Math.max(1, extracted);
  if (extracted > 0 && (writeRate < CALIBRATION_BAND.min || writeRate > CALIBRATION_BAND.max)) {
    failures.push(`write_rate ${writeRate.toFixed(3)} outside [${CALIBRATION_BAND.min}, ${CALIBRATION_BAND.max}]`);
  }
  const confidences = tableExists(db, "claims")
    ? db
        .query<{ confidence: number }, []>(
          `SELECT confidence FROM claims
            WHERE status IN ('live', 'superseded')
            ORDER BY asserted_at DESC
            LIMIT 10000`,
        )
        .all()
        .map((row) => row.confidence)
    : [];
  const spread = stdev(confidences);
  if (spread !== null && confidences.length >= 8 && spread < CONFIDENCE_SPREAD_MIN) {
    failures.push("confidence_not_produced");
  }
  const today = now.slice(0, 10);
  const canonToday = receipts
    .filter((receipt) => receipt.finished_at.startsWith(today))
    .reduce((sum, receipt) => sum + receipt.canon_writes, 0);
  const subjects = tableExists(db, "claims")
    ? db
        .query<{ subject: string; writes: number }, []>(
          `SELECT subject, COUNT(*) AS writes FROM claims
            WHERE asserted_at >= datetime('now', '-7 days')
            GROUP BY subject
            ORDER BY writes DESC, subject
            LIMIT 8`,
        )
        .all()
    : [];
  return {
    window_days: RUN_RECEIPT_RETENTION_DAYS,
    write_rate: writeRate,
    dedup_rate: dedupRate,
    confidence_spread: spread,
    canon_writes_today: canonToday,
    top_subjects: subjects,
    failures,
  };
}

/** Whole-call rejection is distinct from a counted, permitted draft drop. */
function modelFailure(receipt: RunReceipt): string | null {
  if (receipt.model.diagnostic !== undefined) return formatProducerDiagnostic(receipt.model.diagnostic);
  if (receipt.model.usage_unknown === true) return "model attempt interrupted; token usage unknown";
  if (receipt.model.unavailable > 0) return "model unavailable";
  for (const reason of ["tool_call_in_response", "fence_leak", "schema_invalid", "provenance_not_cited", "budget_exhausted"]) {
    if ((receipt.claims_rejected[reason] ?? 0) > 0 || receipt.errors.includes(reason)) return `model result rejected: ${reason.replaceAll("_", " ")}`;
  }
  return null;
}

function modelDoctor(
  history: ModelRunHistory,
  modelRef: string | null | undefined,
  configuredModelRef: string | null | undefined,
  configCanonDay: number,
  usedToday: number,
): ModelDoctor {
  const receipts = history.receipts;
  const on = typeof modelRef === "string" && modelRef.length > 0;
  const unverified = !on && typeof configuredModelRef === "string" && configuredModelRef.length > 0;
  const currentRef = on ? modelRef : unverified ? configuredModelRef : null;
  const currentDigest = currentRef === null ? null : sha256Hex(currentRef);
  const displayRef = currentRef === null ? null : redactReceiptText(currentRef);
  const current = currentRef === null ? [] : receipts.filter((receipt): receipt is RunReceipt => receipt !== null && receipt.rail === "sync" && (
    receipt.model.model_ref_sha256 !== undefined ? receipt.model.model_ref_sha256 === currentDigest :
      receipt.model.model_ref !== null && !isRedactedModelReference(receipt.model.model_ref) && receipt.model.model_ref === currentRef
  ));
  const unattributed = currentRef === null ? [] : receipts.filter((receipt): receipt is RunReceipt => receipt !== null && receipt.rail === "sync" &&
    receipt.model.model_ref_sha256 === undefined && receipt.model.model_ref !== null && isRedactedModelReference(receipt.model.model_ref) &&
    receipt.model.model_ref === displayRef && (receipt.model.calls > 0 || modelFailure(receipt) !== null));
  const latestFirst = [...current].reverse();
  const lastOk = latestFirst.find(receipt => receipt.model.calls > 0 && modelFailure(receipt) === null);
  const lastFailed = latestFirst.find(receipt => modelFailure(receipt) !== null);
  const lastFailure = lastFailed === undefined ? null : { at: lastFailed.finished_at, detail: modelFailure(lastFailed)! };
  const lastAttempt = latestFirst.find(receipt => receipt.model.calls > 0 || modelFailure(receipt) !== null);
  const currentFailure = lastAttempt !== undefined && modelFailure(lastAttempt) !== null ? lastFailure : null;
  const lastUnattributed = unattributed.at(-1);
  // Use the durable receipt order, including its run-id tie break. An older
  // known success cannot resolve a newer potentially matching unknown attempt.
  const lastAttemptIndex = lastAttempt === undefined ? -1 : receipts.lastIndexOf(lastAttempt);
  const historyUnverified = (lastUnattributed !== undefined && receipts.lastIndexOf(lastUnattributed) > lastAttemptIndex) ||
    receipts.lastIndexOf(null) > lastAttemptIndex || (history.truncated && lastAttempt === undefined);
  const unavailable = current.reduce((sum, receipt) => sum + receipt.model.unavailable, 0);
  return {
    canon_writing: on ? "on" : unverified ? "unverified" : "off",
    model_ref: on ? displayRef : null,
    last_success_at: lastOk?.finished_at ?? null,
    last_failure: lastFailure,
    current_failure: currentFailure,
    unattributed_receipts: unattributed.length,
    history_unverified: historyUnverified,
    history_truncated: history.truncated,
    unavailable,
    budget: {
      canon_writes_per_day: { used: usedToday, limit: configCanonDay },
    },
    detail: (on
      ? `canon writing: on (${displayRef}); last_success=${lastOk?.finished_at ?? "never"} unavailable=${unavailable}${lastFailure === null ? "" : `; last_failure=${lastFailure.detail} (at ${lastFailure.at})`}`
      : unverified
        ? "canon writing: unverified (model configured but not bound by the running host)"
      : "canon writing: off (no model configured — connectors, ledger, search, timeline and undo still work)") +
      (unattributed.length === 0 ? "" : `; model history: unattributed receipts=${unattributed.length}`) +
      (history.truncated ? "; selected history window truncated; last_success, last_failure and counts cover only selected receipts" : "") +
      (historyUnverified ? "; current history unverified" : ""),
  };
}

function countWriterRoles(db: Database): StoreDoctor["writers"] {
  const writers = {
    loop: 0,
    correction: 0,
    import: 0,
    revert: 0,
  };
  if (!tableExists(db, "canon_receipts")) return writers;
  const rows = db
    .query<{ writer: string; n: number }, []>(
      "SELECT writer, COUNT(*) AS n FROM canon_receipts GROUP BY writer",
    )
    .all();
  for (const row of rows) {
    switch (row.writer) {
      case "loop":
      case "correction":
      case "import":
      case "revert":
        writers[row.writer] = row.n;
        break;
      default:
        break;
    }
  }
  return writers;
}

function countOriginPages(vaultPath: string): StoreDoctor["origin"] {
  const report = listCanonPagesReport(vaultPath);
  let machine = 0;
  let human = 0;
  for (const relPath of [
    ...report.pages.map((page) => page.relPath),
    ...report.skipped.map((page) => page.relPath),
  ]) {
    if (isMachineOriginPath(relPath)) machine += 1;
    else human += 1;
  }
  return { machine, human };
}

function storeDoctor(
  db: Database,
  vaultPath: string,
  now: string,
): StoreDoctor {
  const pendingRetrieval = pendingRetrievalOps(db, 10_000);
  const oldestRetrieval =
    tableExists(db, "retrieval_ops") && pendingRetrieval.length > 0
      ? db
          .query<{ created_at: string }, []>(
            `SELECT created_at FROM retrieval_ops
              WHERE state = 'pending' ORDER BY created_at LIMIT 1`,
          )
          .get()?.created_at ?? null
      : null;
  const purge = inspectPurgeHealth(db, now);
  const pendingPurge = tableExists(db, "purge_ops")
    ? db
        .query<{ n: number }, []>(
          "SELECT COUNT(*) AS n FROM purge_ops WHERE state = 'pending'",
        )
        .get()?.n ?? 0
    : 0;
  const oldestPurge = tableExists(db, "purge_ops")
    ? db
        .query<{ created_at: string }, []>(
          `SELECT created_at FROM purge_ops
            WHERE state = 'pending' ORDER BY created_at LIMIT 1`,
        )
        .get()?.created_at ?? null
    : null;
  const oldestRetrievalAge = ageSeconds(oldestRetrieval, now);
  const degraded: string[] = [];
  if (oldestRetrievalAge !== null && oldestRetrievalAge > RETRIEVAL_SLA_SECONDS) {
    degraded.push("retrieval-ops-stale");
  }
  if (!purge.ok) degraded.push("purge-unhealthy");
  degraded.push("identity-authority-unavailable");
  const search = readDerivedMeta(db, "search");
  const graph = readDerivedMeta(db, "graph");
  return {
    pending_retrieval_ops: pendingRetrieval.length,
    oldest_retrieval_op_age_s: oldestRetrievalAge,
    pending_purge_ops: pendingPurge,
    oldest_purge_op_age_s: ageSeconds(oldestPurge, now),
    orphan_run_receipts: orphanJournalReceipts(db, vaultPath),
    derived: {
      search: {
        rebuilt_at: search?.rebuilt_at ?? null,
        doc_count: search?.doc_count ?? 0,
      },
      graph: {
        rebuilt_at: graph?.rebuilt_at ?? null,
        doc_count: graph?.doc_count ?? 0,
      },
    },
    writers: countWriterRoles(db),
    origin: countOriginPages(vaultPath),
    degraded,
  };
}

function expectRailLiveness(intent: ServeIntent | "unknown", supervisor: SupervisorStatus): boolean {
  return intent === "installed" && supervisor.state === "active";
}

export function inspectServeDoctor(
  db: Database,
  vaultPath: string,
  options: ServeDoctorOptions = {},
): ServeDoctorReport {
  const now = options.now ?? new Date().toISOString();
  let intent: ServeIntent | "unknown";
  try { intent = readServeIntent(vaultPath); }
  catch { intent = "unknown"; }
  const supervisor = options.supervisor
    ? queryServeService(vaultPath, options.supervisor)
    : {
        kind: "none" as const,
        state: "none" as const,
        unit: null,
        enabled: false,
        detail: "supervisor: none (loop runs only while you run it)",
      };
  const since = new Date(Date.parse(now) - RUN_RECEIPT_RETENTION_DAYS * 86_400_000).toISOString();
  const receipts = listRunReceipts(db, { since });
  const expectLive = expectRailLiveness(intent, supervisor);
  const schedules = new Map(listSchedules(db).map((row) => [row.rail, row]));
  const rails = DEFAULT_RAILS.map((spec) => {
    const schedule = schedules.get(spec.rail);
    return railDoctor(
      spec.rail,
      receipts,
      schedule?.period_s ?? spec.period_s,
      now,
      expectLive,
    );
  });
  const config = loadServeConfig(vaultPath);
  const usedToday = receipts
    .filter((receipt) => receipt.finished_at.startsWith(now.slice(0, 10)))
    .reduce((sum, receipt) => sum + receipt.canon_writes, 0);
  const modelRef = options.model_ref ?? null;
  const configuredModelRef = options.configured_model_ref ?? loadConfiguredModelRef(vaultPath);
  const modelHistory = modelRef || configuredModelRef ? readModelRunHistory(db, since) : { receipts: [], truncated: false };
  const model = modelDoctor(modelHistory, modelRef, configuredModelRef, config.canon_writes_per_day, usedToday);
  const stores = storeDoctor(db, vaultPath, now);
  const cal = calibration(db, receipts, now);
  const failures: string[] = [];
  if (model.current_failure !== null) failures.push(`${model.current_failure.detail} (at ${model.current_failure.at})`);
  if (model.history_unverified) failures.push("model history unverified; the latest current-model attempt cannot be established from retained receipts");
  if (intent === "unknown") failures.push("service intent unavailable or invalid");
  else if (intent !== "installed" && (supervisor.enabled || supervisor.state === "active")) {
    failures.push("supervisor active or enabled without installed intent");
  }
  try {
    if (serviceFile(join(vaultPath, ".kizuki", "service-change.json")) !== null) failures.push("service change recovery pending");
  } catch { failures.push("service recovery state unavailable"); }
  if (intent === "installed" && (supervisor.state !== "active" || !supervisor.enabled)) {
    failures.push(`supervisor ${supervisor.state}${supervisor.state === "active" ? " but not enabled" : ""}`);
  }
  for (const rail of rails) {
    if (rail.status === "down" && rail.reason !== null) {
      failures.push(`rail ${rail.rail}: ${rail.reason}`);
    }
  }
  failures.push(...cal.failures);
  if (stores.orphan_run_receipts.length > 0) {
    failures.push(`orphan run receipts ${stores.orphan_run_receipts.length}`);
  }
  try {
    const recovery = new ConnectionStateStore(join(vaultPath, ".kizuki")).recover(db);
    if (recovery.unresolved.length > 0) {
      failures.push(`connection state journals unresolved ${recovery.unresolved.length}`);
    }
    if (recovery.quarantined.length > 0) {
      failures.push(`connection state journals quarantined ${recovery.quarantined.length}`);
    }
  } catch {
    failures.push("connection state recovery failed");
  }
  for (const item of inspectConnections(db, { includeDisconnected: true })) {
    if (!item.ok) {
      failures.push(`connection ${item.connector_id} unreadable`);
    }
  }
  for (const item of inspectCheckpoints(db)) {
    if (!item.ok) {
      failures.push(`checkpoint ${item.connector_id} unreadable`);
    }
  }
  if (stores.degraded.includes("retrieval-ops-stale")) {
    failures.push("retrieval_ops older than SLA");
  }

  return {
    supervisor,
    intent,
    rails,
    model,
    stores,
    calibration: cal,
    ok: failures.length === 0,
    failures,
  };
}

export function describeSupervisorNone(): string {
  return "supervisor: none (loop runs only while you run it)";
}

export function serveExecHint(vaultPath: string): string {
  return `kizuki serve --vault ${vaultPath}`;
}
