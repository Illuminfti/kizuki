import type { Database } from "bun:sqlite";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  doctorVault, getCanonReceiptRecord, inspectCanonRecovery, inspectLedgerHealth,
  inspectServeDoctor, listCanonPagesReport, readHolds, RECEIPTS_PATH, sha256Hex, verifyPurge,
} from "../../packages/core/src";
import { rebuildDerived } from "../../packages/core/src/internal";
import type { Fixture } from "./fixture";

export class InvariantFailure extends Error {
  constructor(code: string) { super(code); this.name = "InvariantFailure"; }
}

function requireInvariant(condition: boolean, code: string): void {
  if (!condition) throw new InvariantFailure(code);
}

const json = (value: unknown): string => JSON.stringify(value);

export function projection(db: Database): string {
  return json({
    search: db.query("SELECT * FROM search_documents ORDER BY doc_id").all(),
    fts: db.query("SELECT * FROM search_docs ORDER BY doc_id").all(),
    hits: db.query("SELECT doc_id FROM search_docs WHERE search_docs MATCH 'astronomy OR lighthouse' ORDER BY doc_id").all(),
    graph: db.query("SELECT * FROM graph_edges ORDER BY src,dst,kind").all(),
  });
}

function fileNames(root: string): string[] {
  const names: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) names.push(...fileNames(path));
    else names.push(path);
  }
  return names;
}

/** Check the recovered state before rebuilding, then compare the complete floor projection. */
export async function checkVault(db: Database, vault: string, fixture: Fixture, sentinel = true): Promise<void> {
  requireInvariant(inspectLedgerHealth(db, { full: true }).ok, "ledger_integrity");
  requireInvariant(doctorVault(vault, db).counts.invalid === 0, "doctor_pages");
  requireInvariant(inspectServeDoctor(db, vault, { host_checks: false }).ok, "doctor_runtime");
  const recovery = inspectCanonRecovery(db);
  requireInvariant(!recovery.pending && recovery.projection_pending === 0, "canon_recovery_pending");
  requireInvariant(readHolds(db).length === 0, "canon_holds");
  requireInvariant(db.query("SELECT 1 FROM extract_batches LIMIT 1").get() === null, "extraction_journal_pending");

  if (sentinel) {
    const id = (fixture.sentinelEvent as { event_id: string }).event_id;
    requireInvariant(json(db.query("SELECT * FROM events WHERE event_id=?").get(id)) === json(fixture.sentinelEvent), "unrelated_event_changed");
    const claimId = (fixture.sentinelClaim as { claim_id: string }).claim_id;
    requireInvariant(json(db.query("SELECT * FROM claims WHERE claim_id=?").get(claimId)) === json(fixture.sentinelClaim), "unrelated_claim_changed");
    const receiptId = (fixture.sentinelReceipt as { receipt_id: string }).receipt_id;
    requireInvariant(json(getCanonReceiptRecord(db, receiptId)) === json(fixture.sentinelReceipt), "unrelated_receipt_changed");
    requireInvariant(readFileSync(join(vault, fixture.sentinelPath), "utf8") === fixture.sentinelBytes, "unrelated_file_changed");
  }

  const log = existsSync(join(vault, RECEIPTS_PATH)) ? readFileSync(join(vault, RECEIPTS_PATH), "utf8") : "";
  const records = log.split("\n").filter(Boolean).map(line => JSON.parse(line) as { receipt_id: string });
  const ids = db.query<{ receipt_id: string }, []>("SELECT receipt_id FROM canon_receipts ORDER BY receipt_id").all().map(row => row.receipt_id);
  requireInvariant(json(records.map(row => row.receipt_id).sort()) === json(ids), "receipt_journal_totality");
  for (const record of records) {
    // Reversion metadata belongs to the ledger; the original append-only journal entry stays unchanged.
    const { reverted_by: _before, ...line } = record as typeof record & { reverted_by?: unknown };
    const { reverted_by: _after, ...row } = getCanonReceiptRecord(db, record.receipt_id) as typeof record & { reverted_by?: unknown };
    requireInvariant(isDeepStrictEqual(line, row), "receipt_journal_bytes");
  }
  const pages = listCanonPagesReport(vault);
  requireInvariant(pages.skipped.length === 0, "orphan_or_torn_page");
  for (const page of pages.pages) {
    const latest = db.query<{ last_receipt: string | null; last_hash: string }, [string]>("SELECT last_receipt,last_hash FROM page_index WHERE rel_path=?").get(page.relPath);
    requireInvariant(latest?.last_receipt != null, "unreceipted_page");
    requireInvariant(sha256Hex(readFileSync(join(vault, page.relPath))) === latest!.last_hash, "receipt_file_hash");
  }
  for (const row of db.query<{ rel_path: string; last_hash: string }, []>("SELECT rel_path,last_hash FROM page_index WHERE last_receipt IS NOT NULL").all()) {
    const file = join(vault, row.rel_path);
    requireInvariant(existsSync(file) || row.last_hash === sha256Hex(new Uint8Array()), "receipted_file_missing");
  }
  requireInvariant(!fileNames(vault).some(path => path.endsWith(".stage")), "orphan_stage");
  const archives = db.query<{ archive_path: string; before_hash: string }, []>("SELECT archive_path,before_hash FROM canon_receipts WHERE archive_path IS NOT NULL").all();
  for (const row of archives) {
    requireInvariant(existsSync(join(vault, row.archive_path)), "archive_missing");
    requireInvariant(sha256Hex(readFileSync(join(vault, row.archive_path))) === row.before_hash, "archive_hash");
  }
  const archiveRoot = join(vault, "archive");
  const archiveNames = new Set(archives.map(row => join(vault, row.archive_path)));
  requireInvariant(!existsSync(archiveRoot) || fileNames(archiveRoot).every(path => archiveNames.has(path)), "orphan_archive");

  if (fixture.operation === "purge") {
    const erased = db.query<{ receipt_id: string }, []>("SELECT receipt_id FROM event_purges ORDER BY receipt_id").all();
    if (erased.length > 0) {
      requireInvariant(db.query("SELECT 1 FROM events WHERE connector_id='chaos.target' LIMIT 1").get() === null, "purge_incomplete");
      for (const receipt of erased) requireInvariant((await verifyPurge(db, vault, receipt.receipt_id)).ok, "purge_absence_proof");
    }
  } else {
    for (const id of fixture.eventIds) requireInvariant(db.query("SELECT 1 FROM events WHERE event_id=?").get(id) !== null, "committed_event_lost");
  }
  const before = projection(db);
  rebuildDerived(db, vault);
  requireInvariant(projection(db) === before, "rebuild_not_equal");
}
