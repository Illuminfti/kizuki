import type { Database } from "bun:sqlite";
import { pendingRetrievalOps } from "../claims/store";
import { tableExists } from "../ledger/schema";
import { inspectPurgeHealth } from "../ledger/purge";
import { loadServeConfig } from "./config";
import { readServeIntent } from "./intent";
import { listRunReceipts, orphanJournalReceipts } from "./receipts";
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

function modelDoctor(
  receipts: RunReceipt[],
  modelRef: string | null | undefined,
  configCanonDay: number,
  usedToday: number,
): ModelDoctor {
  const on = typeof modelRef === "string" && modelRef.length > 0;
  const lastOk = [...receipts].reverse().find((receipt) => receipt.model.calls > 0);
  const unavailable = receipts.reduce((sum, receipt) => sum + receipt.model.unavailable, 0);
  return {
    canon_writing: on ? "on" : "off",
    model_ref: on ? modelRef : null,
    last_success_at: lastOk?.finished_at ?? null,
    unavailable,
    budget: {
      canon_writes_per_day: { used: usedToday, limit: configCanonDay },
    },
    detail: on
      ? `canon writing: on (${modelRef})`
      : "canon writing: off (no model configured — connectors, ledger, search, timeline and undo still work)",
  };
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
  return {
    pending_retrieval_ops: pendingRetrieval.length,
    oldest_retrieval_op_age_s: oldestRetrievalAge,
    pending_purge_ops: pendingPurge,
    oldest_purge_op_age_s: ageSeconds(oldestPurge, now),
    orphan_run_receipts: orphanJournalReceipts(db, vaultPath),
    degraded,
  };
}

function expectRailLiveness(intent: ServeIntent, supervisor: SupervisorStatus): boolean {
  return intent === "installed" && supervisor.state === "active";
}

export function inspectServeDoctor(
  db: Database,
  vaultPath: string,
  options: ServeDoctorOptions = {},
): ServeDoctorReport {
  const now = options.now ?? new Date().toISOString();
  const intent = readServeIntent(vaultPath);
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
  const model = modelDoctor(receipts, options.model_ref, config.canon_writes_per_day, usedToday);
  const stores = storeDoctor(db, vaultPath, now);
  const cal = calibration(db, receipts, now);
  const failures: string[] = [];
  if (intent === "installed") {
    if (supervisor.state === "masked") {
      failures.push("supervisor masked");
    } else if (supervisor.state === "absent") {
      failures.push("supervisor absent");
    }
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
