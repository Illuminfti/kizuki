import type { Database } from "bun:sqlite";
import { isRfc3339 } from "../util/time";
import { canonicalJson, sha256Hex } from "../util/hash";
import { isPlainObject } from "../util/validate";
import { MAX_V2_QUOTED_UTF16 } from "../contracts/producer-v2";
import { parseSourceBackfillPlan } from "./source-backfill";

const MAX_ROW_BYTES = 131_072;
const ATTEMPT_COLUMNS = [
  "operation_id", "event_id", "producer_fingerprint", "model_binding_digest", "start_utf16", "end_utf16", "cap_utf16", "plan_sha256", "plan", "created_at",
] as const;
const RESULT_COLUMNS = ["operation_id", "outcome", "report", "created_at"] as const;

export const SOURCE_BACKFILL_BACKUPS = [
  { path: "serve/source-backfill-attempts.jsonl", table: "source_backfill_attempts", key: "operation_id" },
  { path: "serve/source-backfill-results.jsonl", table: "source_backfill_results", key: "operation_id" },
] as const;
export type SourceBackfillBackup = typeof SOURCE_BACKFILL_BACKUPS[number];

function invalid(): never { throw new Error("source backfill backup is invalid"); }
function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return isPlainObject(value) && Reflect.ownKeys(value).length === keys.length && keys.every((key) => {
    const property = Object.getOwnPropertyDescriptor(value, key);
    return property !== undefined && property.enumerable && Object.hasOwn(property, "value");
  });
}
function digest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
function boundedString(value: unknown): value is string {
  return typeof value === "string" && Buffer.byteLength(value) <= MAX_ROW_BYTES;
}
function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function validateAttempt(db: Database, row: Record<string, unknown>): void {
  if (!exact(row, ATTEMPT_COLUMNS) || !boundedString(row.operation_id) || !boundedString(row.event_id) ||
      !digest(row.producer_fingerprint) || !digest(row.model_binding_digest) ||
      !digest(row.plan_sha256) || !boundedString(row.plan) || !boundedString(row.created_at) || !isRfc3339(row.created_at) ||
      ![row.start_utf16, row.end_utf16, row.cap_utf16].every(nonNegativeInteger)) invalid();
  let raw: unknown;
  try { raw = JSON.parse(row.plan); } catch { invalid(); }
  const plan = parseSourceBackfillPlan(raw);
  if (canonicalJson(plan) !== row.plan || sha256Hex(row.plan) !== row.plan_sha256 ||
      plan.operation_id !== row.operation_id || plan.event_id !== row.event_id || plan.producer_fingerprint !== row.producer_fingerprint ||
      plan.model_binding_digest !== row.model_binding_digest ||
      plan.window.start_utf16 !== row.start_utf16 || plan.window.end_utf16 !== row.end_utf16 ||
      plan.window.cap_utf16 !== row.cap_utf16 ||
      row.start_utf16 >= row.end_utf16 || row.end_utf16 > row.cap_utf16 ||
      row.end_utf16 - row.start_utf16 > MAX_V2_QUOTED_UTF16 ||
      db.query("SELECT 1 FROM events WHERE event_id=?").get(row.event_id) === null ||
      db.query(`SELECT 1 FROM source_event_bindings b JOIN source_grants g USING(source_key)
        WHERE b.event_id=? AND g.status<>'purged'`).get(row.event_id) === null) invalid();
}

function validateReport(value: unknown, row: Record<string, unknown>, planSha256: string): void {
  const keys = ["schema", "operation_id", "plan_sha256", "outcome", "usage", "usage_known", "claims_added", "supports_added", "carried_forward", "response_sha256", "reason"];
  if (!exact(value, keys) || value.schema !== "kizuki.source-prefix-backfill-result/v1" ||
      value.operation_id !== row.operation_id || value.plan_sha256 !== planSha256 || value.outcome !== row.outcome ||
      typeof value.usage_known !== "boolean" || !Array.isArray(value.claims_added) ||
      !value.claims_added.every(boundedString) || !nonNegativeInteger(value.supports_added) ||
      !nonNegativeInteger(value.carried_forward) || !(value.response_sha256 === null || digest(value.response_sha256)) ||
      !(value.reason === null || boundedString(value.reason))) invalid();
  if (value.usage === null) {
    if (value.usage_known) invalid();
  } else if (!exact(value.usage, ["calls", "input_tokens", "output_tokens"]) ||
      !Object.values(value.usage).every(nonNegativeInteger) || !value.usage_known) invalid();
}

function validateResult(db: Database, row: Record<string, unknown>): void {
  if (!exact(row, RESULT_COLUMNS) || !boundedString(row.operation_id) ||
      !(row.outcome === "settled" || row.outcome === "rejected" || row.outcome === "failed") ||
      !boundedString(row.report) || !boundedString(row.created_at) || !isRfc3339(row.created_at)) invalid();
  const attempt = db.query<{ plan_sha256: string }, [string]>(
    "SELECT plan_sha256 FROM source_backfill_attempts WHERE operation_id=?",
  ).get(row.operation_id);
  if (attempt === null) invalid();
  let report: unknown;
  try { report = JSON.parse(row.report); } catch { invalid(); }
  validateReport(report, row, attempt.plan_sha256);
  if (canonicalJson(report) !== row.report) invalid();
}

