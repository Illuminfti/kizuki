import type { Database } from "bun:sqlite";
import {
  appendFileSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  ftruncateSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tableExists } from "../ledger/schema";
import { isPlainObject } from "../util/validate";
import { sha256Hex } from "../util/hash";
import { readProducerDiagnostic } from "../producer/diagnostics";
import { REDACTION_KINDS } from "../producer/scrub";
import { VaultMutationError, withVaultMutationSync } from "../vault/mutation-scope";
import { tryAdvisoryFileLock } from "../util/advisory-file-lock";
import { pidAlive, readBootId } from "./leases";
import { loadServeConfig } from "./config";
import {
  DOCTOR_JOURNAL_TAIL_BYTES,
  InjectedCrash,
  NOOP_RECEIPT_HEARTBEAT_S,
  RUN_RECEIPT_JOURNAL_MAX_BYTES,
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

export function redactReceiptText(text: string): string {
  return text
    .replace(/\/(?:home|Users|tmp|var|workspace|opt)\/[^\s"']+/g, "[path]")
    .replace(/\b[A-Za-z0-9_-]{20,}\b/g, "[redacted]");
}

/** A display marker cannot recover the original model reference identity. */
export function isRedactedModelReference(reference: string): boolean {
  return reference.includes("[redacted]") || reference.includes("[path]");
}

export function readModelReferenceDigest(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value) ? value : undefined;
}

export function redactReceiptError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return redactReceiptText(text).slice(0, 240);
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
  const diagnostic = readProducerDiagnostic(model["diagnostic"]);
  const modelRefDigest = readModelReferenceDigest(model["model_ref_sha256"]);
  const retrieval = isPlainObject(value["retrieval"]) ? value["retrieval"] : {};
  const oversized = isPlainObject(value["oversized"]) ? value["oversized"] : null;
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
    ...(typeof value["claims_written_extracted"] === "number" && Number.isFinite(value["claims_written_extracted"])
      ? { claims_written_extracted: value["claims_written_extracted"] }
      : {}),
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
    ...(typeof value["records_skipped"] === "number" && Number.isFinite(value["records_skipped"])
      ? { records_skipped: value["records_skipped"] }
      : {}),
    ...(typeof value["pages_repaired"] === "number" && Number.isFinite(value["pages_repaired"])
      ? { pages_repaired: value["pages_repaired"] }
      : {}),
    ...(typeof value["captures_skipped"] === "number" && Number.isFinite(value["captures_skipped"])
      ? { captures_skipped: value["captures_skipped"] }
      : {}),
    canon_writes: numberOr(value["canon_writes"], totals.canon_writes),
    canon_reverts: numberOr(value["canon_reverts"], totals.canon_reverts),
    model: {
      ...(diagnostic === undefined ? {} : { diagnostic }),
      ...(modelRefDigest === undefined ? {} : { model_ref_sha256: modelRefDigest }),
      ...(model["usage_unknown"] === true ? { usage_unknown: true } : {}),
      ...(typeof model["answered"] === "number" && Number.isFinite(model["answered"]) ? { answered: model["answered"] } : {}),
      ...(typeof model["consecutive_rejections"] === "number" && Number.isSafeInteger(model["consecutive_rejections"]) && model["consecutive_rejections"] > 0
        && typeof model["last_rejection_rule"] === "string" && model["last_rejection_rule"].length <= 64
        ? { consecutive_rejections: model["consecutive_rejections"], last_rejection_rule: model["last_rejection_rule"] } : {}),
      ...(model["last_request"] === "answered" || model["last_request"] === "failed" ? { last_request: model["last_request"] } : {}),
      calls: numberOr(model["calls"], 0),
      input_tokens: numberOr(model["input_tokens"], 0),
      output_tokens: numberOr(model["output_tokens"], 0),
      ...redactedOf(model["redacted"]),
      unavailable: numberOr(model["unavailable"], 0),
      wall_ms: numberOr(model["wall_ms"], 0),
      model_ref: typeof model["model_ref"] === "string" ? model["model_ref"] : null,
    },
    ...(oversized === null ? {} : {
      oversized: { segments: numberOr(oversized["segments"], 0), skipped: numberOr(oversized["skipped"], 0) },
    }),
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
          .map(redactReceiptText)
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

/** Known redaction kinds with positive counts; absent on receipts from before the scrubber. */
function redactedOf(value: unknown): { redacted?: Record<string, number> } {
  if (!isPlainObject(value)) return {};
  const counts = Object.fromEntries(REDACTION_KINDS.flatMap(kind => {
    const count = value[kind];
    return typeof count === "number" && Number.isFinite(count) && count > 0 ? [[kind, count]] : [];
  }));
  return Object.keys(counts).length === 0 ? {} : { redacted: counts };
}

/** Select the newest matching receipts, then return them in chronological order. */
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
              ORDER BY finished_at DESC, run_id DESC
              LIMIT ?`,
          )
          .all(options.rail, options.since, limit)
      : options.rail !== undefined
        ? db
            .query<{ report: string }, [string, number]>(
              `SELECT report FROM run_receipts
                WHERE rail = ?
                ORDER BY finished_at DESC, run_id DESC
                LIMIT ?`,
            )
            .all(options.rail, limit)
        : options.since !== undefined
          ? db
              .query<{ report: string }, [string, number]>(
                `SELECT report FROM run_receipts
                  WHERE finished_at >= ?
                  ORDER BY finished_at DESC, run_id DESC
                  LIMIT ?`,
              )
              .all(options.since, limit)
          : db
              .query<{ report: string }, [number]>(
                `SELECT report FROM run_receipts
                  ORDER BY finished_at DESC, run_id DESC
                  LIMIT ?`,
              )
              .all(limit);
  return rows
    .reverse()
    .map((row) => {
      try {
        return parseRunReceipt(JSON.parse(row.report));
      } catch {
        return null;
      }
    })
    .filter((receipt): receipt is RunReceipt => receipt !== null);
}

export interface ModelRunHistory {
  /** Chronological candidates; null retains the position of an unreadable receipt. */
  readonly receipts: (RunReceipt | null)[];
  readonly truncated: boolean;
}

/** LIMIT applies before report parsing, using the rail/time/run-id index. */
const MODEL_RUN_HISTORY_SQL = `SELECT report, run_id, finished_at FROM run_receipts
  WHERE rail = 'sync' AND finished_at >= ?
  ORDER BY finished_at DESC, run_id DESC LIMIT ?`;

/** A bounded raw sync window; identity and outcome classification happen after normalization. */
export function readModelRunHistory(db: Database, since: string, limit = 10_000): ModelRunHistory {
  if (!tableExists(db, "run_receipts")) return { receipts: [], truncated: false };
  const rows = db.query<{ report: string; run_id: string; finished_at: string }, [string, number]>(
    MODEL_RUN_HISTORY_SQL,
  ).all(since, limit + 1);
  return {
    truncated: rows.length > limit,
    receipts: rows.slice(0, limit).reverse().map(normalizeModelHistoryRow),
  };
}

function normalizeModelHistoryRow(row: { report: string; run_id: string; finished_at: string }): RunReceipt | null {
  try {
    const receipt = parseRunReceipt(JSON.parse(row.report));
    // Preserve unknown positions rather than falsely resolving a newer attempt.
    return receipt?.rail === "sync" && receipt.run_id === row.run_id && receipt.finished_at === row.finished_at ? receipt : null;
  } catch { return null; }
}

/** Newest first. The return value records the extra raw row beyond the window. */
export function visitModelRunHistory(
  db: Database, since: string, limit: number,
  visit: (receipt: RunReceipt | null) => void,
): boolean {
  if (!tableExists(db, "run_receipts")) return false;
  const rows = db.query<{ report: string; run_id: string; finished_at: string }, [string, number]>(MODEL_RUN_HISTORY_SQL);
  let count = 0;
  for (const row of rows.iterate(since, limit + 1)) {
    if (count === limit) return true;
    visit(normalizeModelHistoryRow(row));
    count++;
    if (count % 128 === 0) Bun.gc(false);
  }
  return false;
}

/** Newest embed-backfill runs `readEmbeddingReceipts` looks through: a day at the default period. */
const EMBEDDING_SCAN_ROWS = 1_500;

/**
 * The newest embed-backfill runs that embedded something, found among the
 * newest `EMBEDDING_SCAN_ROWS` runs. The rail runs every minute and most runs
 * embed nothing, so a window of newest runs would lose the measurement; the
 * filter runs in SQLite and only `limit` rows are parsed.
 */
export function readEmbeddingReceipts(db: Database, since: string, limit: number): RunReceipt[] {
  if (!tableExists(db, "run_receipts")) return [];
  return db
    .query<{ report: string }, [string, number]>(
      `SELECT report FROM (
         SELECT report, finished_at, run_id FROM run_receipts
          WHERE rail = 'embed-backfill' AND status = 'ok' AND finished_at >= ?
          ORDER BY finished_at DESC, run_id DESC LIMIT ${EMBEDDING_SCAN_ROWS})
        WHERE json_extract(report, '$.retrieval.upserts') > 0
        ORDER BY finished_at DESC, run_id DESC LIMIT ?`,
    )
    .all(since, limit)
    .reverse()
    .flatMap((row) => {
      try {
        const receipt = parseRunReceipt(JSON.parse(row.report));
        return receipt === null ? [] : [receipt];
      } catch { return []; }
    });
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

/** The journal's receipts; with `tailBytes`, only those in the newest that many bytes. */
export function readRunReceiptsLog(vaultPath: string, tailBytes?: number): RunReceipt[] {
  const path = runReceiptsPath(vaultPath);
  if (!existsSync(path)) return [];
  return [...iterateRunReceiptsLog(vaultPath, tailBytes)];
}

/** Stream replay: a receipt is the allocation unit, never the entire journal. */
function* iterateRunReceiptsLog(vaultPath: string, tailBytes?: number): Generator<RunReceipt> {
  const path = runReceiptsPath(vaultPath);
  if (!existsSync(path)) return;
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error("run receipt journal is not a regular private file");
    const size = stat.size;
    let position = tailBytes === undefined ? 0 : Math.max(0, size - tailBytes);
    let partial = position > 0;
    const buffer = Buffer.alloc(64 * 1024);
    let pieces: Buffer[] = [];
    const parse = (bytes: Buffer): RunReceipt | null => {
      let value: unknown;
      try { value = JSON.parse(bytes.toString("utf8")); } catch { return null; }
      return parseRunReceipt(value);
    };
    while (position < size) {
      const read = readSync(fd, buffer, 0, Math.min(buffer.length, size - position), position);
      if (read === 0) break;
      position += read;
      let start = 0;
      for (let end = buffer.indexOf(10, start); end >= 0 && end < read; end = buffer.indexOf(10, start)) {
        if (!partial) {
          pieces.push(buffer.subarray(start, end));
          const receipt = parse(Buffer.concat(pieces));
          if (receipt !== null) yield receipt;
        }
        pieces = [];
        partial = false;
        start = end + 1;
      }
      if (!partial && start < read) pieces.push(Buffer.from(buffer.subarray(start, read)));
    }
    if (!partial && pieces.length > 0) {
      const receipt = parse(Buffer.concat(pieces));
      if (receipt !== null) yield receipt;
    }
  } finally { closeSync(fd); }
}

function appendJsonl(vaultPath: string, receipt: RunReceipt): void {
  const path = runReceiptsPath(vaultPath);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const fd = openSync(path, constants.O_CREAT | constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error("run receipt journal is not a regular private file");
    appendFileSync(fd, `${JSON.stringify(receipt)}\n`);
  } finally { closeSync(fd); }
}

/** A repair batch has committed; its rail receipt still needs journal publication. */
export const CAPTURE_REPAIR_RECEIPT_PENDING = "capture-repair:receipt-pending";

/** Called inside the claim batch transaction. No filesystem effect precedes commit. */
export function stageCaptureRepairReceipt(db: Database, receipt: RunReceipt): void {
  if (!db.inTransaction || receipt.stopped !== CAPTURE_REPAIR_RECEIPT_PENDING ||
      receipt.rail !== "doctor-sweep" || !(receipt.captures_skipped! > 0)) {
    throw new Error("invalid capture repair progress");
  }
  const existing = getRunReceipt(db, receipt.run_id);
  if (existing !== null && (existing.stopped !== CAPTURE_REPAIR_RECEIPT_PENDING ||
      existing.captures_skipped! >= receipt.captures_skipped!)) throw new Error("conflicting capture repair progress");
  db.query(`INSERT INTO run_receipts (run_id, rail, started_at, finished_at, status, stopped, report)
    VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(run_id) DO UPDATE SET report=excluded.report`)
    .run(receipt.run_id, receipt.rail, receipt.started_at, receipt.finished_at, receipt.status, receipt.stopped, JSON.stringify(receipt));
}

function insertReceiptRow(db: Database, receipt: RunReceipt, vaultPath: string): void {
  db.transaction(() => {
    const raw = db.query<{ report: string }, [string]>("SELECT report FROM run_receipts WHERE run_id = ?").get(receipt.run_id);
    const existing = getRunReceipt(db, receipt.run_id);
    if (raw !== null && raw !== undefined && existing === null) throw new Error("invalid existing run receipt");
    if (existing?.stopped === CAPTURE_REPAIR_RECEIPT_PENDING && receipt.stopped !== CAPTURE_REPAIR_RECEIPT_PENDING) {
      if (receipt.rail !== existing.rail || receipt.started_at !== existing.started_at ||
          receipt.captures_skipped !== existing.captures_skipped) throw new Error("conflicting capture repair receipt");
      // Replacing only this staged receipt and applying its schedule is atomic.
      db.query("DELETE FROM run_receipts WHERE run_id = ?").run(receipt.run_id);
    } else if (existing !== null && canonicalReceiptContent(existing) !== canonicalReceiptContent(receipt)) throw new Error("conflicting run receipt");
    if (existing !== null && existing.stopped !== CAPTURE_REPAIR_RECEIPT_PENDING) return;
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
  const { diagnostic: rawDiagnostic, model_ref_sha256: rawDigest, ...model } = receipt.model;
  const diagnostic = readProducerDiagnostic(rawDiagnostic);
  const reference = model.model_ref;
  // Hash the original reference before redaction. Recovered historical display
  // text cannot invent a stable identity; preserve a prior valid digest only.
  const modelRefDigest = reference !== null && !isRedactedModelReference(reference)
    ? sha256Hex(reference) : readModelReferenceDigest(rawDigest);
  return {
    ...receipt,
    errors: receipt.errors.map(redactReceiptText),
    model: {
      ...model,
      ...(diagnostic === undefined ? {} : { diagnostic }),
      ...(modelRefDigest === undefined ? {} : { model_ref_sha256: modelRefDigest }),
      model_ref: reference === null ? null : redactReceiptText(reference),
    },
  };
}

/** Attach the compare-and-advance intent for the rail's next due slot. */
function withScheduleTransition(db: Database, vaultPath: string, receipt: RunReceipt): RunReceipt {
  if (!isRailId(receipt.rail)) return receipt;
  const row = db.query<{ next_run_at: string | null; period_s: number }, [string]>("SELECT next_run_at,period_s FROM schedules WHERE rail=?").get(receipt.rail);
  if (row === null) return receipt;
  const scheduled = receipt.execution?.trigger === "scheduled";
  const previous = row.next_run_at;
  const briefHour = receipt.rail === "brief" ? loadServeConfig(vaultPath).brief_hour : null;
  const next = nextScheduleSlot(scheduled ? receipt.execution!.due_at! : receipt.finished_at, row.period_s, briefHour);
  return { ...receipt, schedule_transition: { previous_due_at: previous, next_run_at: next, period_s: row.period_s, brief_hour: briefHour } };
}

/** A run that changed nothing, reported nothing and failed at nothing. */
export function isNoopReceipt(receipt: RunReceipt): boolean {
  const counters = [
    receipt.events_synced, receipt.events_stored, receipt.events_duplicate, receipt.events_self_skipped,
    receipt.claims_extracted, receipt.claims_written, receipt.claims_deduped, receipt.claims_superseded,
    receipt.records_skipped ?? 0, receipt.captures_skipped ?? 0, receipt.canon_writes, receipt.canon_reverts,
    receipt.model.calls, receipt.model.unavailable, receipt.model.input_tokens, receipt.model.output_tokens,
    receipt.retrieval.upserts, receipt.retrieval.removals, receipt.retrieval.pending_ops,
  ];
  return receipt.status === "ok" && receipt.stopped === null && receipt.errors.length === 0 &&
    receipt.oversized === undefined && receipt.retrieval.degraded.length === 0 &&
    Object.keys(receipt.claims_rejected).length === 0 && counters.every((count) => count === 0);
}

/**
 * Coalesce a scheduled no-op run into its rail's last no-op receipt: the schedule
 * still advances, but the journal gains a receipt only for the first idle run
 * after activity and then at most once per heartbeat. Returns true when the
 * receipt was not persisted. Manual and once runs, the brief (which writes a
 * page) and every non-idle run always persist.
 */
export function coalesceNoopReceipt(db: Database, vaultPath: string, receipt: RunReceipt): boolean {
  if (receipt.rail === "brief" || receipt.execution?.trigger !== "scheduled" || !isNoopReceipt(receipt)) return false;
  const row = db.query<{ report: string }, [string]>(
    "SELECT report FROM run_receipts WHERE rail = ? ORDER BY finished_at DESC, run_id DESC LIMIT 1",
  ).get(receipt.rail);
  let last: RunReceipt | null = null;
  try { last = row === null ? null : parseRunReceipt(JSON.parse(row.report)); } catch { last = null; }
  if (last === null || !isNoopReceipt(last) ||
      Date.parse(receipt.finished_at) - Date.parse(last.finished_at) >= NOOP_RECEIPT_HEARTBEAT_S * 1000) return false;
  db.transaction(() => applyScheduleTransition(db, vaultPath, withScheduleTransition(db, vaultPath, receipt))).immediate();
  return true;
}

export function persistRunReceipt(
  db: Database,
  vaultPath: string,
  receipt: RunReceipt,
  options: { crashAfter?: CrashPoint; artifactPath?: string } = {},
): void {
  withRunJournal(vaultPath, () => persistRunReceiptLocked(db, vaultPath, receipt, options));
}

function withRunJournal<T>(vaultPath: string, work: () => T): T {
  mkdirSync(join(vaultPath, ".kizuki"), { recursive: true, mode: 0o700 });
  const lock = tryAdvisoryFileLock(join(vaultPath, ".kizuki", "run-receipts.flock"));
  if (lock === null) throw new Error("run receipt journal is busy; retry the operation");
  try { return work(); } finally { lock.release(); }
}

function persistRunReceiptLocked(
  db: Database, vaultPath: string, receipt: RunReceipt,
  options: { crashAfter?: CrashPoint; artifactPath?: string },
): void {
  receipt = withScheduleTransition(db, vaultPath, redactReceipt(receipt));
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
export function recoverRunJournal(db: Database, vaultPath: string, activeRunIds: ReadonlySet<string> = new Set()): string[] {
  const recovered: string[] = [];
  withRunJournal(vaultPath, () => replayRunJournal(db, vaultPath, recovered));
  // A repair may stop before JSONL publication. Its committed progress row is
  // the outbox, so restart publishes the same run identity and count once.
  if (!tableExists(db, "run_receipts")) return recovered;
  const pending = db.query<{ run_id: string }, [string]>(
    "SELECT run_id FROM run_receipts WHERE stopped = ? ORDER BY run_id LIMIT 100",
  ).all(CAPTURE_REPAIR_RECEIPT_PENDING);
  if (pending.length > 0) {
    try {
      withVaultMutationSync({ db, vault_path: vaultPath }, () => {
        for (const row of pending) {
          // Re-read under the lock: another recovery may have published it.
          const receipt = getRunReceipt(db, row.run_id);
          if (receipt === null) throw new Error("invalid capture repair receipt");
          if (receipt.stopped !== CAPTURE_REPAIR_RECEIPT_PENDING || activeRunIds.has(row.run_id) ||
              (receipt.execution !== undefined && receipt.execution.boot_id === readBootId() &&
               receipt.execution.pid !== process.pid && pidAlive(receipt.execution.pid))) continue;
          persistRunReceipt(db, vaultPath, { ...receipt, status: "failed", stopped: null,
            errors: ["capture repair interrupted before receipt publication"] });
          recovered.push(row.run_id);
        }
      });
    } catch (error) {
      if (!(error instanceof VaultMutationError) || error.code !== "writer_busy") throw error;
      // The durable progress remains until the next recovery gets the writer.
    }
  }
  return recovered;
}

function replayRunJournal(db: Database, vaultPath: string, recovered: string[]): void {
  for (const receipt of iterateRunReceiptsLog(vaultPath)) {
    const existing = getRunReceipt(db, receipt.run_id);
    insertReceiptRow(db, receipt, vaultPath);
    if (existing === null || existing.stopped === CAPTURE_REPAIR_RECEIPT_PENDING) recovered.push(receipt.run_id);
  }
}

/**
 * SQLite retains audit history by age. The JSONL file is the publication
 * recovery journal: once every line has reached SQLite it can be retired,
 * without serializing the surviving history back to disk. Recover before
 * retiring, then range-delete: a crash at either boundary retains extra rows,
 * never loses an unpublished receipt or resurrects an expired one on replay.
 */
export function pruneRunReceipts(
  db: Database,
  vaultPath: string,
  cutoff: string,
  maxBytes: number = RUN_RECEIPT_JOURNAL_MAX_BYTES,
): { deleted: number; rewritten: number } {
  return withRunJournal(vaultPath, () => {
    const path = runReceiptsPath(vaultPath);
    const expired = db.query<{ n: number }, [string, string]>(
      "SELECT COUNT(*) AS n FROM run_receipts WHERE finished_at < ? AND stopped IS NOT ?",
    ).get(cutoff, CAPTURE_REPAIR_RECEIPT_PENDING)!.n;
    // Do not even open an unchanged journal for writing.
    if (expired === 0 && (!existsSync(path) || fileSize(path) <= maxBytes)) return { deleted: 0, rewritten: 0 };
    replayRunJournal(db, vaultPath, []);
    if (existsSync(path)) {
      const fd = openSync(path, constants.O_RDWR | constants.O_NOFOLLOW);
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1) throw new Error("run receipt journal is not a regular private file");
        ftruncateSync(fd, 0);
        fsyncSync(fd);
      } finally { closeSync(fd); }
    }
    const deleted = db.transaction(() => db.query(
      "DELETE FROM run_receipts WHERE finished_at < ? AND stopped IS NOT ?",
    ).run(cutoff, CAPTURE_REPAIR_RECEIPT_PENDING).changes).immediate();
    return { deleted, rewritten: 0 };
  });
}

function fileSize(path: string): number {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error("run receipt journal is not a regular private file");
    return stat.size;
  } finally { closeSync(fd); }
}

/**
 * Receipts the journal names that the ledger lacks, among the newest
 * `DOCTOR_JOURNAL_TAIL_BYTES` of the file. An orphan is appended at the end
 * before its row is written, so the tail is where any live one sits; older
 * lines are the prune rail's to bound.
 */
export function orphanJournalReceipts(db: Database, vaultPath: string): string[] {
  const orphans: string[] = [];
  for (const receipt of readRunReceiptsLog(vaultPath, DOCTOR_JOURNAL_TAIL_BYTES)) {
    if (getRunReceipt(db, receipt.run_id) === null) {
      orphans.push(receipt.run_id);
    }
  }
  return orphans;
}
