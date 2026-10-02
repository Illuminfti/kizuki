import type { Database } from "bun:sqlite";
import { tableExists } from "../ledger/schema";
import { isTruncatedReceipt } from "./doctor-extraction";
import { parseRunReceipt } from "./receipts";
import { formatProducerDiagnostic } from "../producer/diagnostics";
import type { RunReceipt } from "./types";

export interface DoctorReceiptTotals {
  count: number;
  extracted: number;
  written: number;
  deduped: number;
  canon_today: number;
  skipped: number;
  extracting_count: number;
  model_attempts: number;
}

// LIMIT precedes validation, as in the public receipt reader. Malformed rows
// do not pull older history into a bounded window. JSON functions never see
// malformed input. Numeric strings and booleans are not receipt counters.
function counter(path: string, fallback = "0"): string {
  return `CASE WHEN json_type(report, '$.${path}') IN ('integer','real') AND abs(json_extract(report, '$.${path}')) <= 1.7976931348623157e308 THEN json_extract(report, '$.${path}') ELSE ${fallback} END`;
}

function transitionDate(field: string): string {
  const value = `json_extract(report, '$.schedule_transition.${field}')`;
  return `(json_type(report, '$.schedule_transition.${field}') = 'text'
    AND strftime('%Y-%m-%dT%H:%M:%fZ', julianday(${value})) = ${value})`;
}

const VALID_RECEIPT = `json_valid(report) AND json_type(report) = 'object'
  AND json_type(report, '$.run_id') = 'text' AND length(json_extract(report, '$.run_id')) > 0
  AND json_type(report, '$.rail') = 'text'
  AND json_type(report, '$.started_at') = 'text' AND json_type(report, '$.finished_at') = 'text'
  AND json_extract(report, '$.status') IN ('ok','degraded','stopped','failed')
  AND (json_type(report,'$.schedule_transition') IS NULL OR (
    json_type(report,'$.schedule_transition')='object'
    AND (SELECT COUNT(*) FROM json_each(report,'$.schedule_transition'))=4
    AND NOT EXISTS (SELECT 1 FROM json_each(report,'$.schedule_transition')
      WHERE key NOT IN ('period_s','brief_hour','next_run_at','previous_due_at'))
    AND json_type(report,'$.schedule_transition.period_s')='integer'
    AND json_extract(report,'$.schedule_transition.period_s') BETWEEN 1 AND 9007199254740991
    AND (json_type(report,'$.schedule_transition.brief_hour')='null' OR (
      json_type(report,'$.schedule_transition.brief_hour')='integer'
      AND json_extract(report,'$.schedule_transition.brief_hour') BETWEEN 0 AND 23))
    AND ${transitionDate("next_run_at")}
    AND (json_type(report,'$.schedule_transition.previous_due_at')='null' OR ${transitionDate("previous_due_at")})
  ))`;

/** Aggregate bounded sync counters without loading the receipt reports. */
export function readDoctorReceiptTotals(db: Database, since: string, limit: number, today: string): DoctorReceiptTotals {
  if (!tableExists(db, "run_receipts")) return { count: 0, extracted: 0, written: 0, deduped: 0, canon_today: 0, skipped: 0, extracting_count: 0, model_attempts: 0 };
  return db.query<DoctorReceiptTotals, [string, number, string]>(`WITH selected AS (
      SELECT report, run_id, finished_at FROM run_receipts WHERE rail='sync' AND finished_at >= ?
       ORDER BY finished_at DESC, run_id DESC LIMIT ?
    ), valid AS (
      SELECT * FROM selected WHERE CASE WHEN json_valid(report) THEN ${VALID_RECEIPT}
        AND json_extract(report, '$.rail') = 'sync' AND json_extract(report, '$.run_id') = run_id
        AND json_extract(report, '$.finished_at') = finished_at ELSE 0 END
    ) SELECT COUNT(*) AS count,
      TOTAL(${counter("claims_extracted")}) AS extracted,
      TOTAL(${counter("claims_written_extracted", counter("claims_written"))}) AS written,
      TOTAL(${counter("claims_deduped")}) AS deduped,
      TOTAL(CASE WHEN substr(finished_at,1,10) = ? THEN ${counter("canon_writes")} ELSE 0 END) AS canon_today,
      TOTAL(${counter("records_skipped")}) AS skipped,
      COALESCE(SUM(CASE WHEN ${counter("claims_extracted")} > 0 OR ${counter("claims_written")} > 0 THEN 1 ELSE 0 END),0) AS extracting_count,
      COALESCE(SUM(CASE WHEN ${counter("model.calls")} > 0 OR json_type(report,'$.model.diagnostic')='object' THEN 1 ELSE 0 END),0) AS model_attempts
      FROM valid`).get(since, limit, today)!;
}

