import type { Database } from "bun:sqlite";
import { readRailCursor, writeRailCursor } from "../ledger/checkpoints";
import { tableExists } from "../ledger/schema";
import { isPlainObject } from "../util/validate";

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
    if (typeof attempts !== "number" || !Number.isSafeInteger(attempts) || attempts < 1 ||
        typeof path !== "string" || typeof reason !== "string" || typeof last_at !== "string" ||
        !Number.isFinite(Date.parse(last_at))) return null;
    return { handle, path, attempts, reason, last_at };
  } catch {
    return null;
  }
}

function quarantine(page: StuckPage, now: string): QuarantinedPage | null {
  if (page.attempts < QUARANTINE_FAILURES) return null;
  const until = Date.parse(page.last_at) + QUARANTINE_MS;
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
    reason: page.reason.slice(0, MAX_REASON),
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
