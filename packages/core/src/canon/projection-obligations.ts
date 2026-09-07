import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { refreshDerivedPage, removeDerivedPage } from "../derived";
import { MAX_CANON_INTENT_BYTES, MAX_CANON_IDENTITY_BINDINGS } from "../ledger/canon-recovery-schema";
import { requireSourceEvents, sourcePolicyEpoch } from "../ledger/source-grants";
import { recordSourceStoreWrite } from "../ledger/source-stores";
import { FTS5_RETRIEVAL_ID } from "../retrieval/fts5";
import { validateAbsenceProof, validateRetrievalDoc } from "../contracts/retrieval";
import { sha256Hex } from "../util/hash";
import { isPlainObject } from "../util/validate";
import { parseFrontmatter } from "../vault/frontmatter";
import { validatePage } from "../vault/schema";
import { eventIdFromReference } from "../retrieval/ids";
import { ABSENT_PAGE_HASH, hashBytes } from "../vault/write";
import type { CanonPage } from "../vault/pages";
import type { VaultMutationScope } from "../vault/mutation-scope";
import { requireCanonFiles, snapshotCanonIo, withCanonMutationAsync } from "./io";
import { getCanonReceipt } from "./receipts";
import { assertPageRelPath } from "./paths";
import type { CanonReceipt, RetrievalOpRef } from "./receipts";
import { pageIndexByPath, type CanonIo } from "./store";
import { advanceCanonReadGeneration, canonReadGeneration, decodeCanonImage, recoveryFailure, validateCanonIntentReceipt, type CanonWriteIntent } from "./write-intent";

export interface CanonProjectionObligation {
  version: 1;
  receipt: CanonReceipt;
  page_id: string | null;
  after_base64: string | null;
  source_epoch: number;
  sources: { source_key: string; event_id: string }[];
  derive_ids: string[];
  external_ops: RetrievalOpRef[];
  external_execution: ("scheduled" | "started" | "acknowledged")[];
}
interface StoredObligation { receipt_id: string; page_path: string; obligation: string; digest: string }

function externalOperations(receipt: CanonReceipt): RetrievalOpRef[] {
  if (receipt.kind !== "purge_rewrite") return receipt.retrieval_ops;
  // The purge coordinator has its own durable store closure and absence proof
  // before rewriting canon. Its rewrite receipt names the local lexical floor;
  // it must not schedule a second external deletion after that floor is rebuilt.
  if (receipt.retrieval_ops.some(op => op.store !== FTS5_RETRIEVAL_ID || op.op !== "remove")) recoveryFailure("intent_invalid", receipt.receipt_id);
  return [];
}

