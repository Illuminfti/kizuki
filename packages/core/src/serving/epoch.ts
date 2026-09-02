import type { Database } from "bun:sqlite";
import { tableExists } from "../ledger/schema";

function countOf(db: Database, sql: string): number {
  return db.query<{ count: number }, []>(sql).get()?.count ?? 0;
}

/**
 * The vault's claims epoch: how many times the working model has been
 * corrected or a reading retired. A context packet carries the epoch it was
 * built under, so a harness that cached one learns on its next call that it
 * is stale (RFC 0002 §6.5). It is counted rather than stored because a
 * counter is one more thing that can disagree with the rows it summarizes.
 */
export function claimsEpoch(db: Database): number {
  let epoch = 0;
  if (tableExists(db, "claims")) {
    epoch += countOf(
      db,
      "SELECT count(*) AS count FROM claims WHERE authority = 'owner_correction'",
    );
  }
  if (tableExists(db, "claim_supersessions")) {
    epoch += countOf(db, "SELECT count(*) AS count FROM claim_supersessions");
  }
  return epoch;
}