/** Only receipts that can change the calibration clock, newest first. */
export function readDoctorExtractingClock(db: Database, since: string, limit: number): { kind: "none" } | { kind: "unparseable" } | { kind: "at"; started_at: string } {
  if (!tableExists(db, "run_receipts")) return { kind: "none" };
  let startedAt: string | null = null;
  let latest = -Infinity;
  const query = db.query<{ started_at: string }, [string, number]>(`WITH selected AS (
    SELECT report, run_id, finished_at FROM run_receipts WHERE rail='sync' AND finished_at >= ?
     ORDER BY finished_at DESC, run_id DESC LIMIT ?
  ) SELECT json_extract(report, '$.started_at') AS started_at FROM selected
    WHERE CASE WHEN json_valid(report) THEN ${VALID_RECEIPT}
      AND json_extract(report, '$.rail') = 'sync' AND json_extract(report, '$.run_id') = run_id
      AND json_extract(report, '$.finished_at') = finished_at
      AND (${counter("claims_extracted")} > 0 OR ${counter("claims_written")} > 0) ELSE 0 END
    ORDER BY finished_at, run_id`);
  for (const row of query.iterate(since, limit)) {
    const at = Date.parse(row.started_at);
    if (!Number.isFinite(at)) return { kind: "unparseable" };
    if (at >= latest) { latest = at; startedAt = row.started_at; }
  }
  return startedAt === null ? { kind: "none" } : { kind: "at", started_at: startedAt };
}

export interface DoctorRailHistory {
  receipts: RunReceipt[];
  count: number;
  last_ok: string | null;
  degraded_streak: number;
  kinds: string;
  dominant_error: string | null;
}

/** Normalized numeric fields that decide whether a retrieval run progressed. */
function railWindow(): string {
  return `WITH selected AS (
    SELECT report, finished_at, run_id, rail FROM run_receipts WHERE rail = ? AND finished_at >= ?
     ORDER BY finished_at DESC, run_id DESC LIMIT ?
  ), valid AS (
    SELECT * FROM selected WHERE CASE WHEN json_valid(report) THEN ${VALID_RECEIPT}
      AND (rail <> 'sync' OR (json_extract(report,'$.rail')='sync' AND json_extract(report,'$.run_id')=run_id
        AND json_extract(report,'$.finished_at')=finished_at)) ELSE 0 END
  ), ranked AS MATERIALIZED (
    SELECT finished_at, run_id, json_extract(report, '$.stopped') AS stopped,
      CASE WHEN json_type(report, '$.errors')='array' THEN json_extract(report, '$.errors') ELSE '[]' END AS errors,
      CASE WHEN json_type(report, '$.retrieval.degraded')='array' THEN json_extract(report, '$.retrieval.degraded') ELSE '[]' END AS degraded,
      CASE WHEN json_type(report, '$.model.diagnostic')='object' THEN json_extract(report, '$.model.diagnostic') END AS diagnostic, ROW_NUMBER() OVER (ORDER BY finished_at, run_id) AS position,
      json_extract(report, '$.status') AS status,
      ${counter("retrieval.upserts")} AS upserts, ${counter("retrieval.removals")} AS removals,
      ${counter("retrieval.pending_ops")} AS pending,
      LAG(${counter("retrieval.pending_ops")}) OVER (ORDER BY finished_at, run_id) AS previous_pending
    FROM valid
  ), boundary AS (
    SELECT COALESCE(MAX(CASE WHEN status NOT IN ('degraded','stopped') OR upserts > 0 OR removals > 0
      OR pending < previous_pending THEN position END),0) AS position FROM ranked
  )`;
}

