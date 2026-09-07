import type { Database } from "bun:sqlite";
import { LedgerStoreError } from "./errors";
import { oneShotGet, tableColumns, tableExists } from "./schema";

const BATCH_TABLE = `CREATE TABLE purge_batches (
  batch_id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK(state IN ('discovering','ready','legacy_unresolved')),
  created_at TEXT NOT NULL
) STRICT`;
const MEMBERS_TABLE = `CREATE TABLE purge_batch_receipts (
  receipt_id TEXT PRIMARY KEY REFERENCES event_purges(receipt_id),
  batch_id TEXT NOT NULL REFERENCES purge_batches(batch_id)
) STRICT`;
const MEMBERS_INDEX = "CREATE INDEX purge_batch_receipts_by_batch ON purge_batch_receipts(batch_id, receipt_id)";

/** Ledger v19 owns durable purge batch membership; backup remains v3. */
export function applyPurgeBatchesV19(db: Database): void {
  db.exec(`${BATCH_TABLE}; ${MEMBERS_TABLE}; ${MEMBERS_INDEX};`);
  // Older receipts lack batch identity. Only an operation's explicit event-ID
  // inventory can recover membership; timestamp/reason similarity is no proof.
  const candidates = new Map<string, { at: string; valid: boolean; events: Set<string>; receipts: Set<string> }>();
  const legacyOps = tableExists(db, "purge_ops") ? db.query<{ receipt_id: string; ids: string | null; created_at: string }, []>(
    "SELECT receipt_id, CASE WHEN length(ids)<=16777216 THEN ids ELSE NULL END AS ids, created_at FROM purge_ops ORDER BY receipt_id, op_id",
  ).all() : [];
  for (const row of legacyOps) {
    let batch = candidates.get(row.receipt_id);
    if (batch === undefined) {
      batch = { at: row.created_at, valid: true, events: new Set(), receipts: new Set() };
      candidates.set(row.receipt_id, batch);
    }
    try {
      const ids: unknown = row.ids === null ? null : JSON.parse(row.ids);
      if (!Array.isArray(ids) || !ids.every(id => typeof id === "string" && id.length <= 1_024)) throw new Error("legacy inventory unavailable");
      for (const id of ids as string[]) if (id.startsWith("event:")) batch.events.add(id.slice(6));
    } catch { batch.valid = false; }
  }
  const owners = new Map<string, Set<string>>();
  for (const [batchId, batch] of candidates) {
    for (const group of groups([...batch.events], 500)) {
      for (const row of db.query<{ receipt_id: string }, [string]>(
        "SELECT receipt_id FROM event_purges WHERE event_id IN (SELECT value FROM json_each(?))",
      ).all(JSON.stringify(group))) batch.receipts.add(row.receipt_id);
    }
    if (!batch.receipts.has(batchId)) batch.valid = false;
    for (const receipt of batch.receipts) {
      const set = owners.get(receipt) ?? new Set<string>();
      set.add(batchId);
      owners.set(receipt, set);
    }
  }
  const insertBatch = db.query("INSERT INTO purge_batches VALUES(?,?,?)");
  const insertMember = db.query("INSERT INTO purge_batch_receipts VALUES(?,?)");
  for (const [batchId, batch] of candidates) {
    const valid = batch.valid && [...batch.receipts].every(receipt => owners.get(receipt)?.size === 1);
    insertBatch.run(batchId, valid ? "discovering" : "legacy_unresolved", batch.at);
    if (valid) for (const receipt of batch.receipts) insertMember.run(receipt, batchId);
  }
  // No inferred membership is invented for hold-only legacy work.
  db.exec(`INSERT OR IGNORE INTO purge_batches
             SELECT proposal_id, 'legacy_unresolved', min(held_at) FROM canon_holds GROUP BY proposal_id;`);
  if (tableExists(db, "purge_ops")) db.exec("UPDATE purge_ops SET state='pending', proof=NULL, done_at=NULL");
}

function* groups<T>(items: readonly T[], size: number): Generator<T[]> {
  for (let offset = 0; offset < items.length; offset += size) yield items.slice(offset, offset + size);
}

export function assertPurgeBatchSchema(db: Database): void {
  for (const [table, columns] of [
    ["purge_batches", ["batch_id", "state", "created_at"]],
    ["purge_batch_receipts", ["receipt_id", "batch_id"]],
  ] as const) {
    if (!tableExists(db, table) || JSON.stringify(tableColumns(db, table)) !== JSON.stringify(columns) ||
        oneShotGet<{ strict: number }>(db, "SELECT strict FROM pragma_table_list WHERE name=?", table)?.strict !== 1) {
      throw new LedgerStoreError("corrupt", "purge batch schema is invalid");
    }
  }
  const normalize = (sql: string) => sql.replace(/\s+/g, "").replace(/;$/, "").toLowerCase();
  for (const [name, expected] of [
    ["purge_batches", BATCH_TABLE], ["purge_batch_receipts", MEMBERS_TABLE],
    ["purge_batch_receipts_by_batch", MEMBERS_INDEX],
  ] as const) {
    const actual = oneShotGet<{ sql: string }>(db, "SELECT sql FROM sqlite_master WHERE name=?", name)?.sql;
    if (actual === undefined || normalize(actual) !== normalize(expected)) {
      throw new LedgerStoreError("corrupt", "purge batch constraints are invalid");
    }
  }
  if (oneShotGet(db, "SELECT 1 FROM pragma_foreign_key_check('purge_batch_receipts') LIMIT 1") !== null) {
    throw new LedgerStoreError("corrupt", "purge batch membership is invalid");
  }
}