function insert(db: Database, row: StoredObligation, sources: CanonProjectionObligation["sources"]): void {
  db.query("INSERT INTO canon_projection_obligations VALUES (?,?,?,?)").run(row.receipt_id, row.page_path, row.obligation, row.digest);
  for (const source of sources) db.query("INSERT INTO canon_projection_sources VALUES (?,?,?)").run(row.receipt_id, source.source_key, source.event_id);
}
export function enqueueCanonProjection(db: Database, intent: CanonWriteIntent): void {
  if (!db.inTransaction) recoveryFailure("nested_transaction");
  const obligation: CanonProjectionObligation = {
    version: 1, receipt: intent.receipt, page_id: intent.completion.page_id, after_base64: intent.after_base64,
    source_epoch: intent.admission.source_epoch, sources: intent.admission.sources, derive_ids: intent.admission.derive_ids,
    external_ops: externalOperations(intent.receipt),
    external_execution: externalOperations(intent.receipt).map(() => "scheduled"),
  };
  const json = JSON.stringify(obligation);
  if (Buffer.byteLength(json) > MAX_CANON_INTENT_BYTES) recoveryFailure("intent_invalid");
  insert(db, { receipt_id: intent.receipt.receipt_id, page_path: intent.receipt.page_path, obligation: json, digest: sha256Hex(json) }, obligation.sources);
}
export function readCanonProjectionObligation(db: Database, receiptId: string): { row: StoredObligation; value: CanonProjectionObligation } | null {
  const raw = db.query<{ receipt_id: string; page_path: string; obligation: Uint8Array | null; digest: string }, [string]>(`SELECT receipt_id,page_path,CASE WHEN length(CAST(obligation AS BLOB))<=${MAX_CANON_INTENT_BYTES} THEN CAST(obligation AS BLOB) ELSE NULL END AS obligation,digest FROM canon_projection_obligations WHERE receipt_id=?`).get(receiptId);
  if (raw === null) return null;
  if (raw.obligation === null) recoveryFailure("intent_invalid", receiptId);
  let json: string, parsed: unknown;
  try { json = new TextDecoder("utf-8", { fatal: true }).decode(raw.obligation); parsed = JSON.parse(json); }
  catch { recoveryFailure("intent_invalid", receiptId); }
  if (sha256Hex(json) !== raw.digest || !isPlainObject(parsed) ||
      Object.keys(parsed).sort().join(",") !== "after_base64,derive_ids,external_execution,external_ops,page_id,receipt,source_epoch,sources,version" || parsed.version !== 1) recoveryFailure("intent_invalid", receiptId);
  const value = parsed as unknown as CanonProjectionObligation;
  validateCanonIntentReceipt(value.receipt);
  const receipt = value.receipt;
  if (receipt.receipt_id !== receiptId || receipt.page_path !== raw.page_path ||
      (value.page_id !== null && (typeof value.page_id !== "string" || !value.page_id.length || value.page_id.length > 1024)) ||
      !Number.isSafeInteger(value.source_epoch) || value.source_epoch < 0 ||
      !Array.isArray(value.derive_ids) || value.derive_ids.length > MAX_CANON_IDENTITY_BINDINGS || value.derive_ids.some(id => typeof id !== "string" || !id.length || Buffer.byteLength(id) > 1024 || id.includes("\0")) || new Set(value.derive_ids).size !== value.derive_ids.length ||
      !Array.isArray(value.sources) || value.sources.length > MAX_CANON_IDENTITY_BINDINGS || value.sources.some(source => !isPlainObject(source) || Object.keys(source).sort().join(",") !== "event_id,source_key" || typeof source.event_id !== "string" || typeof source.source_key !== "string" || !source.event_id.length || Buffer.byteLength(source.event_id) > 1024 || Buffer.byteLength(source.source_key) > 1024 || source.event_id.includes("\0") || source.source_key.includes("\0")) || new Set(value.sources.map(source => source.event_id)).size !== value.sources.length ||
      JSON.stringify(value.external_ops) !== JSON.stringify(externalOperations(receipt)) ||
      !Array.isArray(value.external_execution) || value.external_execution.length !== value.external_ops.length ||
      value.external_execution.some(state => state !== "scheduled" && state !== "started" && state !== "acknowledged")) recoveryFailure("intent_invalid", receiptId);
  const bytes = decodeCanonImage(value.after_base64);
  if ((bytes === null ? ABSENT_PAGE_HASH : hashBytes(bytes)) !== receipt.after_hash) recoveryFailure("intent_invalid", receiptId);
  const page = bytes === null ? null : parseFrontmatter(bytes.toString("utf8"));
  if (page !== null && (validatePage(page.data).length > 0 || page.data["id"] !== value.page_id)) recoveryFailure("intent_invalid", receiptId);
  const pageSources = page === null ? [] : page.data["sources"] as string[];
  const expectedDerive = [...new Set((receipt.kind === "purge_rewrite" ? pageSources : [...receipt.provenance, ...pageSources]).map(eventIdFromReference))].sort();
  const sourceEvents = new Set(value.sources.map(source => source.event_id));
  if (JSON.stringify(expectedDerive) !== JSON.stringify(value.derive_ids) ||
      [...receipt.provenance, ...pageSources].some(id => !sourceEvents.has(eventIdFromReference(id)))) recoveryFailure("intent_invalid", receiptId);
  const associations = db.query<{ source_key: string; event_id: string }, [string]>(`SELECT source_key,event_id FROM canon_projection_sources WHERE receipt_id=? ORDER BY event_id LIMIT ${MAX_CANON_IDENTITY_BINDINGS + 1}`).all(receiptId);
  if (JSON.stringify(associations.map(row => [row.event_id, row.source_key])) !== JSON.stringify(value.sources.map(row => [row.event_id, row.source_key]))) recoveryFailure("intent_invalid", receiptId);
  return { row: { receipt_id: raw.receipt_id, page_path: raw.page_path, obligation: json, digest: raw.digest }, value };
}
function verify(scope: VaultMutationScope, io: CanonIo, obligation: CanonProjectionObligation): CanonPage | null {
  const receipt = obligation.receipt;
  const index = pageIndexByPath(io.db, receipt.page_path);
  const indexed = obligation.after_base64 === null ? index === null :
    index?.last_receipt === receipt.receipt_id && index.last_hash === receipt.after_hash && index.page_id === obligation.page_id;
  if (!indexed || sourcePolicyEpoch(io.db) !== obligation.source_epoch ||
      JSON.stringify(getCanonReceipt(io.db, receipt.receipt_id)) !== JSON.stringify(receipt)) recoveryFailure("authority_changed", receipt.receipt_id);
  requireSourceEvents(io.db, obligation.derive_ids, { owner: true, purpose: "derive" });
  const expected = decodeCanonImage(obligation.after_base64);
  const snapshot = requireCanonFiles(scope, io).read(receipt.page_path);
  if (snapshot === null) { if (expected !== null) recoveryFailure("page_changed", receipt.receipt_id); return null; }
  let bytes: Buffer; try { bytes = Buffer.from(snapshot.bytes); } finally { snapshot.close(); }
  if (expected === null || !bytes.equals(expected)) recoveryFailure("page_changed", receipt.receipt_id);
  const page = parseFrontmatter(bytes.toString("utf8"));
  if (typeof page.data["id"] !== "string" || page.data["id"] !== obligation.page_id) recoveryFailure("page_changed", receipt.receipt_id);
  return { id: page.data["id"], path: join(io.vault_path, receipt.page_path), relPath: receipt.page_path,
    data: page.data, body: page.body, contentHash: hashBytes(bytes) };
}

