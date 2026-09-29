import type { Database } from "bun:sqlite";
import { CanonRecoveryError, inspectCanonRecovery, readCanonWriteIntent } from "../canon/write-intent";

/** One canon write commits or is recovered within moments; an intent this old is a killed or stuck write. */
export const CANON_INTENT_SLA_SECONDS = 300;

/** The doctor failure for a canon write intent pending past the SLA, or null. */
export function staleCanonIntentFailure(db: Database, now: string): string | null {
  if (!inspectCanonRecovery(db).pending) return null;
  const next = "run: kizuki recover --json";
  try {
    const { receipt } = readCanonWriteIntent(db)!;
    const age = Math.floor((Date.parse(now) - Date.parse(receipt.at)) / 1000);
    if (Number.isFinite(age) && age <= CANON_INTENT_SLA_SECONDS) return null;
    const stale = Number.isFinite(age) ? `${Math.max(0, age)}s` : "an unknown time";
    return `canon write intent ${receipt.receipt_id} pending for ${stale} (SLA ${CANON_INTENT_SLA_SECONDS}s); ${next}`;
  } catch (error) {
    if (!(error instanceof CanonRecoveryError)) throw error;
    return `canon write intent unreadable (${error.reason}); ${next}`;
  }
}
