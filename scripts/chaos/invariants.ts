import type { Database } from "bun:sqlite";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  doctorVault, getCanonReceiptRecord, inspectCanonRecovery, inspectLedgerHealth,
  inspectServeDoctor, listCanonPagesReport, readHolds, RECEIPTS_PATH, sha256Hex, verifyPurge,
} from "../../packages/core/src";
import { rebuildDerived } from "../../packages/core/src/internal";
import { assertWorldState } from "../../packages/core/src/world/integrity";
import { contentSignature } from "../../packages/core/src/claims/hash";
import type { Fixture } from "./fixture";
import type { RetrievalPort } from "../../packages/core/src";

export class InvariantFailure extends Error {
  constructor(code: string, readonly detail?: unknown) { super(code); this.name = "InvariantFailure"; }
}

function requireInvariant(condition: boolean, code: string): void {
  if (!condition) throw new InvariantFailure(code);
}

const json = (value: unknown): string => JSON.stringify(value);

/** Only the operation's explicit targets may differ from the committed baseline. */
function checkPreservation(db: Database, vault: string, fixture: Fixture, portableRestore: boolean): void {
  const operation = fixture.operation.replace(/^typed-/, "");
  const changedClaims = ["canon", "correction", "undo", "purge"].includes(operation)
    ? new Set(fixture.activeTargets?.claims ?? []) : new Set<string>();
  const changedReceipts = ["undo", "purge"].includes(operation)
    ? new Set(fixture.activeTargets?.receipts ?? []) : new Set<string>();
  const changedPaths = ["correction", "undo", "purge"].includes(operation)
    ? new Set(fixture.baseline.receipts.filter(row => fixture.activeTargets?.receipts.includes(row.receipt_id as string)).map(row => row.page_path))
    : new Set<unknown>();
  const purgeStarted = operation === "purge" && db.query("SELECT 1 FROM event_purges LIMIT 1").get() !== null;
  for (const row of fixture.baseline.events) {
    const id = row.event_id as string;
    const current = db.query("SELECT * FROM events WHERE event_id=?").get(id);
    if (purgeStarted && fixture.eventIds.includes(id)) {
      requireInvariant(current === null, "purge_incomplete");
      requireInvariant(db.query("SELECT 1 FROM event_purges WHERE event_id=?").get(id) !== null, "purge_receipt_missing");
    } else requireInvariant(isDeepStrictEqual(current, row), "committed_event_changed");
  }
  for (const row of fixture.baseline.claims) {
    const id = row.claim_id as string;
    // Portable restore heals missing legacy signatures using the existing
    // content-signature contract; snapshot and source-vault checks stay exact.
    const expected = portableRestore && row.content_hash === "" && row.is_world_typed === 0 ? {
      ...row, content_hash: contentSignature({
        kind: row.kind as string, target: row.target as string | null, body: row.body as string,
        frontmatter: JSON.parse(row.frontmatter as string), subjects: JSON.parse(row.subjects as string),
        producer: row.producer as string, confidence: row.confidence as number,
      }),
    } : row;
    if (!changedClaims.has(id)) requireInvariant(isDeepStrictEqual(db.query("SELECT * FROM claims WHERE claim_id=?").get(id), expected), "committed_claim_changed");
  }
  for (const row of fixture.baseline.receipts) {
    const id = row.receipt_id as string;
    if (!changedReceipts.has(id)) requireInvariant(isDeepStrictEqual(getCanonReceiptRecord(db, id), row), "committed_receipt_changed");
  }
  for (const file of fixture.baseline.files) {
    if (!changedPaths.has(file.path)) requireInvariant(existsSync(join(vault, file.path)) && readFileSync(join(vault, file.path), "utf8") === file.bytes, "committed_file_changed");
  }
  for (const table of fixture.baseline.typed) {
    for (const row of table.rows) {
      if (operation === "purge") continue;
      const current = db.query(`SELECT * FROM ${table.table} WHERE ${table.key}=?`).all(row[table.key] as string);
      requireInvariant(current.some(value => isDeepStrictEqual(value, row)), "committed_typed_support_changed");
    }
  }
}

export function projection(db: Database): string {
  return json({
    search: db.query("SELECT * FROM search_documents ORDER BY doc_id").all(),
    fts: db.query("SELECT * FROM search_docs ORDER BY doc_id").all(),
    hits: db.query("SELECT doc_id FROM search_docs WHERE search_docs MATCH 'astronomy OR lighthouse' ORDER BY doc_id").all(),
    graph: db.query("SELECT * FROM graph_edges ORDER BY src,dst,kind").all(),
  });
}

export async function retrievalProjection(port: RetrievalPort): Promise<string> {
  const results = [];
  for (const text of ["astronomy OR lighthouse", "Acme"]) {
    const result = await port.search({ text, mode: "lexical", scope: {}, ceiling: "private", limit: 100, deadline_ms: 10_000 });
    results.push({ hits: result.hits, degraded: result.degraded, space: result.space });
  }
  return json(results);
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
export async function checkVault(db: Database, vault: string, fixture: Fixture, portableRestore = false): Promise<void> {
  requireInvariant(inspectLedgerHealth(db, { full: true }).ok, "ledger_integrity");
  assertWorldState(db);
  requireInvariant(doctorVault(vault, db).counts.invalid === 0, "doctor_pages");
  requireInvariant(inspectServeDoctor(db, vault, { host_checks: false }).ok, "doctor_runtime");
  const recovery = inspectCanonRecovery(db);
  requireInvariant(!recovery.pending && recovery.projection_pending === 0, "canon_recovery_pending");
  requireInvariant(readHolds(db).length === 0, "canon_holds");
  requireInvariant(db.query("SELECT 1 FROM extract_batches LIMIT 1").get() === null, "extraction_journal_pending");

  checkPreservation(db, vault, fixture, portableRestore);

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
    const receipt = getCanonReceiptRecord(db, latest!.last_receipt!);
    const hash = sha256Hex(readFileSync(join(vault, page.relPath)));
    requireInvariant(receipt !== null && "after_hash" in receipt && receipt.page_path === page.relPath && receipt.after_hash === hash && hash === latest!.last_hash, "receipt_file_hash");
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

  if (fixture.operation === "purge" || fixture.operation === "typed-purge") {
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
  const after = projection(db);
  if (after !== before) throw new InvariantFailure("rebuild_not_equal", { before: JSON.parse(before), after: JSON.parse(after) });
}
