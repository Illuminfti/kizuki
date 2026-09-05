import type { Database } from "bun:sqlite";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tableExists } from "../ledger/schema";
import { isPlainObject } from "../util/validate";
import { loadServeConfig } from "./config";
import {
  InjectedCrash,
  RUN_RECEIPTS_PATH,
  emptyRunTotals,
  isRailId,
  type CrashPoint,
  type RunReceipt,
  type RunExecution,
  type RunScheduleTransition,
  type RunStatus,
} from "./types";

const RUN_STATUSES = new Set(["ok", "degraded", "stopped", "failed"]);

export function runReceiptsPath(vaultPath: string): string {
  return join(vaultPath, RUN_RECEIPTS_PATH);
}

function redact(text: string): string {
  return text
    .replace(/\/(?:home|Users|tmp|var|workspace|opt)\/[^\s"']+/g, "[path]")
    .replace(/\b[A-Za-z0-9_-]{20,}\b/g, "[redacted]");
}

export function redactReceiptError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return redact(text).slice(0, 240);
}

export function parseRunExecution(value: unknown): RunExecution | undefined {
  if (!isPlainObject(value) || typeof value["instance_id"] !== "string" ||
      value["instance_id"].length === 0 || value["instance_id"].length > 128 ||
      !Number.isSafeInteger(value["pid"]) || Number(value["pid"]) <= 0 ||
      typeof value["boot_id"] !== "string" || value["boot_id"].length === 0 || value["boot_id"].length > 128 ||
      (typeof value["trigger"] !== "string" || !["scheduled", "manual", "once"].includes(value["trigger"])) ||
      (value["due_at"] !== null && (typeof value["due_at"] !== "string" || !Number.isFinite(Date.parse(value["due_at"]))))) return undefined;
  if (value["trigger"] === "scheduled" && value["due_at"] === null) return undefined;
  return { instance_id: value["instance_id"], pid: Number(value["pid"]), boot_id: value["boot_id"],
    trigger: value["trigger"] as RunExecution["trigger"], due_at: value["due_at"] as string | null };
}

function parseTransition(value: unknown): RunScheduleTransition | undefined {
  if (!isPlainObject(value) || Object.keys(value).sort().join() !== "brief_hour,next_run_at,period_s,previous_due_at" ||
      !Number.isSafeInteger(value["period_s"]) || Number(value["period_s"]) <= 0 ||
      (value["brief_hour"] !== null && (!Number.isInteger(value["brief_hour"]) || Number(value["brief_hour"]) < 0 || Number(value["brief_hour"]) > 23))) return undefined;
  const validDate = (v: unknown) => typeof v === "string" && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
  if (!validDate(value["next_run_at"]) || (value["previous_due_at"] !== null && !validDate(value["previous_due_at"]))) return undefined;
  return { previous_due_at: value["previous_due_at"] as string | null, next_run_at: value["next_run_at"] as string,
    period_s: Number(value["period_s"]), brief_hour: value["brief_hour"] as number | null };
}

/** Internal normalizer used by the content-digest observer as well as storage. */
export function parseRunReceipt(value: unknown): RunReceipt | null {
  if (!isPlainObject(value)) return null;
  if (typeof value["run_id"] !== "string" || value["run_id"].length === 0) {
    return null;
  }
  if (typeof value["rail"] !== "string") return null;
  if (typeof value["started_at"] !== "string") return null;
  if (typeof value["finished_at"] !== "string") return null;
  if (
    typeof value["status"] !== "string" ||
    !RUN_STATUSES.has(value["status"])
  ) {
    return null;
  }
  const totals = emptyRunTotals();
  const model = isPlainObject(value["model"]) ? value["model"] : {};
  const retrieval = isPlainObject(value["retrieval"]) ? value["retrieval"] : {};
  const execution = parseRunExecution(value["execution"]);
  const transition = parseTransition(value["schedule_transition"]);
  if (value["schedule_transition"] !== undefined && transition === undefined) throw new Error("invalid receipt schedule transition");
  return {
    ...(execution === undefined ? {} : { execution }),
    ...(transition === undefined ? {} : { schedule_transition: transition }),
    run_id: value["run_id"],
    rail: value["rail"],
    started_at: value["started_at"],
    finished_at: value["finished_at"],
    status: value["status"] as RunStatus,
    stopped: typeof value["stopped"] === "string" ? value["stopped"] : null,
    events_synced: numberOr(value["events_synced"], totals.events_synced),
    events_stored: numberOr(value["events_stored"], totals.events_stored),
    events_duplicate: numberOr(value["events_duplicate"], totals.events_duplicate),
    events_self_skipped: numberOr(
      value["events_self_skipped"],
      totals.events_self_skipped,
    ),
    claims_extracted: numberOr(value["claims_extracted"], totals.claims_extracted),
    claims_written: numberOr(value["claims_written"], totals.claims_written),
    claims_deduped: numberOr(value["claims_deduped"], totals.claims_deduped),
    claims_superseded: numberOr(
      value["claims_superseded"],
      totals.claims_superseded,
    ),
    claims_rejected: isPlainObject(value["claims_rejected"])
      ? Object.fromEntries(
          Object.entries(value["claims_rejected"]).filter(
            (entry): entry is [string, number] => typeof entry[1] === "number",
          ),
        )
      : {},
    canon_writes: numberOr(value["canon_writes"], totals.canon_writes),
    canon_reverts: numberOr(value["canon_reverts"], totals.canon_reverts),
    model: {
      ...(model["usage_unknown"] === true ? { usage_unknown: true } : {}),
      calls: numberOr(model["calls"], 0),
      input_tokens: numberOr(model["input_tokens"], 0),
      output_tokens: numberOr(model["output_tokens"], 0),
      unavailable: numberOr(model["unavailable"], 0),
      wall_ms: numberOr(model["wall_ms"], 0),
      model_ref: typeof model["model_ref"] === "string" ? model["model_ref"] : null,
    },
    retrieval: {
      upserts: numberOr(retrieval["upserts"], 0),
      removals: numberOr(retrieval["removals"], 0),
      pending_ops: numberOr(retrieval["pending_ops"], 0),
      degraded: Array.isArray(retrieval["degraded"])
        ? retrieval["degraded"].filter((item): item is string => typeof item === "string")
        : [],
    },
    budget: isPlainObject(value["budget"])
      ? Object.fromEntries(
          Object.entries(value["budget"]).flatMap(([name, used]) => {
            if (!isPlainObject(used)) return [];
            if (typeof used["used"] !== "number" || typeof used["limit"] !== "number") {
              return [];
            }
            return [[name, { used: used["used"], limit: used["limit"] }]];
          }),
        )
      : {},
    errors: Array.isArray(value["errors"])
      ? value["errors"]
          .filter((item): item is string => typeof item === "string")
          .map(redact)
      : [],
  };
}

/** Stable known receipt content: normalizes omitted defaults and object key order. */
export function canonicalReceiptContent(value: unknown): string {
  const receipt = parseRunReceipt(value);
  if (receipt === null) throw new Error("invalid run receipt content");
  // Already-persisted diagnostics are redacted. Hash exact supplied error text
  // rather than collapsing distinct malformed diagnostics through redaction.
  const content = { ...receipt, errors: isPlainObject(value) ? value["errors"] ?? receipt.errors : receipt.errors };
  return JSON.stringify(content, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function listRunReceipts(
  db: Database,
  options: { rail?: string; since?: string; limit?: number } = {},
): RunReceipt[] {
  if (!tableExists(db, "run_receipts")) return [];
  const limit = options.limit ?? 10_000;
  const rows =
    options.rail !== undefined && options.since !== undefined
      ? db
          .query<{ report: string }, [string, string, number]>(
            `SELECT report FROM run_receipts
              WHERE rail = ? AND finished_at >= ?
              ORDER BY finished_at, run_id
              LIMIT ?`,
          )
          .all(options.rail, options.since, limit)
      : options.rail !== undefined
        ? db
            .query<{ report: string }, [string, number]>(
              `SELECT report FROM run_receipts
                WHERE rail = ?
                ORDER BY finished_at, run_id
                LIMIT ?`,
            )
            .all(options.rail, limit)
        : options.since !== undefined
          ? db
              .query<{ report: string }, [string, number]>(
                `SELECT report FROM run_receipts
                  WHERE finished_at >= ?
                  ORDER BY finished_at, run_id
                  LIMIT ?`,
              )
              .all(options.since, limit)
          : db
              .query<{ report: string }, [number]>(
                `SELECT report FROM run_receipts
                  ORDER BY finished_at, run_id
                  LIMIT ?`,
              )
              .all(limit);
  return rows
    .map((row) => {
      try {
        return parseRunReceipt(JSON.parse(row.report));
      } catch {
        return null;
      }
    })
    .filter((receipt): receipt is RunReceipt => receipt !== null);
}

export function getRunReceipt(db: Database, runId: string): RunReceipt | null {
  if (!tableExists(db, "run_receipts")) return null;
  const row = db
    .query<{ report: string }, [string]>(
      "SELECT report FROM run_receipts WHERE run_id = ?",
    )
    .get(runId);
  if (row === undefined || row === null) return null;
  try {
    return parseRunReceipt(JSON.parse(row.report));
  } catch {
    return null;
  }
}

export function readRunReceiptsLog(vaultPath: string): RunReceipt[] {
  const path = runReceiptsPath(vaultPath);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .flatMap((line) => {
      if (line.trim().length === 0) return [];
      let value: unknown;
      try { value = JSON.parse(line); } catch { return []; }
      const parsed = parseRunReceipt(value);
      return parsed === null ? [] : [parsed];
    });
}

function appendJsonl(vaultPath: string, receipt: RunReceipt): void {
  const path = runReceiptsPath(vaultPath);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  appendFileSync(path, `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
}

function insertReceiptRow(db: Database, receipt: RunReceipt, vaultPath: string): void {
  db.transaction(() => {
    const raw = db.query<{ report: string }, [string]>("SELECT report FROM run_receipts WHERE run_id = ?").get(receipt.run_id);
    const existing = getRunReceipt(db, receipt.run_id);
    if (raw !== null && raw !== undefined && existing === null) throw new Error("invalid existing run receipt");
    if (existing !== null && canonicalReceiptContent(existing) !== canonicalReceiptContent(receipt)) throw new Error("conflicting run receipt");
    if (existing !== null) return;
    applyScheduleTransition(db, vaultPath, receipt);
    db.query(
      `INSERT INTO run_receipts
         (run_id, rail, started_at, finished_at, status, stopped, report)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      receipt.run_id,
      receipt.rail,
      receipt.started_at,
      receipt.finished_at,
      receipt.status,
      receipt.stopped,
      JSON.stringify(receipt),
    );
    if (tableExists(db, "extract_usage")) db.query("DELETE FROM extract_usage WHERE run_id = ?").run(receipt.run_id);
  }).immediate();
}

function redactReceipt(receipt: RunReceipt): RunReceipt {
  return {
    ...receipt,
    errors: receipt.errors.map(redact),
    model: {
      ...receipt.model,
      model_ref:
        receipt.model.model_ref === null ? null : redact(receipt.model.model_ref),
    },
  };
}

export function persistRunReceipt(
  db: Database,
  vaultPath: string,
  receipt: RunReceipt,
  options: { crashAfter?: CrashPoint; artifactPath?: string } = {},
): void {
  receipt = redactReceipt(receipt);
  if (isRailId(receipt.rail)) {
    const row = db.query<{ next_run_at: string | null; period_s: number }, [string]>("SELECT next_run_at,period_s FROM schedules WHERE rail=?").get(receipt.rail);
    if (row !== null) {
      const scheduled = receipt.execution?.trigger === "scheduled";
      const previous = row.next_run_at;
      const briefHour = receipt.rail === "brief" ? loadServeConfig(vaultPath).brief_hour : null;
      const next = nextScheduleSlot(scheduled ? receipt.execution!.due_at! : receipt.finished_at, row.period_s, briefHour);
      receipt = { ...receipt, schedule_transition: { previous_due_at: previous, next_run_at: next, period_s: row.period_s, brief_hour: briefHour } };
    }
  }
  if (options.artifactPath !== undefined) {
    mkdirSync(dirname(options.artifactPath), { recursive: true, mode: 0o700 });
    if (!existsSync(options.artifactPath)) {
      writeFileSync(options.artifactPath, `${receipt.run_id}\n`, { mode: 0o600 });
    }
  }
  if (options.crashAfter === "after-file") {
    throw new InjectedCrash("after-file");
  }
  appendJsonl(vaultPath, receipt);
  if (options.crashAfter === "after-jsonl") {
    throw new InjectedCrash("after-jsonl");
  }
  insertReceiptRow(db, receipt, vaultPath);
  if (options.crashAfter === "after-db") {
    throw new InjectedCrash("after-db");
  }
}

/** Advance the intended slot, never the late completion baseline. */
export function nextScheduleSlot(at: string, periodSeconds: number, briefHour: number | null): string {
  const next = new Date(at);
  if (briefHour === null) return new Date(next.getTime() + periodSeconds * 1000).toISOString();
  next.setUTCHours(briefHour, 0, 0, 0);
  if (next.getTime() <= Date.parse(at)) next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString();
}

function applyScheduleTransition(db: Database, vaultPath: string, receipt: RunReceipt): void {
  const transition = receipt.schedule_transition;
  if (transition === undefined) return; // Legacy records have no recoverable slot intent.
  if (!isRailId(receipt.rail) || parseTransition(transition) === undefined) throw new Error("invalid receipt schedule transition");
  const row = db.query<{ period_s: number; next_run_at: string | null; last_run_at: string | null }, [string]>("SELECT period_s,next_run_at,last_run_at FROM schedules WHERE rail=?").get(receipt.rail);
  const briefHour = receipt.rail === "brief" ? loadServeConfig(vaultPath).brief_hour : null;
  const scheduled = receipt.execution?.trigger === "scheduled";
  if (row === null || row.period_s !== transition.period_s || briefHour !== transition.brief_hour ||
      (scheduled && transition.previous_due_at !== null && transition.previous_due_at !== receipt.execution!.due_at) ||
      transition.next_run_at !== nextScheduleSlot(scheduled ? receipt.execution!.due_at! : receipt.finished_at, transition.period_s, briefHour)) throw new Error("conflicting receipt schedule policy");
  if (row.next_run_at === transition.previous_due_at) {
    db.query("UPDATE schedules SET last_run_at=?,next_run_at=? WHERE rail=? AND next_run_at IS ?").run(receipt.finished_at, transition.next_run_at, receipt.rail, transition.previous_due_at);
  } else {
    throw new Error("conflicting receipt due slot");
  }
}

/**
 * Replay the JSONL journal into `run_receipts`. A kill after the append and
 * before the row leaves an orphan the next start completes; a row that
 * already exists is ignored.
 */
export function recoverRunJournal(db: Database, vaultPath: string): string[] {
  const recovered: string[] = [];
  for (const receipt of readRunReceiptsLog(vaultPath)) {
    const existing = getRunReceipt(db, receipt.run_id);
    insertReceiptRow(db, receipt, vaultPath);
    if (existing === null) recovered.push(receipt.run_id);
  }
  return recovered;
}

export function pruneRunReceipts(
  db: Database,
  vaultPath: string,
  cutoff: string,
): { deleted: number; rewritten: number } {
  const kept = listRunReceipts(db).filter((receipt) => receipt.finished_at >= cutoff);
  const deleted = db
    .query<{ n: number }, [string]>(
      "SELECT COUNT(*) AS n FROM run_receipts WHERE finished_at < ?",
    )
    .get(cutoff)?.n ?? 0;
  db.query("DELETE FROM run_receipts WHERE finished_at < ?").run(cutoff);
  const path = runReceiptsPath(vaultPath);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(
    path,
    kept.map((receipt) => `${JSON.stringify(receipt)}\n`).join(""),
    { mode: 0o600 },
  );
  return { deleted, rewritten: kept.length };
}

export function orphanJournalReceipts(db: Database, vaultPath: string): string[] {
  const orphans: string[] = [];
  for (const receipt of readRunReceiptsLog(vaultPath)) {
    if (getRunReceipt(db, receipt.run_id) === null) {
      orphans.push(receipt.run_id);
    }
  }
  return orphans;
}
