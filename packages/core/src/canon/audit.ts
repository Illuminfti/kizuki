import type { Database } from "bun:sqlite";
import { tableExists } from "../ledger/schema";
import { listCanonReceipts } from "./receipts";
import type { CanonReceipt, ListCanonReceiptsOptions } from "./receipts";

export interface AuditListOptions {
  since?: string;
  page?: string;
  writer?: string;
  contested?: boolean;
  ambiguous?: boolean;
  reverted?: boolean;
  limit?: number;
  offset?: number;
}

export interface AuditReceipt extends CanonReceipt {
  contested: boolean;
  ambiguous: boolean;
}

function liveContestedKeys(db: Database): Set<string> {
  if (!tableExists(db, "claims")) return new Set();
  const rows = db
    .query<{ claim_key: string }, []>(
      `SELECT claim_key FROM claims
        WHERE status = 'live' AND claim_key IS NOT NULL
        GROUP BY claim_key HAVING count(*) > 1`,
    )
    .all();
  return new Set(rows.map((row) => row.claim_key));
}

function claimKeysForReceipts(
  db: Database,
  receiptIds: readonly string[],
): Map<string, string[]> {
  const byReceipt = new Map<string, string[]>();
  if (!tableExists(db, "claims") || receiptIds.length === 0) return byReceipt;
  const placeholders = receiptIds.map(() => "?").join(", ");
  const rows = db
    .query<{ receipt_id: string; claim_key: string }, string[]>(
      `SELECT receipt_id, claim_key FROM claims
        WHERE receipt_id IN (${placeholders}) AND claim_key IS NOT NULL`,
    )
    .all(...receiptIds);
  for (const row of rows) {
    const list = byReceipt.get(row.receipt_id) ?? [];
    list.push(row.claim_key);
    byReceipt.set(row.receipt_id, list);
  }
  return byReceipt;
}

/** Newest-first receipt list for `kizuki audit` and the TUI. */
export function listAuditReceipts(db: Database, opts: AuditListOptions = {}): AuditReceipt[] {
  const query: ListCanonReceiptsOptions = {
    newest_first: true,
    limit: opts.limit ?? 5000,
  };
  if (opts.page !== undefined) query.page_path = opts.page;
  if (opts.writer !== undefined) query.writer = opts.writer;
  if (opts.since !== undefined) query.since = opts.since;
  if (opts.offset !== undefined) query.offset = opts.offset;
  if (opts.reverted === false) query.include_reverted = false;
  if (opts.reverted === true) query.only_reverted = true;
  if (opts.ambiguous === true) query.only_ambiguous = true;
  if (opts.contested === true) query.only_contested = true;

  let rows = listCanonReceipts(db, query).map((receipt) => ({
    ...receipt,
    contested: false,
    ambiguous: receipt.candidates.length > 0,
  }));


  const contestedKeys = liveContestedKeys(db);
  const keys = claimKeysForReceipts(
    db,
    rows.map((row) => row.receipt_id),
  );
  for (const row of rows) {
    const claimKeys = keys.get(row.receipt_id) ?? [];
    row.contested = claimKeys.some((key) => contestedKeys.has(key));
  }
  return rows;
}
