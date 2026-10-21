import type { Database } from "bun:sqlite";
import { redactReceiptError } from "../util/receipt-redaction";
import { isPlainObject } from "../util/validate";
import type { WorldTableSpec } from "../world/tables/registry";
import { CANON_CLAIM_RETRY_MIGRATION_VERSION } from "../world/tables/versions";

export const CLAIM_RETRY_FAILURES = 3;
export const CLAIM_RETRY_MS = 24 * 60 * 60_000;
export const CLAIM_RETRY_MAX_REASON = 200;
const MAX_RETRY_AT = 8_640_000_000_000_000 - CLAIM_RETRY_MS;

/** Claim identity is preserved verbatim; only retry metadata has size bounds. */
export function createCanonClaimRetries(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS canon_claim_retries (
    claim_id TEXT PRIMARY KEY NOT NULL REFERENCES claims(claim_id) ON DELETE CASCADE,
    attempts INTEGER NOT NULL CHECK(attempts BETWEEN 1 AND 9007199254740991),
    reason TEXT NOT NULL CHECK(length(reason)<=${CLAIM_RETRY_MAX_REASON}),
    last_at_ms INTEGER NOT NULL CHECK(last_at_ms BETWEEN -8640000000000000 AND ${MAX_RETRY_AT})
  ) STRICT;
  CREATE TRIGGER IF NOT EXISTS canon_claim_retry_finished AFTER UPDATE OF status,receipt_id,is_world_typed ON claims
    WHEN NEW.status!='live' OR NEW.receipt_id IS NOT NULL OR NEW.is_world_typed!=0 BEGIN
      DELETE FROM canon_claim_retries WHERE claim_id=NEW.claim_id;
    END;
  CREATE TRIGGER IF NOT EXISTS canon_claim_retry_live_insert BEFORE INSERT ON canon_claim_retries
    WHEN NOT EXISTS (SELECT 1 FROM claims WHERE claim_id=NEW.claim_id AND status='live' AND receipt_id IS NULL AND is_world_typed=0)
    BEGIN SELECT RAISE(ABORT,'retry requires a live unwritten legacy claim'); END;
  CREATE TRIGGER IF NOT EXISTS canon_claim_retry_live_update BEFORE UPDATE ON canon_claim_retries
    WHEN NOT EXISTS (SELECT 1 FROM claims WHERE claim_id=NEW.claim_id AND status='live' AND receipt_id IS NULL AND is_world_typed=0)
    BEGIN SELECT RAISE(ABORT,'retry requires a live unwritten legacy claim'); END;`);
}

/** Transfer the old private cursor namespace atomically with the ledger upgrade. */
export function applyCanonClaimRetries(db: Database): void {
  createCanonClaimRetries(db);
  const insert = db.query("INSERT OR IGNORE INTO canon_claim_retries VALUES (?,?,?,?)");
  for (const row of db.query<{ claim_id: string; cursor: string }, []>(
    `SELECT c.claim_id,r.cursor FROM rail_cursors r JOIN claims c ON c.claim_id=substr(r.source_key,8)
     WHERE r.rail='kizuki.canon.writer' AND r.source_key LIKE 'legacy:%'
       AND c.status='live' AND c.receipt_id IS NULL AND c.is_world_typed=0`,
  ).iterate()) {
    let value: unknown;
    try { value = JSON.parse(row.cursor); } catch { continue; }
    if (!isPlainObject(value) || Object.keys(value).sort().join() !== "attempts,last_at,reason") continue;
    const { attempts, reason, last_at } = value;
    if (typeof attempts !== "number" || !Number.isSafeInteger(attempts) || attempts < 1 ||
      typeof reason !== "string" || typeof last_at !== "string") continue;
    const at = Date.parse(last_at);
    if (!Number.isSafeInteger(at) || at > MAX_RETRY_AT || new Date(at).toISOString() !== last_at) continue;
    insert.run(row.claim_id, attempts, redactReceiptError(reason).slice(0, CLAIM_RETRY_MAX_REASON), at);
  }
  db.exec("DELETE FROM rail_cursors WHERE rail='kizuki.canon.writer' AND source_key LIKE 'legacy:%'");
}

export const CANON_CLAIM_RETRY_TABLE: WorldTableSpec = {
  name: "canon_claim_retries", class: "bookkeeping", since: CANON_CLAIM_RETRY_MIGRATION_VERSION,
  columns: ["claim_id", "attempts", "reason", "last_at_ms"], create: createCanonClaimRetries,
  erasure: { via: "trigger", triggers: ["canon_claim_retry_finished", "canon_claim_retry_live_insert", "canon_claim_retry_live_update"] },
};