/** SQL counts the streak; only the small as-of work window and diagnostics cross into JS. */
export function readDoctorRailHistory(db: Database, rail: string, since: string, limit: number): DoctorRailHistory {
  const empty: DoctorRailHistory = { receipts: [], count: 0, last_ok: null, degraded_streak: 0, kinds: "", dominant_error: null };
  if (!tableExists(db, "run_receipts")) return empty;
  const window = railWindow();
  const summary = db.query<{ count: number; last_ok: string | null; degraded_streak: number }, [string, string, number]>(`${window}
    SELECT COUNT(*) AS count, MAX(CASE WHEN status = 'ok' THEN finished_at END) AS last_ok,
      COALESCE(MAX(position),0) - (SELECT position FROM boundary) AS degraded_streak FROM ranked`).get(rail, since, limit)!;
  const recent = db.query<{ report: string }, [string, string, number]>(`${window} SELECT report FROM valid ORDER BY finished_at DESC, run_id DESC LIMIT 11`).all(rail, since, limit).reverse().flatMap(row => {
      try { const receipt = parseRunReceipt(JSON.parse(row.report)); return receipt === null ? [] : [receipt]; }
      catch { return []; }
    });
  const kinds = new Set<string>();
  const errors = new Map<string, number>();
  // Project diagnostics rather than full reports, and consume rows one at a time.
  if (summary.degraded_streak === 0) return { ...summary, receipts: recent, kinds: "", dominant_error: null };
  const diagnostics = db.query<{ report: string }, [string, string, number, string]>(`${window}
    SELECT json_object('run_id', run_id, 'rail', ?, 'started_at', finished_at, 'finished_at', finished_at,
      'status', status, 'stopped', stopped, 'errors', json(errors),
      'retrieval', json_object('degraded', json(degraded)),
      'model', json_object('diagnostic', json(diagnostic))) AS report
    FROM ranked WHERE position > (SELECT position FROM boundary) ORDER BY position`);
  for (const row of diagnostics.iterate(rail, since, limit, rail)) {
    const receipt = parseRunReceipt(JSON.parse(row.report));
    if (receipt === null) continue;
    kinds.delete(receipt.status);
    kinds.add(receipt.status);
    const reasons = new Set([
      ...(receipt.stopped === null ? [] : [`stopped ${receipt.stopped}`]),
      ...receipt.errors, ...receipt.retrieval.degraded,
      ...(receipt.model.diagnostic === undefined ? [] : [formatProducerDiagnostic(receipt.model.diagnostic)]),
    ]);
    for (const reason of reasons) errors.set(reason, (errors.get(reason) ?? 0) + 1);
  }
  let dominant: string | null = null, best = 0;
  for (const [reason, count] of errors) if (count > best) { dominant = reason; best = count; }
  return { ...summary, receipts: recent, kinds: [...kinds].reverse().join(" or "), dominant_error: dominant };
}

/** Only model attempts can end or extend the truncation streak. */
export function readDoctorTruncationCount(db: Database, since: string, limit: number): number {
  if (!tableExists(db, "run_receipts")) return 0;
  const rows = db.query<{ report: string }, [string, number]>(`WITH selected AS (
    SELECT report, run_id, finished_at FROM run_receipts WHERE rail='sync' AND finished_at >= ?
     ORDER BY finished_at DESC, run_id DESC LIMIT ?
  ) SELECT json_object('run_id', run_id, 'rail', 'sync', 'started_at', finished_at, 'finished_at', finished_at,
    'status', json_extract(report,'$.status'),
    'model', json_object('calls', ${counter("model.calls")}, 'last_request', json_extract(report,'$.model.last_request'),
      'diagnostic', CASE WHEN json_type(report,'$.model.diagnostic')='object' THEN json_extract(report,'$.model.diagnostic') END)) AS report
    FROM selected WHERE CASE WHEN json_valid(report) THEN ${VALID_RECEIPT}
      AND json_extract(report,'$.run_id')=run_id AND json_extract(report,'$.finished_at')=finished_at
      AND json_extract(report,'$.rail')='sync'
      AND (${counter("model.calls")} > 0 OR json_type(report,'$.model.diagnostic')='object') ELSE 0 END
    ORDER BY finished_at DESC, run_id DESC`);
  let count = 0;
  for (const row of rows.iterate(since, limit)) {
    const receipt = parseRunReceipt(JSON.parse(row.report));
    if (receipt === null) continue;
    if (isTruncatedReceipt(receipt)) count++;
    else if (receipt.model.calls > 0 || receipt.model.diagnostic !== undefined) break;
  }
  return count;
}
