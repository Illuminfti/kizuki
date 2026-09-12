import type { Database } from "bun:sqlite";
import { tableExists } from "../ledger/schema";
import { loadServeConfig } from "../serve/config";
import { assertPageRelPath } from "./paths";

/**
 * Budget enforcement lives inside the writer. Callers may supply an in-memory
 * tracker for per-run limits; the writer still reserves a durable daily slot
 * from the vault `[budget]` ceiling before the file effect.
 */

export const CANON_WRITE_BUDGETS = [
  "canon_writes_per_run",
  "canon_writes_per_day",
] as const;
export type CanonWriteBudget = (typeof CANON_WRITE_BUDGETS)[number];

export class BudgetExhausted extends Error {
  override readonly name = "BudgetExhausted";
  /** The value a run receipt records as `stopped` (§4.5). */
  readonly stopped: `budget:${CanonWriteBudget}`;

  constructor(readonly budget: CanonWriteBudget, readonly limit: number) {
    super(`canon write budget ${budget} exhausted (limit ${limit})`);
    this.stopped = `budget:${budget}`;
  }
}

export interface BudgetUsage {
  used: number;
  limit: number;
}

export interface CanonWriteCharge {
  receipt_id: string;
  page_path: string;
  before_hash: string | null;
  /** Receipt timestamp; the reserved UTC day is `at.slice(0, 10)`. */
  at: string;
}

export interface BudgetTracker {
  /** Charges one canon write before the canon file effect; throws when exhausted. */
  chargeWrite(write?: CanonWriteCharge): void;
  usage(): Record<CanonWriteBudget, BudgetUsage>;
}

export interface BudgetLimits {
  canon_writes_per_run: number;
  canon_writes_per_day?: { limit: number; used: number };
}

function assertLimit(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative integer`);
  }
}

function budgetDay(at: string): string {
  return at.slice(0, 10);
}

function reservedReceipts(db: Database): Set<string> {
  if (!tableExists(db, "canon_write_reservations")) return new Set();
  return new Set(
    db.query<{ receipt_id: string }, []>("SELECT receipt_id FROM canon_write_reservations").all()
      .map((row) => row.receipt_id),
  );
}

function reservedForDay(db: Database, day: string): number {
  if (!tableExists(db, "canon_write_reservations")) return 0;
  return db.query<{ count: number }, [string]>(
    "SELECT count(*) AS count FROM canon_write_reservations WHERE day=?",
  ).get(day)!.count;
}

function ledgerUsed(db: Database, day: string): number {
  if (!tableExists(db, "budget_ledger")) return 0;
  return db.query<{ used: number }, [string, string]>(
    "SELECT used FROM budget_ledger WHERE day = ? AND name = ?",
  ).get(day, "canon_writes_per_day")?.used ?? 0;
}

/**
 * Settled ordinary writes for `day`. Revert and purge receipts do not count.
 * Crash admission reserves before file/JSONL/row, so occupancy is this plus
 * live reservations — not a scan of the unpruned receipt log.
 */
export function ordinaryDailySettled(db: Database, day: string): number {
  const reserved = reservedReceipts(db);
  let settled = 0;
  if (tableExists(db, "canon_receipts")) {
    for (const row of db.query<{ receipt_id: string }, [string]>(
      "SELECT receipt_id FROM canon_receipts WHERE receipt_kind='write' AND substr(at,1,10)=?",
    ).all(day)) {
      if (!reserved.has(row.receipt_id)) settled += 1;
    }
  }
  return Math.max(ledgerUsed(db, day), settled);
}

export function ordinaryDailyOccupancy(db: Database, day: string): number {
  return ordinaryDailySettled(db, day) + reservedForDay(db, day);
}

/** Idempotent. Same receipt may be reserved by the rails tracker and the writer. */
export function reserveCanonWrite(
  db: Database,
  write: CanonWriteCharge,
  day: string,
  limit: number,
): void {
  assertPageRelPath(write.page_path);
  if (!tableExists(db, "canon_write_reservations")) return;
  const run = (): void => {
    if (db.query("SELECT 1 FROM canon_write_reservations WHERE receipt_id=?").get(write.receipt_id) !== null) {
      return;
    }
    if (ordinaryDailyOccupancy(db, day) >= limit) {
      throw new BudgetExhausted("canon_writes_per_day", limit);
    }
    db.query(
      `INSERT INTO canon_write_reservations(receipt_id, day, page_path, before_hash)
       VALUES (?, ?, ?, ?)`,
    ).run(write.receipt_id, day, write.page_path, write.before_hash);
  };
  if (db.inTransaction) run();
  else db.transaction(run).immediate();
}

/**
 * Per-run limits stay on the caller tracker. The vault daily ceiling is
 * reserved here so an in-memory tracker cannot bypass restart persistence.
 */
export function chargeCanonWrite(
  io: { db: Database; vault_path: string },
  budget: BudgetTracker,
  write: CanonWriteCharge,
): void {
  assertPageRelPath(write.page_path);
  const day = budgetDay(write.at);
  if (tableExists(io.db, "canon_write_reservations")) {
    const limit = loadServeConfig(io.vault_path).canon_writes_per_day;
    if (
      io.db.query("SELECT 1 FROM canon_write_reservations WHERE receipt_id=?").get(write.receipt_id) === null &&
      ordinaryDailyOccupancy(io.db, day) >= limit
    ) {
      throw new BudgetExhausted("canon_writes_per_day", limit);
    }
    budget.chargeWrite(write);
    reserveCanonWrite(io.db, write, day, limit);
    return;
  }
  budget.chargeWrite(write);
}

export function createBudgetTracker(limits: BudgetLimits): BudgetTracker {
  assertLimit("canon_writes_per_run", limits.canon_writes_per_run);
  const day = limits.canon_writes_per_day;
  if (day !== undefined) {
    assertLimit("canon_writes_per_day.limit", day.limit);
    assertLimit("canon_writes_per_day.used", day.used);
  }
  let runUsed = 0;
  let dayUsed = day?.used ?? 0;
  const dayLimit = day?.limit ?? Number.MAX_SAFE_INTEGER;

  return {
    chargeWrite(): void {
      if (runUsed >= limits.canon_writes_per_run) {
        throw new BudgetExhausted("canon_writes_per_run", limits.canon_writes_per_run);
      }
      if (dayUsed >= dayLimit) {
        throw new BudgetExhausted("canon_writes_per_day", dayLimit);
      }
      runUsed += 1;
      dayUsed += 1;
    },
    usage() {
      return {
        canon_writes_per_run: { used: runUsed, limit: limits.canon_writes_per_run },
        canon_writes_per_day: { used: dayUsed, limit: dayLimit },
      };
    },
  };
}
