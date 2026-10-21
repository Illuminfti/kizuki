import type { Database } from "bun:sqlite";
import { readRailCursor, writeRailCursor } from "../ledger/checkpoints";
import { tableExists } from "../ledger/schema";
import { isPlainObject } from "../util/validate";
import { redactReceiptError } from "./receipts";

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


const CLAIM_KEY_PREFIX = "legacy:";
const MAX_QUARANTINED_CLAIMS = 10_000;

/** Unwritten legacy claims remain live, with their full provenance, while retry is delayed. */
export interface QuarantinedClaim {
  readonly claim_id: string;
  readonly attempts: number;
  readonly reason: string;
  readonly last_at: string;
  readonly until: string;
}

function parseClaim(claimId: string, raw: string): Omit<QuarantinedClaim, "until"> | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (claimId.length === 0 || !isPlainObject(value) || Object.keys(value).sort().join() !== "attempts,last_at,reason") return null;
    const { attempts, reason, last_at } = value;
    if (typeof attempts !== "number" || !Number.isSafeInteger(attempts) || attempts < 1 ||
      typeof reason !== "string" || typeof last_at !== "string" || !Number.isFinite(Date.parse(last_at)) ||
      new Date(last_at).toISOString() !== last_at) return null;
    return { claim_id: claimId, attempts, reason: redactReceiptError(reason).slice(0, MAX_REASON), last_at };
  } catch { return null; }
}

function heldClaim(claim: Omit<QuarantinedClaim, "until">, now: string): QuarantinedClaim | null {
  const at = Date.parse(claim.last_at), current = Date.parse(now), until = at + QUARANTINE_MS;
  if (claim.attempts < QUARANTINE_FAILURES || !Number.isFinite(current) || at > current ||
    !Number.isFinite(new Date(until).getTime()) || until <= current) return null;
  return { ...claim, until: new Date(until).toISOString() };
}

/** Dead, corrected, written or purged claims cannot hold a queue slot or appear as pending work. */
export function listQuarantinedClaims(db: Database, now: string): QuarantinedClaim[] {
  if (!tableExists(db, "rail_cursors") || !tableExists(db, "claims")) return [];
  const held: QuarantinedClaim[] = [];
  const rows = db.query<{ claim_id: string; cursor: string }, [string, string, number]>(
    `SELECT c.claim_id, r.cursor FROM rail_cursors r JOIN claims c ON c.claim_id = substr(r.source_key, ${CLAIM_KEY_PREFIX.length + 1})
     WHERE r.rail = ? AND r.source_key LIKE ? AND c.status = 'live' AND c.receipt_id IS NULL AND c.is_world_typed = 0
     ORDER BY r.source_key LIMIT ?`,
  ).all(WRITER_RAIL, `${CLAIM_KEY_PREFIX}%`, MAX_QUARANTINED_CLAIMS);
  for (const row of rows) {
    const claim = parseClaim(row.claim_id, row.cursor);
    const value = claim === null ? null : heldClaim(claim, now);
    if (value !== null) held.push(value);
  }
  return held;
}

export function recordStuckClaim(db: Database, claimId: string, reason: string, now: string): QuarantinedClaim | null {
  if (claimId.length === 0) return null;
  const raw = readRailCursor(db, WRITER_RAIL, CLAIM_KEY_PREFIX + claimId);
  const previous = raw === null ? null : parseClaim(claimId, raw);
  const next = { claim_id: claimId, attempts: Math.min(Number.MAX_SAFE_INTEGER, (previous?.attempts ?? 0) + 1),
    reason: redactReceiptError(reason).slice(0, MAX_REASON), last_at: now };
  const { claim_id: _claimId, ...stored } = next;
  writeRailCursor(db, WRITER_RAIL, CLAIM_KEY_PREFIX + claimId, JSON.stringify(stored));
  return heldClaim(next, now);
}

export function clearStuckClaim(db: Database, claimId: string): void {
  if (tableExists(db, "rail_cursors")) db.query("DELETE FROM rail_cursors WHERE rail = ? AND source_key = ?")
    .run(WRITER_RAIL, CLAIM_KEY_PREFIX + claimId);
}