export function* sourceBackfillBackupRows(db: Database, spec: SourceBackfillBackup): Generator<Record<string, unknown>> {
  const columns = spec.table === "source_backfill_attempts" ? ATTEMPT_COLUMNS : RESULT_COLUMNS;
  for (const row of db.query<Record<string, unknown>, []>(
    `SELECT ${columns.join(",")} FROM ${spec.table} ORDER BY ${spec.key}`,
  ).iterate()) {
    validateSourceBackfillBackupRow(db, spec, row);
    yield row;
  }
}

export function validateSourceBackfillBackupRow(db: Database, spec: SourceBackfillBackup, row: Record<string, unknown>): void {
  if (Buffer.byteLength(canonicalJson(row)) > MAX_ROW_BYTES) invalid();
  if (spec.table === "source_backfill_attempts") validateAttempt(db, row);
  else validateResult(db, row);
}

export function restoreSourceBackfillRow(db: Database, spec: SourceBackfillBackup, row: Record<string, unknown>): void {
  validateSourceBackfillBackupRow(db, spec, row);
  const columns = spec.table === "source_backfill_attempts" ? ATTEMPT_COLUMNS : RESULT_COLUMNS;
  const values = columns.map((column) => {
    const value = row[column];
    if (typeof value !== "string" && typeof value !== "number") invalid();
    return value;
  });
  db.query(`INSERT INTO ${spec.table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`).run(
    ...values as [string, ...(string | number)[]],
  );
}

/** Re-validate the restored immutable chain after both streams are present. */
export function validateSourceBackfillBackup(db: Database): void {
  for (const spec of SOURCE_BACKFILL_BACKUPS) {
    for (const row of sourceBackfillBackupRows(db, spec)) { void row; }
  }
  type ChainAttempt = {
    operation_id: string;
    event_id: string;
    producer_fingerprint: string;
    model_binding_digest: string;
    plan: ReturnType<typeof parseSourceBackfillPlan>;
    report: string | null;
  };
  const validateGroup = (attempts: readonly ChainAttempt[]): void => {
    if (attempts.length === 0) return;
    if (attempts.length > 16) invalid();
    const eventId = attempts[0]!.event_id;
    if (attempts.some(attempt => attempt.event_id !== eventId)) invalid();
    const byId = new Map(attempts.map(attempt => [attempt.operation_id, attempt]));
    const children = new Map<string, number>();
    let roots = 0;
    for (const attempt of attempts) {
      const predecessor = attempt.plan.predecessor;
      if (predecessor === null) {
        roots += 1;
        continue;
      }
      const parent = byId.get(predecessor.operation_id);
      if (parent === undefined || parent.report === null || sha256Hex(parent.report) !== predecessor.receipt_sha256 ||
          parent.event_id !== attempt.event_id || parent.plan.source_key !== attempt.plan.source_key ||
          parent.plan.content_hash !== attempt.plan.content_hash || parent.plan.text_hash !== attempt.plan.text_hash ||
          canonicalJson(parent.plan.window) !== canonicalJson(attempt.plan.window) ||
          (parent.producer_fingerprint === attempt.producer_fingerprint && parent.model_binding_digest === attempt.model_binding_digest)) invalid();
      const childCount = (children.get(parent.operation_id) ?? 0) + 1;
      if (childCount > 1) invalid();
      children.set(parent.operation_id, childCount);
    }
    if (roots !== 1) invalid();
    for (const start of attempts) {
      const seen = new Set<string>();
      let current: typeof start | undefined = start;
      while (current !== undefined && current.plan.predecessor !== null) {
        if (seen.has(current.operation_id)) invalid();
        seen.add(current.operation_id);
        current = byId.get(current.plan.predecessor.operation_id);
        if (current === undefined || current.event_id !== eventId) invalid();
      }
    }
  };
  let currentEvent: string | undefined;
  let group: ChainAttempt[] = [];
  for (const row of db.query<{
    operation_id: string;
    event_id: string;
    producer_fingerprint: string;
    model_binding_digest: string;
    plan: string;
    report: string | null;
  }, []>(`SELECT a.operation_id,a.event_id,a.producer_fingerprint,a.model_binding_digest,a.plan,r.report
    FROM source_backfill_attempts a LEFT JOIN source_backfill_results r USING(operation_id)
    ORDER BY a.event_id,a.operation_id`).iterate()) {
    if (currentEvent !== undefined && row.event_id !== currentEvent) {
      validateGroup(group);
      group = [];
    }
    currentEvent = row.event_id;
    group.push({ ...row, plan: parseSourceBackfillPlan(JSON.parse(row.plan)) });
    if (group.length > 16) invalid();
  }
  validateGroup(group);
}
