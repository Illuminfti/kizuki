import type { Database } from "bun:sqlite";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  doctorVault, getCanonReceiptRecord, inspectCanonRecoveryDetail, inspectLedgerHealth,
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

function requireInvariant(condition: boolean, code: string): asserts condition {
  if (!condition) throw new InvariantFailure(code);
}

const json = (value: unknown): string => JSON.stringify(value);

/** Build the exact permitted lifecycle image; content and provenance never get a blanket exemption. */
function expectedClaim(db: Database, row: Record<string, unknown>, current: Record<string, unknown>, operation: string): Record<string, unknown> {
  const expected = { ...row };
  const id = row.claim_id as string;
  if (operation === "canon" && current.receipt_id !== row.receipt_id) {
    const receipt = getCanonReceiptRecord(db, current.receipt_id as string);
    requireInvariant(receipt !== null && "claim_ids" in receipt && receipt.kind === "write" && receipt.writer === "loop" && receipt.claim_ids.includes(id), "committed_claim_changed");
    expected.receipt_id = current.receipt_id;
  } else if (operation === "correction" && current.status !== row.status) {
    const transition = db.query<{ winner: string; at: string; rule: string }, [string]>("SELECT winner,at,rule FROM claim_supersessions WHERE loser=? ORDER BY at DESC LIMIT 1").get(id);
    const winner = transition === null ? null : db.query<{ authority: string; valid_from: string }, [string]>("SELECT authority,valid_from FROM claims WHERE claim_id=?").get(transition.winner);
    requireInvariant(transition?.rule === "R5" && winner?.authority === "owner_correction", "committed_claim_changed");
    expected.status = "superseded";
    expected.superseded_by = transition.winner;
    expected.retracted_at = transition.at;
    expected.valid_to = row.valid_to === null || Date.parse(winner.valid_from) < Date.parse(row.valid_to as string) ? winner.valid_from : row.valid_to;
  } else if (operation === "undo" && current.status !== row.status) {
    const original = getCanonReceiptRecord(db, row.receipt_id as string);
    const revert = original !== null && "reverted_by" in original && original.reverted_by !== null ? getCanonReceiptRecord(db, original.reverted_by) : null;
    requireInvariant(revert !== null && "kind" in revert && revert.kind === "revert" && revert.reverts === row.receipt_id && revert.claim_ids.includes(id), "committed_claim_changed");
    expected.status = "reverted";
    expected.retracted_at = revert.at;
  } else if (operation === "purge" && current.status !== row.status) {
    const provenance = JSON.parse(row.provenance as string) as string[];
    const purges = provenance.map(event => db.query<{ purged_at: string }, [string]>("SELECT purged_at FROM event_purges WHERE event_id=?").get(event));
    requireInvariant(provenance.length > 0 && purges.every(receipt => receipt !== null) && new Set(purges.map(receipt => receipt!.purged_at)).size === 1, "committed_claim_changed");
    Object.assign(expected, { status: "purged", retracted_at: purges[0]!.purged_at,
      body: "", object: null, target: null, subject: null, predicate: null,
      subjects: "[]", frontmatter: "{}", model_ref: null,
    });
  }
  return expected;
}

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
    const current = db.query("SELECT * FROM claims WHERE claim_id=?").get(id) as Record<string, unknown> | null;
    requireInvariant(current !== null, "committed_claim_changed");
    const permitted = changedClaims.has(id) ? expectedClaim(db, expected, current, operation) : expected;
    requireInvariant(isDeepStrictEqual(current, permitted), "committed_claim_changed");
  }
  for (const row of fixture.baseline.receipts) {
    const id = row.receipt_id as string;
    const current = getCanonReceiptRecord(db, id);
    if (changedReceipts.has(id) && operation === "undo" && current !== null && "reverted_by" in current && current.reverted_by !== row.reverted_by) {
      const revert = current.reverted_by === null ? null : getCanonReceiptRecord(db, current.reverted_by);
      requireInvariant(revert !== null && "kind" in revert && revert.kind === "revert" && revert.reverts === id, "committed_receipt_changed");
      requireInvariant(isDeepStrictEqual(current, { ...row, reverted_by: current.reverted_by }), "committed_receipt_changed");
    } else if (!changedReceipts.has(id) || operation !== "purge") requireInvariant(isDeepStrictEqual(current, row), "committed_receipt_changed");
  }
  for (const file of fixture.baseline.files) {
    if (!changedPaths.has(file.path)) requireInvariant(existsSync(join(vault, file.path)) && readFileSync(join(vault, file.path), "utf8") === file.bytes, "committed_file_changed");
  }
  for (const table of fixture.baseline.typed) {
    for (const row of table.rows) {
      const current = db.query(`SELECT * FROM ${table.table} WHERE ${table.key}=?`).all(row[table.key] as string);
      if (operation === "purge" && purgeStarted && changedClaims.has(row.claim_id as string)) {
        requireInvariant(current.length === 0, "purge_typed_support_remaining");
        continue;
      }
      if (operation === "purge" && purgeStarted && table.table === "claim_v2_support_events" && fixture.eventIds.includes(row.event_id as string)) {
        requireInvariant(current.length === 0, "purge_typed_support_remaining");
        continue;
      }
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
export async function checkVault(db: Database, vault: string, fixture: Fixture, portableRestore = false, port?: RetrievalPort): Promise<void> {
  requireInvariant(inspectLedgerHealth(db, { full: true }).ok, "ledger_integrity");
  assertWorldState(db);
  const doctor = doctorVault(vault, db);
  requireInvariant(doctor.counts.invalid === 0, "doctor_pages");
  requireInvariant(doctor.doctrine.every(item => item.state === "current" || item.state === "owner-edited"), "doctor_doctrine");
  requireInvariant(doctor.control.length === 0, "doctor_control");
  requireInvariant(inspectServeDoctor(db, vault, { host_checks: false }).ok, "doctor_runtime");
  const recovery = inspectCanonRecoveryDetail(db, vault);
  requireInvariant(!recovery.pending && recovery.projection_pending === 0, "canon_recovery_pending");
  requireInvariant(recovery.quarantine.state !== "unsafe" && recovery.quarantined === 0, "doctor_quarantine");
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
  requireInvariant(!fileNames(vault).some(path => {
    const name = basename(path);
    return name.endsWith(".stage") || /^\..+\.[0-9A-HJKMNP-TV-Z]{26}\.tmp$/.test(name) || /^\.canon-[a-f0-9]{64}\.tmp$/.test(name);
  }), "orphan_stage");
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
      for (const receipt of erased) requireInvariant((await verifyPurge(db, vault, receipt.receipt_id, port === undefined ? {} : { retrieval: port })).ok, "purge_absence_proof");
    }
  } else {
    for (const id of fixture.eventIds) requireInvariant(db.query("SELECT 1 FROM events WHERE event_id=?").get(id) !== null, "committed_event_lost");
  }
  const before = projection(db);
  rebuildDerived(db, vault);
  const after = projection(db);
  if (after !== before) throw new InvariantFailure("rebuild_not_equal", { before: JSON.parse(before), after: JSON.parse(after) });
}
