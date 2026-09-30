import type { Database } from "bun:sqlite";

/** Exact filing is serialized and deduplicated within the caller's read view. */
export function applyScopedClaimIdempotency(db: Database): void {
  const index = db.query<{ sql: string }, []>(
    "SELECT sql FROM sqlite_master WHERE type='index' AND name='claims_idempotency'",
  ).get();
  if (index !== null && !/\bUNIQUE\b/i.test(index.sql)) return;
  db.exec(`DROP INDEX IF EXISTS claims_idempotency;
    CREATE INDEX claims_idempotency ON claims(kind, coalesce(target, ''), body_hash)
      WHERE status='live' AND kind<>'purge_review'
        AND (content_hash IS NULL OR content_hash='') AND is_world_typed=0;`);
}