/** No callback or await: other SQLite readers retain the hold until commit. */
export function refreshCanonProjectionFloor(scope: VaultMutationScope, io: CanonIo, receiptId: string): void {
  requireCanonFiles(scope, io);
  if (io.db.inTransaction) recoveryFailure("nested_transaction");
  io.db.transaction(() => {
    const saved = readCanonProjectionObligation(io.db, receiptId); if (saved === null) return;
    const page = verify(scope, io, saved.value);
    io.db.query("DELETE FROM canon_projection_obligations WHERE receipt_id=?").run(receiptId);
    if (page === null || page.data["status"] !== "active") {
      if (saved.value.page_id !== null) removeDerivedPage(io.db, saved.value.page_id, io.vault_path);
    } else refreshDerivedPage(io.db, page, io.vault_path);
    if (saved.value.external_execution.some(state => state !== "acknowledged")) insert(io.db, saved.row, saved.value.sources);
    else advanceCanonReadGeneration(io.db);
  }).immediate();
}

function transitionExecution(scope: VaultMutationScope, io: CanonIo, receiptId: string, expectedDigest: string, index: number,
  expected: "scheduled" | "started", next: "started" | "acknowledged") {
  return io.db.transaction(() => {
    const saved = readCanonProjectionObligation(io.db, receiptId);
    if (saved === null || saved.row.digest !== expectedDigest || saved.value.external_execution[index] !== expected) recoveryFailure("projection_pending", receiptId);
    verify(scope, io, saved.value);
    saved.value.external_execution[index] = next;
    const json = JSON.stringify(saved.value), digest = sha256Hex(json);
    const changed = io.db.query("UPDATE canon_projection_obligations SET obligation=?,digest=? WHERE receipt_id=? AND digest=?").run(json, digest, receiptId, expectedDigest);
    if (changed.changes !== 1) recoveryFailure("projection_pending", receiptId);
    return { row: { ...saved.row, obligation: json, digest }, value: saved.value };
  }).immediate();
}

