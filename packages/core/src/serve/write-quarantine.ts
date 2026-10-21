import { CLAIM_RETRY_FAILURES, CLAIM_RETRY_MS, CLAIM_RETRY_MAX_REASON } from "../ledger/canon-claim-retry-schema";
import type { Database } from "bun:sqlite";
import { readRailCursor, writeRailCursor } from "../ledger/checkpoints";
import { tableExists } from "../ledger/schema";
import { isPlainObject } from "../util/validate";
import { redactReceiptError } from "../util/receipt-redaction";

/**
 * Typed pages the canon writer could not write, kept across passes so one
 * page that always fails cannot take a place in every pass's queue. One row in
 * `rail_cursors` per handle, beside the extraction state. A page that has
 * failed `QUARANTINE_FAILURES` passes in a row is left alone for a day, then
 * tried once more: another failure sets it aside for a further day, a success
 * clears the row.
 */
const WRITER_RAIL = "kizuki.canon.writer";
const KEY_PREFIX = "stuck:";
export const QUARANTINE_FAILURES = 3;
export const QUARANTINE_MS = 24 * 60 * 60_000;
const MAX_REASON = 200;

export interface StuckPage {
  readonly handle: string;
  readonly path: string;
  /** Passes in a row this page has failed. */
  readonly attempts: number;
  /** The redacted error of the latest failure. */
  readonly reason: string;
  readonly last_at: string;
}

export interface QuarantinedPage extends StuckPage {
  /** No pass tries the page before this instant. */
  readonly until: string;
}

function parse(handle: string, raw: string): StuckPage | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (!isPlainObject(value)) return null;
    const { attempts, path, reason, last_at } = value;
    if (!/^[0-9a-f]{32}$/.test(handle) || typeof attempts !== "number" || !Number.isSafeInteger(attempts) || attempts < 1 ||
        typeof path !== "string" || path !== `auto/world/${handle}.md` || typeof reason !== "string" || typeof last_at !== "string" ||
        !Number.isFinite(Date.parse(last_at))) return null;
    return { handle, path, attempts, reason: redactReceiptError(reason).slice(0, MAX_REASON), last_at };
  } catch {
    return null;
  }
}

function quarantine(page: StuckPage, now: string): QuarantinedPage | null {
  if (page.attempts < QUARANTINE_FAILURES) return null;
  const until = Date.parse(page.last_at) + QUARANTINE_MS;
  if (!Number.isFinite(new Date(until).getTime())) return null;
  return until > Date.parse(now) ? { ...page, until: new Date(until).toISOString() } : null;
}

/** Pages no pass tries now, oldest handle first. */
export function listQuarantinedPages(db: Database, now: string): QuarantinedPage[] {
  if (!tableExists(db, "rail_cursors")) return [];
  const pages: QuarantinedPage[] = [];
  for (const row of db.query<{ source_key: string; cursor: string }, [string, string]>(
    "SELECT source_key, cursor FROM rail_cursors WHERE rail = ? AND source_key LIKE ? ORDER BY source_key",
  ).all(WRITER_RAIL, `${KEY_PREFIX}%`)) {
    // A row that cannot be read counts as no history: the page is tried and counted again.
    const page = parse(row.source_key.slice(KEY_PREFIX.length), row.cursor);
    const held = page === null ? null : quarantine(page, now);
    if (held !== null) pages.push(held);
  }
  return pages;
}

/** Records one more failed pass for this page; the second value says whether it is now set aside. */
export function recordStuckPage(
  db: Database,
  page: { readonly handle: string; readonly path: string; readonly reason: string },
  now: string,
): QuarantinedPage | null {
  const raw = readRailCursor(db, WRITER_RAIL, KEY_PREFIX + page.handle);
  const previous = raw === null ? null : parse(page.handle, raw);
  const next: StuckPage = {
    handle: page.handle,
    path: page.path,
    attempts: (previous?.attempts ?? 0) + 1,
    reason: redactReceiptError(page.reason).slice(0, MAX_REASON),
    last_at: now,
  };
  const { handle: _handle, ...stored } = next;
  writeRailCursor(db, WRITER_RAIL, KEY_PREFIX + page.handle, JSON.stringify(stored));
  return quarantine(next, now);
}

