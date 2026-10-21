import type { Database } from "bun:sqlite";
import { getCanonReceipt } from "../canon/receipts";
import { isWorldCanonReceipt } from "../canon/world-receipt";
import { cutoffSequence, type KnownCutoff } from "./known/cutoff";

export function identityReceiptCurrent(db: Database, claimId: string, id: string, cutoff?: KnownCutoff): boolean {
  const receipt = getCanonReceipt(db, id);
  if (receipt === null || !isWorldCanonReceipt(receipt) || receipt.state !== "retained" || !receipt.claim_ids.includes(claimId)) return false;
  if (cutoff === undefined) return true;
  // Filing and canon completion are separate recorded positions. A future
  // receipt must not activate an assertion in an earlier saved snapshot.
  const sequence = cutoffSequence(cutoff);
  return db.query(`SELECT 1 WHERE EXISTS(SELECT 1 FROM claim_lifecycle_history
      WHERE claim_id=? AND receipt_id=? AND sequence<=?)
    OR EXISTS(SELECT 1 FROM claim_history_coverage v WHERE v.claim_id=? AND v.coverage='baseline_only'
      AND v.complete_from_sequence<=? AND NOT EXISTS(SELECT 1 FROM claim_lifecycle_history h WHERE h.claim_id=v.claim_id AND h.receipt_id=?))
  `).get(claimId, id, sequence, claimId, sequence, id) !== null;
}

