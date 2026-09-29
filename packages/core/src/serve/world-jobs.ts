import type { Database } from "bun:sqlite";
import { redactReceiptError } from "./receipts";

export interface WorldJobContext {
  readonly db: Database;
  readonly vaultPath: string;
  readonly now: () => string;
  /** Read between bounded units of work; true means finish the current unit and return. */
  readonly stopRequested: () => boolean;
  /** Whether the pass has a model bound. A job that needs one reports pending work instead of failing. */
  readonly modelConfigured: boolean;
}

export interface WorldJob {
  /** Stable identifier, used in receipt errors. */
  readonly id: string;
  /**
   * Bounded work for one pass, after extraction. It owns its own transactions
   * and never holds the canon writer across a model request. A thrown error
   * degrades the pass and does not stop the jobs after it.
   */
  readonly run: (ctx: WorldJobContext) => void | Promise<void>;
}

/** Background jobs run once per sync pass in this order. A workstream adds one line under its marker. */
export const WORLD_JOBS: readonly WorldJob[] = [
  // slot: consol
  // slot: fcst
];

let registered: readonly WorldJob[] = [];

/** Test seam behind `@kizuki/core/testing`: jobs run until the returned disposer is called. */
export function registerWorldJobs(jobs: readonly WorldJob[]): () => void {
  const ids = new Set([...WORLD_JOBS, ...registered].map((job) => job.id));
  for (const job of jobs) {
    if (ids.has(job.id)) throw new Error(`world job ${job.id} is already registered`);
    ids.add(job.id);
  }
  const added = [...jobs];
  registered = [...registered, ...added];
  return () => { registered = registered.filter((job) => !added.includes(job)); };
}

export interface WorldJobsResult {
  readonly errors: readonly string[];
  /** A stop request arrived before every job ran. */
  readonly stopped: boolean;
}

export async function runWorldJobs(ctx: WorldJobContext): Promise<WorldJobsResult> {
  const errors: string[] = [];
  for (const job of [...WORLD_JOBS, ...registered]) {
    if (ctx.stopRequested()) return { errors, stopped: true };
    try {
      await job.run(ctx);
    } catch (error) {
      errors.push(`world_job:${job.id}:${redactReceiptError(error)}`);
    }
  }
  return { errors, stopped: false };
}
