import { LedgerLeaseHeldError } from "@kizuki/core";

/** First and longest wait between start attempts while another process holds the ledger. */
export const STARTUP_HELD_BACKOFF_MS = { first: 2_000, cap: 30_000 } as const;

export interface StartupWaitOptions {
  readonly log: (line: string) => void;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly signal?: AbortSignal;
  /** False after startup: a stopped lifecycle can never be restarted by cleanup. */
  readonly shouldRetry?: () => boolean;
}

/**
 * Run the daemon's start, and start again while the ledger is held. A writer
 * that outlasts the ledger's own bounded waits is transient, not a reason to
 * exit: an exit would spend one of the supervisor's few start attempts on
 * something that clears by itself. Every other failure ends the start.
 */
export async function untilLedgerFree<T>(
  start: () => Promise<T>,
  options: StartupWaitOptions,
): Promise<T | undefined> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    options.signal?.addEventListener("abort", finish, { once: true });
    if (options.signal?.aborted) finish();
  }));
  for (let attempt = 0; ; attempt += 1) {
    if (options.signal?.aborted) return undefined;
    try {
      return await start();
    } catch (error) {
      if (!(error instanceof LedgerLeaseHeldError)) throw error;
      if (options.signal?.aborted) return undefined;
      if (options.shouldRetry?.() === false) throw error;
      const wait = Math.min(STARTUP_HELD_BACKOFF_MS.first * 2 ** Math.min(attempt, 4), STARTUP_HELD_BACKOFF_MS.cap);
      options.log(JSON.stringify({
        event: "start_held",
        reason: error.code,
        retry_in_ms: wait,
        next: "the daemon starts when the writer releases the ledger; nothing is lost",
      }));
      await sleep(wait);
    }
  }
}
