import type { Database } from "bun:sqlite";
import { isLedgerBusy } from "../ledger/busy";
import { INGEST_LEASE, ledgerLeaseHolder } from "../serve/lease-held";
import { acquireLease, releaseLease, thisProcess } from "../serve/leases";

/**
 * A long ingest commits event after event, and SQLite hands the write lock to
 * whoever asks first, so a waiting daemon rail can be starved for as long as
 * the ingest runs. Between commits the ingest therefore leaves the ledger
 * free for `INGEST_PAUSE_MS` after every `INGEST_SLICE_MS` of writing, but only
 * while a serve daemon is running; without one it never slows down.
 */
export const INGEST_SLICE_MS = 250;
export const INGEST_PAUSE_MS = 150;

export interface IngestSession extends Disposable {
  /** Call after each commit; it pauses when the slice is used up and a daemon is waiting. */
  readonly pace: () => void;
}

export interface IngestClock {
  readonly now: () => number;
  readonly sleep: (ms: number) => void;
}

const REAL_CLOCK: IngestClock = { now: () => performance.now(), sleep: (ms) => Bun.sleepSync(ms) };

/**
 * Record this process as a running ingest, so a daemon that meets the ledger
 * held can name it, and return the pacer the ingest calls between commits.
 * Recording is advisory: when the ledger is too busy to take it, the ingest
 * runs on unrecorded. Declare the session with `using` so the record goes
 * when the command does.
 */
export function beginIngest(db: Database, vaultPath: string, clock: IngestClock = REAL_CLOCK): IngestSession {
  const self = thisProcess();
  let recorded = false;
  try { recorded = acquireLease(db, self, INGEST_LEASE).acquired; }
  catch (error) { if (!isLedgerBusy(error)) throw error; }
  let sliceStart = clock.now();
  return {
    pace() {
      if (clock.now() - sliceStart < INGEST_SLICE_MS) return;
      if (ledgerLeaseHolder(vaultPath, undefined, self.pid)?.kind === "daemon") clock.sleep(INGEST_PAUSE_MS);
      sliceStart = clock.now();
    },
    [Symbol.dispose]() {
      // Ending the session drops the record that names this process the ingest holder.
      if (!recorded) return;
      recorded = false;
      try { releaseLease(db, self, INGEST_LEASE); }
      catch (error) { if (!isLedgerBusy(error)) throw error; }
    },
  };
}
