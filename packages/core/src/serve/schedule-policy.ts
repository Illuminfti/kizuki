import type { Database } from "bun:sqlite";
import { loadServeConfig } from "./config";
import { railDefinition } from "./rail-registry";
import { nextScheduleSlot } from "./receipts";
import { listSchedules } from "./schema";
import type { RailId, RunReceipt } from "./types";

/**
 * Choose which due rail runs next: the one whose last run is oldest, a rail
 * that never ran first, ties in schedule order. A rail that is due again as
 * soon as it finishes (slow, or far behind) then waits behind every other due
 * rail, so no rail waits longer than one pass of each of the others.
 */
export function pickDueRail(db: Database, due: readonly RailId[]): RailId | undefined {
  const lastRun = new Map(listSchedules(db).map(row => [row.rail, row.last_run_at]));
  let chosen: RailId | undefined;
  let chosenAt: string | null = null;
  for (const rail of due) {
    const at = lastRun.get(rail) ?? null;
    if (chosen === undefined || (chosenAt !== null && (at === null || Date.parse(at) < Date.parse(chosenAt)))) {
      chosen = rail;
      chosenAt = at;
    }
  }
  return chosen;
}

/**
 * A scheduled run advances its rail by one slot from the slot it ran for. After
 * an outage that slot can be far in the past, so the rail would be due again
 * the moment it finishes, run after run. Move a slot still at or before the
 * finish to the first slot strictly after it, on the same grid: a fixed-period
 * rail keeps its phase, a rail pinned to an hour keeps its hour. A long outage
 * then costs one catch-up run. Only the run that just set the slot moves it.
 */
export function catchUpSchedule(db: Database, vaultPath: string, rail: RailId, finishedAt: string): string | null {
  const row = db.query<{ period_s: number; last_run_at: string | null; next_run_at: string | null }, [string]>(
    "SELECT period_s,last_run_at,next_run_at FROM schedules WHERE rail=?",
  ).get(rail);
  if (row === null || row.next_run_at === null || row.last_run_at !== finishedAt) return null;
  const finished = Date.parse(finishedAt), due = Date.parse(row.next_run_at), period = row.period_s * 1000;
  if (!Number.isFinite(finished) || !Number.isFinite(due) || due > finished || !(period > 0)) return null;
  const pinned = railDefinition(rail)?.slot_hour;
  const next = pinned !== undefined
    ? nextScheduleSlot(finishedAt, row.period_s, pinned(loadServeConfig(vaultPath)))
    : new Date(due + (Math.floor((finished - due) / period) + 1) * period).toISOString();
  const moved = db.query("UPDATE schedules SET next_run_at=? WHERE rail=? AND next_run_at=? AND last_run_at=?")
    .run(next, rail, row.next_run_at, finishedAt).changes;
  return moved === 1 ? next : null;
}

/** The rail that brings the search index up to the ledger. */
export const INDEX_CATCH_UP_RAIL = "retrieval-sweep";

/**
 * Reads refuse while the search index is behind the ledger, so a sync that
 * stored events or changed canon is followed at once by an index catch-up
 * rather than waiting for the sweep's own slot. Not when the sweep is already
 * due: the fair pick runs it next anyway.
 */
export function needsIndexCatchUp(db: Database, receipt: RunReceipt, now: string): boolean {
  if (receipt.rail !== "sync" || receipt.status === "failed") return false;
  if (receipt.events_stored + receipt.canon_writes + receipt.canon_reverts === 0) return false;
  const sweep = listSchedules(db).find(row => row.rail === INDEX_CATCH_UP_RAIL);
  return sweep !== undefined && sweep.enabled && sweep.next_run_at !== null && sweep.next_run_at > now;
}
