import { BudgetExhausted, type BudgetTracker } from "../canon/budget";
import { reciteCanonPageOwned } from "../canon/apply";
import { pagesCitingEndedVersions } from "../canon/citations";
import { snapshotCanonIo, withCanonMutationAsync } from "../canon/io";
import type { CanonIo } from "../canon";
import { inspectCanonRecovery } from "../canon/write-intent";
import { VaultMutationError } from "../vault/mutation-scope";
import { redactReceiptError } from "../util/receipt-redaction";
import { settleWriteReservations } from "./budget-ledger";

export interface RecitePassResult {
  readonly canon_writes: number;
  readonly errors: string[];
  readonly stopped: string | null;
}

/**
 * A page restored for a returned record can still cite the version the
 * deletion ended, which keeps it out of every index. Once its claims have
 * live evidence again, its citations are rewritten, one page per writer
 * hold, under the pass's budget. Runs after the write pass in the sync rail.
 */
export async function reciteEndedSources(
  io: CanonIo,
  budget: BudgetTracker,
  limit: number,
  stopRequested?: () => boolean,
): Promise<RecitePassResult> {
  io = snapshotCanonIo(io);
  const errors: string[] = [];
  let written = 0;
  for (const path of pagesCitingEndedVersions(io.db)) {
    if (written >= limit) break;
    if (stopRequested?.() === true) return { canon_writes: written, errors, stopped: "serve:stop_requested" };
    if (inspectCanonRecovery(io.db).pending) return { canon_writes: written, errors, stopped: "recovery:held" };
    const deadline = performance.now() + SETTLE_WAIT_MS;
    for (;;) {
      try {
        await withCanonMutationAsync(io, (scope, owned) => {
          try {
            settleWriteReservations(owned.db, owned.vault_path);
            if (reciteCanonPageOwned(scope, owned, path, budget) !== null) written += 1;
          } finally {
            settleWriteReservations(owned.db, owned.vault_path);
          }
        });
        break;
      } catch (error) {
        if (error instanceof VaultMutationError && error.code === "writer_busy") {
          if (performance.now() >= deadline) return { canon_writes: written, errors, stopped: "lock:busy" };
          await new Promise(resolve => setTimeout(resolve, SETTLE_POLL_MS));
          continue;
        }
        if (error instanceof BudgetExhausted) return { canon_writes: written, errors, stopped: error.stopped };
        errors.push(redactReceiptError(error));
        return { canon_writes: written, errors, stopped: null };
      }
    }
  }
  return { canon_writes: written, errors, stopped: null };
}

/** The write pass's wait for a writer another short hold owns. */
const SETTLE_WAIT_MS = 5_000;
const SETTLE_POLL_MS = 25;