export async function retryCanonProjectionObligationsOwned(scope: VaultMutationScope, io: CanonIo, options: { page_path?: string } = {}): Promise<{ completed: string[]; pending: number }> {
  requireCanonFiles(scope, io);
  if (io.db.inTransaction) recoveryFailure("nested_transaction");
  const pagePath = options.page_path ?? null;
  if (pagePath !== null) assertPageRelPath(pagePath);
  const ids = io.db.query<{ receipt_id: string }, [string | null, string | null]>("SELECT receipt_id FROM canon_projection_obligations WHERE (? IS NULL OR page_path=?) ORDER BY receipt_id LIMIT 101").all(pagePath, pagePath);
  if (ids.length > 100) recoveryFailure("projection_pending");
  const completed: string[] = [];
  for (const { receipt_id } of ids) {
    let saved = readCanonProjectionObligation(io.db, receipt_id); if (saved === null) continue;
    const page = verify(scope, io, saved.value);
    const ops = saved.value.external_ops;
    if (saved.value.external_execution.every(state => state === "acknowledged")) { refreshCanonProjectionFloor(scope, io, receipt_id); completed.push(receipt_id); continue; }
    // A lost response or dead process cannot prove an earlier remote write has
    // stopped. Repeating it and undoing later could resurrect old bytes.
    if (saved.value.external_execution.includes("started")) recoveryFailure("projection_pending", receipt_id);
    const port = io.retrieval;
    if (port === undefined || ops.some(op => op.store !== port.descriptor.id)) continue;
    const store = port.descriptor.id;
    const remove = port.remove.bind(port), upsert = port.upsert.bind(port), absent = port.verifyAbsent.bind(port);
    const generation = canonReadGeneration(io.db);
    requireSourceEvents(io.db, saved.value.derive_ids, { owner: true, purpose: "derive", port });
    for (const [index, op] of ops.entries()) {
      if (saved.value.external_execution[index] === "acknowledged") continue;
      saved = transitionExecution(scope, io, receipt_id, saved.row.digest, index, "scheduled", "started");
      if (op.op === "remove") {
        const report = await remove([op.doc]);
        if (!Number.isSafeInteger(report.processed) || report.processed < 1) recoveryFailure("projection_pending", receipt_id);
        const proof = validateAbsenceProof(await absent([op.doc]));
        if (proof.store !== store || proof.checked !== 1 || proof.found.length !== 0) recoveryFailure("projection_pending", receipt_id);
      } else {
        if (page === null || op.doc !== `page:${page.id}` || page.data["status"] !== "active") recoveryFailure("projection_pending", receipt_id);
        const subject = page.data["x-subject-id"];
        const document = validateRetrievalDoc({ doc_id: op.doc, kind: "page", title: typeof page.data["title"] === "string" ? page.data["title"] : page.id,
          text: page.body, sensitivity: saved.value.receipt.sensitivity, taint: saved.value.receipt.taint,
          authority: saved.value.receipt.authority, subjects: typeof subject === "string" ? [subject] : [],
          provenance: saved.value.derive_ids, occurred_at: null, updated_at: saved.value.receipt.at });
        recordSourceStoreWrite(io.db, port, document.provenance);
        const report = await upsert([document]);
        if (!Number.isSafeInteger(report.processed) || report.processed !== 1) recoveryFailure("projection_pending", receipt_id);
      }
      try {
        verify(scope, io, saved.value);
        requireSourceEvents(io.db, saved.value.derive_ids, { owner: true, purpose: "derive", port });
        if (port.descriptor.id !== store || canonReadGeneration(io.db) !== generation) recoveryFailure("authority_changed", receipt_id);
      } catch (error) {
        if (op.op === "upsert") { await remove([op.doc]); const proof = validateAbsenceProof(await absent([op.doc])); if (proof.store !== store || proof.checked !== 1 || proof.found.length !== 0) recoveryFailure("projection_pending", receipt_id); }
        throw error;
      }
      saved = transitionExecution(scope, io, receipt_id, saved.row.digest, index, "started", "acknowledged");
    }
    refreshCanonProjectionFloor(scope, io, receipt_id);
    completed.push(receipt_id);
  }
  const pending = io.db.query<{ n: number }, []>("SELECT count(*) AS n FROM canon_projection_obligations").get()!.n;
  return { completed, pending };
}
export async function retryCanonProjectionObligations(input: CanonIo): Promise<{ completed: string[]; pending: number }> {
  const io = snapshotCanonIo(input);
  return withCanonMutationAsync(io, (scope, owned) => retryCanonProjectionObligationsOwned(scope, owned));
}
