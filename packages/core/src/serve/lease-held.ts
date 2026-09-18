import { isLedgerBusy } from "../ledger/busy";
import { readServePid } from "./daemon";
import { pidAlive } from "./leases";

export const LEASE_HELD_CODE = "lease_held";

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

/** Who holds the ledger writer for this vault, as far as the marker shows. */
export function ledgerLeaseHolder(vaultPath: string): { pid: number } | null {
  const pid = readServePid(vaultPath);
  return pid !== null && pidAlive(pid) ? { pid } : null;
}

export function leaseHeldMessage(vaultPath: string): string {
  const holder = ledgerLeaseHolder(vaultPath);
  const who =
    holder === null
      ? "another kizuki process holds the ledger writer lease"
      : `the kizuki serve daemon (pid ${holder.pid}) holds the ledger writer lease`;
  return `${LEASE_HELD_CODE}: ${who}; nothing was lost, and running the same command again resumes from the last checkpoint`;
}

/** The typed refusal for a busy ledger, or null when the failure is unrelated. */
export function asLeaseHeld(
  vaultPath: string,
  error: unknown,
): LedgerLeaseHeldError | null {
  if (error instanceof LedgerLeaseHeldError) return error;
  if (!isLedgerBusy(error)) return null;
  return new LedgerLeaseHeldError(leaseHeldMessage(vaultPath), {
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
