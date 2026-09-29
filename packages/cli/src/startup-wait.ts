import { LedgerLeaseHeldError } from "@kizuki/core";

/** First and longest wait between start attempts while another process holds the ledger. */
export const STARTUP_HELD_BACKOFF_MS = { first: 2_000, cap: 30_000 } as const;

export interface StartupWaitOptions {
  readonly log: (line: string) => void;
  readonly sleep?: (ms: number) => Promise<void>;
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
): Promise<T> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await start();
    } catch (error) {
      if (!(error instanceof LedgerLeaseHeldError)) throw error;
      const wait = Math.min(STARTUP_HELD_BACKOFF_MS.first * 2 ** attempt, STARTUP_HELD_BACKOFF_MS.cap);
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
