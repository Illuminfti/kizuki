/**
 * Budget enforcement lives inside the writer. A runtime may reserve a durable
 * daily slot using the receipt identity; standalone trackers enforce their
 * supplied per-run and per-day limits in memory.
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

export interface BudgetTracker {
  /** Charges one canon write before the canon file effect; throws when exhausted. */
  chargeWrite(write?: { receipt_id: string; page_path: string; before_hash: string | null }): void;
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