export function clearStuckPage(db: Database, handle: string): void {
  if (!tableExists(db, "rail_cursors")) return;
  db.query("DELETE FROM rail_cursors WHERE rail = ? AND source_key = ?").run(WRITER_RAIL, KEY_PREFIX + handle);
}


const MAX_QUARANTINED_CLAIMS = 10_000;
const MAX_DIAGNOSTIC_CLAIM_ID_BYTES = 1024;

/** Unwritten legacy claims remain live, with their full provenance, while retry is delayed. */
export interface QuarantinedClaim {
  readonly claim_id: string;
  readonly attempts: number;
  readonly reason: string;
  readonly last_at: string;
  readonly until: string;
}
interface RetryRow { claim_id: string; attempts: number; reason: string; last_at_ms: number }
function claimRetry(row: RetryRow): QuarantinedClaim {
  return { claim_id: row.claim_id, attempts: row.attempts,
    reason: redactReceiptError(row.reason).slice(0, CLAIM_RETRY_MAX_REASON),
    last_at: new Date(row.last_at_ms).toISOString(), until: new Date(row.last_at_ms + CLAIM_RETRY_MS).toISOString() };
}

/** Bounded diagnostic sample only. The writer excludes every active hold in SQL. */
export function listQuarantinedClaims(db: Database, now: string): { claims: QuarantinedClaim[]; truncated: boolean } {
  const at = Date.parse(now);
  if (!Number.isFinite(at) || !tableExists(db, "canon_claim_retries") ||
    db.query("SELECT 1 FROM canon_claim_retries LIMIT 1").get() === null) return { claims: [], truncated: false };
  const rows = db.query<RetryRow, [number, number, number]>(
    `SELECT r.* FROM canon_claim_retries r JOIN claims c USING(claim_id)
     WHERE c.status='live' AND c.receipt_id IS NULL AND c.is_world_typed=0
       AND r.attempts>=${CLAIM_RETRY_FAILURES} AND r.last_at_ms<=? AND r.last_at_ms>?
       AND length(CAST(r.claim_id AS BLOB))<=${MAX_DIAGNOSTIC_CLAIM_ID_BYTES}
     ORDER BY r.claim_id LIMIT ?`,
  ).all(at, at - CLAIM_RETRY_MS, MAX_QUARANTINED_CLAIMS + 1);
  // Test for omitted identities without bringing their unbounded bytes into JS.
  const oversized = db.query<{ omitted: number }, [number, number]>(
    `SELECT 1 AS omitted FROM canon_claim_retries r JOIN claims c USING(claim_id)
     WHERE c.status='live' AND c.receipt_id IS NULL AND c.is_world_typed=0
       AND r.attempts>=${CLAIM_RETRY_FAILURES} AND r.last_at_ms<=? AND r.last_at_ms>?
       AND length(CAST(r.claim_id AS BLOB))>${MAX_DIAGNOSTIC_CLAIM_ID_BYTES} LIMIT 1`,
  ).get(at, at - CLAIM_RETRY_MS) !== null;
  return { claims: rows.slice(0, MAX_QUARANTINED_CLAIMS).map(claimRetry), truncated: oversized || rows.length > MAX_QUARANTINED_CLAIMS };
}

export function recordStuckClaim(db: Database, claimId: string, reason: string, now: string): QuarantinedClaim | null {
  const at = Date.parse(now);
  if (!Number.isFinite(at) || !Number.isFinite(new Date(at + CLAIM_RETRY_MS).getTime())) return null;
  const row = db.query<RetryRow, [string, number, string]>(
    `INSERT INTO canon_claim_retries (claim_id,attempts,reason,last_at_ms)
     SELECT claim_id,1,?,? FROM claims WHERE claim_id=? AND status='live' AND receipt_id IS NULL AND is_world_typed=0
     ON CONFLICT(claim_id) DO UPDATE SET attempts=min(attempts+1,9007199254740991),reason=excluded.reason,last_at_ms=excluded.last_at_ms
     RETURNING *`,
  ).get(redactReceiptError(reason).slice(0, CLAIM_RETRY_MAX_REASON), at, claimId);
  return row !== null && row.attempts >= CLAIM_RETRY_FAILURES ? claimRetry(row) : null;
}

export function clearStuckClaim(db: Database, claimId: string): void {
  db.query("DELETE FROM canon_claim_retries WHERE claim_id=?").run(claimId);
}
