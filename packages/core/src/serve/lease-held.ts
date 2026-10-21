import type { Database } from "bun:sqlite";
import { isLedgerBusy } from "../ledger/busy";
import { readServePid } from "./process-marker";
import { pidAlive, readLease } from "./leases";
import { LEDGER_LEASE_HELD_STOP } from "./types";

export { LEDGER_LEASE_HELD_STOP };

export const LEASE_HELD_CODE = "lease_held";

/**
 * The lease a long CLI ingest records while it runs. SQLite does not say who
 * holds the write lock, so this row is how the daemon and doctor name it. It
 * never grants or refuses anything.
 */
export const INGEST_LEASE = "ingest";

/**
 * A command stopped because another process holds the ledger writer, not
 * because anything is broken. The message names the holder and says that a
 * re-run resumes from the last durable checkpoint; `database is locked` never
 * reaches a person.
 */
export class LedgerLeaseHeldError extends Error {
  override readonly name = "LedgerLeaseHeldError";
  readonly code = LEASE_HELD_CODE;

  constructor(message: string, options?: { cause?: unknown }) {
    super(
      message,
      options?.cause === undefined ? undefined : { cause: options.cause },
    );
  }
}

export interface LedgerHolder {
  readonly pid: number;
  readonly kind: "daemon" | "ingest";
}

/**
 * Who holds the ledger writer for this vault, as far as the records show: a
 * live long ingest (read from `db` when the caller has one) or the serve
 * daemon's marker. A daemon explaining its own skipped pass passes its pid as
 * `self`, so it never reports itself.
 */
export function ledgerLeaseHolder(
  vaultPath: string,
  db?: Database,
  self = -1,
): LedgerHolder | null {
  if (db !== undefined) {
    try {
      const ingest = readLease(db, INGEST_LEASE);
      if (ingest !== null && ingest.holder_pid !== self && pidAlive(ingest.holder_pid)) {
        return { pid: ingest.holder_pid, kind: "ingest" };
      }
    } catch {
      // A lease that cannot be read names nobody; the marker below still may.
    }
  }
  let pid: number | null = null;
  try { pid = readServePid(vaultPath); }
  catch {
    // A marker that cannot be read names nobody; this runs while explaining a refusal.
  }
  return pid !== null && pid !== self && pidAlive(pid) ? { pid, kind: "daemon" } : null;
}

function holderPhrase(holder: LedgerHolder | null): string {
  if (holder === null) return "another kizuki process holds the ledger writer lease";
  const who = holder.kind === "daemon" ? "the kizuki serve daemon" : "a running kizuki ingest";
  return `${who} (pid ${holder.pid}) holds the ledger writer lease`;
}

export function leaseHeldMessage(vaultPath: string, db?: Database): string {
  return `${LEASE_HELD_CODE}: ${holderPhrase(ledgerLeaseHolder(vaultPath, db))}; nothing was lost, and running the same command again resumes from the last checkpoint`;
}

/** What a skipped rail pass records: the typed stop, the holder, and that the rail retries by itself. */
export function railLeaseHeldNote(vaultPath: string, db: Database): string {
  return `${LEDGER_LEASE_HELD_STOP}: ${holderPhrase(ledgerLeaseHolder(vaultPath, db, process.pid))}; this pass was skipped and the rail retries with backoff`;
}

/** The typed refusal for a busy ledger, or null when the failure is unrelated. */
export function asLeaseHeld(
  vaultPath: string,
  error: unknown,
  db?: Database,
): LedgerLeaseHeldError | null {
  if (error instanceof LedgerLeaseHeldError) return error;
  if (!isLedgerBusy(error)) return null;
  return new LedgerLeaseHeldError(leaseHeldMessage(vaultPath, db), {
    cause: error,
  });
}

/** Run `work`, translating a busy ledger into the typed lease-held refusal. */
export async function withLeaseHeldRefusal<T>(
  vaultPath: string,
  work: () => Promise<T>,
): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw asLeaseHeld(vaultPath, error) ?? error;
  }
}
