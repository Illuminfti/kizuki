import type { Database } from "bun:sqlite";
import { tableColumns } from "../ledger/schema";

/** Exact filing is serialized and deduplicated within the caller's read view. */
export function applyScopedClaimIdempotency(db: Database): void {
  // Historical writers acquire the staging column only on first filing.
  // Until then their native index must remain readable without widening rows.
  if (!tableColumns(db, "claims").includes("content_hash")) return;
  const index = db.query<{ sql: string }, []>(
    "SELECT sql FROM sqlite_master WHERE type='index' AND name='claims_idempotency'",
  ).get();
  if (index !== null && !/\bUNIQUE\b/i.test(index.sql)) return;
  db.exec(`DROP INDEX IF EXISTS claims_idempotency;
    CREATE INDEX claims_idempotency ON claims(kind, coalesce(target, ''), body_hash)
      WHERE status='live' AND kind<>'purge_review'
        AND (content_hash IS NULL OR content_hash='') AND is_world_typed=0;`);
}
