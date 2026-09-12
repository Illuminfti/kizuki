import { requireSourceEvents } from "../ledger/source-grants";
import { stringArray } from "../vault/pages";
import { CanonAuthorityResolver } from "./authority";
import { existsSync, readFileSync } from "node:fs";
import { parseFrontmatter, serializePage } from "../vault/frontmatter";
import type { VaultPage } from "../vault/frontmatter";
import { ABSENT_PAGE_HASH, archiveRelPath, containedVaultFile, hashBytes, hashFile } from "../vault/write";
import { commitCanonWrite, recoverCanonWritesOwned } from "./recovery";
import { readCanonWriteIntent, recoveryFailure } from "./write-intent";
import { retryCanonProjectionObligationsOwned } from "./projection-obligations";
import { assertArchiveRelPath, assertPageRelPath, assertReceiptPaths } from "./paths";
import { canonFilesFor, requireCanonFiles, snapshotCanonIo, withCanonMutationAsync } from "./io";
import { VaultMutationError, type VaultMutationScope } from "../vault/mutation-scope";
import { UndoError } from "./errors";
import {
  getCanonReceipt,
  laterReceiptsForPage,
} from "./receipts";
import type { CanonReceipt, RetrievalOpRef } from "./receipts";
import {
  mintId,
  nowOf,
  pageIndexByPath,
} from "./store";
import type { CanonIo } from "./store";

export type UndoReceiptResult = CanonReceipt & { projection_pending?: true };

export interface UndoReceiptOptions {
  cascade?: boolean;
}

function currentHash(io: CanonIo, relPath: string): string {
  assertPageRelPath(relPath);
  const files = canonFilesFor(io);
  if (files !== undefined) {
    const snapshot = files.read(relPath);
    if (snapshot === null) return ABSENT_PAGE_HASH;
    try { return hashBytes(snapshot.bytes); }
    finally { snapshot.close(); }
  }
  const path = containedVaultFile(io.vault_path, relPath);
  if (!existsSync(path)) return ABSENT_PAGE_HASH;
  return hashFile(path);
}

function laterIds(io: CanonIo, receipt: CanonReceipt): string[] {
  return laterReceiptsForPage(io.db, receipt.page_path, {
    at: receipt.at,
    receipt_id: receipt.receipt_id,
  }).map((row) => row.receipt_id);
}

function loadArchivePage(io: CanonIo, archivePath: string): VaultPage {
  assertArchiveRelPath(archivePath);
  const snapshot = canonFilesFor(io)?.read(archivePath);
  if (snapshot === undefined || snapshot === null) {
    throw new UndoError("archive_missing", `undo: no archive copy exists at ${archivePath}`);
  }
  let page: VaultPage;
  try { page = parseFrontmatter(Buffer.from(snapshot.bytes).toString("utf8")); }
  finally { snapshot.close(); }
  requireSourceEvents(io.db, stringArray(page.data["sources"]), { owner: true, purpose: "derive" });
  return page;
}

function pageIdOf(page: VaultPage | null, fallback: string | null): string | null {
  const raw = page?.data["id"];
  if (typeof raw === "string" && raw.length > 0) return raw;
  return fallback;
}

function subjectOf(page: VaultPage | null): string | null {
  const raw = page?.data["x-subject-id"];
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

const reversing = new Set<string>();

/**
 * RFC 0002 §7.2. Restores bytes from the receipt's archive; does not re-run
 * a producer. The revert is itself a receipted write.
 */
export async function undoReceipt(
  io: CanonIo,
  receiptId: string,
  opts: UndoReceiptOptions = {},
): Promise<UndoReceiptResult> {
  io = snapshotCanonIo(io);
  opts = Object.freeze({ ...(opts.cascade === undefined ? {} : { cascade: opts.cascade }) });
  try {
    return await withCanonMutationAsync(io, (scope, owned) => undoReceiptOwned(scope, owned, receiptId, opts));
  } catch (error) {
    if (error instanceof VaultMutationError && error.code === "writer_busy") {
      throw new UndoError("writer_busy", "canon writer is busy; retry undo");
    }
    throw error;
  }
}

/** Internal nested entry: the enclosing operation owns files through receipt completion. */
export async function undoReceiptOwned(
  scope: VaultMutationScope,
  io: CanonIo,
  receiptId: string,
  opts: UndoReceiptOptions = {},
): Promise<UndoReceiptResult> {
  requireCanonFiles(scope, io);
  if (io.db.inTransaction) recoveryFailure("nested_transaction");
  const pending = readCanonWriteIntent(io.db);
  if (pending !== null) {
    if (pending.receipt.kind !== "revert" || pending.receipt.reverts !== receiptId) recoveryFailure("recovery_pending", pending.receipt.receipt_id);
    recoverCanonWritesOwned(scope, io);
    if (readCanonWriteIntent(io.db) !== null) recoveryFailure("authority_changed", pending.receipt.receipt_id);
    return finishUndoProjection(scope, io, pending.receipt);
  }
  const original = getCanonReceipt(io.db, receiptId);
  if (original === null) {
    throw new UndoError("receipt_unknown", `undo: receipt ${receiptId} is unknown`);
  }
  assertReceiptPaths(original);
  assertPageRelPath(original.page_path);
  // Settle an older acknowledged/scheduled projection before admitting a successor.
  // An unavailable or unknown prior operation retains its hold and blocks undo.
  await retryCanonProjectionObligationsOwned(scope, io, { page_path: original.page_path });
  if (io.db.query("SELECT 1 FROM canon_projection_obligations WHERE page_path=? LIMIT 1").get(original.page_path) !== null) recoveryFailure("projection_pending", original.receipt_id);
  requireSourceEvents(io.db, original.provenance, { owner: true, purpose: "derive", ...(io.retrieval === undefined ? {} : { port: io.retrieval }) });
  if (original.reverted_by !== null) {
    throw new UndoError(
      "already_reverted",
      `undo: already reverted by ${original.reverted_by}`,
    );
  }

  const current = currentHash(io, original.page_path);
  const later = laterIds(io, original);
  if (current !== original.after_hash) {
    if (opts.cascade === true && later.length > 0) {
      for (const id of later) {
        await undoReceiptOwned(scope, io, id, { cascade: false });
      }
      return undoReceiptOwned(scope, io, receiptId, { cascade: false });
    }
    throw new UndoError(
      "page_changed",
      `undo: page changed since receipt ${receiptId}; later receipts: ${later.join(", ")}`,
    );
  }

  if (reversing.has(receiptId)) {
    throw new UndoError("already_reverted", `undo: already reverting ${receiptId}`);
  }
  reversing.add(receiptId);
  try {
    return await applyUndo(scope, io, original, current);
  } finally {
    reversing.delete(receiptId);
  }
}

async function finishUndoProjection(scope: VaultMutationScope, io: CanonIo, receipt: CanonReceipt): Promise<UndoReceiptResult> {
  try { await retryCanonProjectionObligationsOwned(scope, io, { page_path: receipt.page_path }); }
  catch {
    // Canon is durably committed. An unavailable/failed external operation is
    // an explicit durable pending result, never an unreceipted byte rollback.
    return { ...receipt, projection_pending: true };
  }
  return io.db.query("SELECT 1 FROM canon_projection_obligations WHERE receipt_id=?").get(receipt.receipt_id) === null
    ? receipt : { ...receipt, projection_pending: true };
}

async function applyUndo(scope: VaultMutationScope, io: CanonIo, original: CanonReceipt, current: string): Promise<UndoReceiptResult> {
  const revertId = mintId(io), at = nowOf(io);
  const authority = new CanonAuthorityResolver(io.db, [original.page_path]).before(original.receipt_id);
  const deleting = original.page_action === "create" && original.kind !== "revert";
  if (!deleting && original.archive_path === null) throw new UndoError("not_undoable", "undo: no archive copy exists; this write is not undoable");
  const page = deleting ? null : loadArchivePage(io, original.archive_path!);
  const files = requireCanonFiles(scope, io), snapshot = files.read(original.page_path);
  let before: Buffer | null = null;
  if (snapshot !== null) { try { before = Buffer.from(snapshot.bytes); } finally { snapshot.close(); } }
  if ((before === null ? ABSENT_PAGE_HASH : hashBytes(before)) !== current) recoveryFailure("page_changed");
  const after = page === null ? null : Buffer.from(serializePage(page));
  if ((after === null ? ABSENT_PAGE_HASH : hashBytes(after)) !== (original.before_hash ?? ABSENT_PAGE_HASH)) throw new UndoError("archive_missing", "undo: archive bytes no longer match the original receipt");
  const fallback = pageIndexByPath(io.db, original.page_path)?.page_id ?? null;
  const pageId = pageIdOf(page, fallback);
  const ops: RetrievalOpRef[] = original.retrieval_ops.map(op => ({ store: op.store, op: page === null ? "remove" : "upsert", doc: op.doc }));
  const revert: CanonReceipt = {
    receipt_id: revertId, kind: "revert", claim_ids: [...original.claim_ids], page_path: original.page_path,
    page_action: page === null ? "archive" : before === null ? "create" : "edit",
    before_hash: original.after_hash, after_hash: after === null ? ABSENT_PAGE_HASH : hashBytes(after),
    archive_path: before === null ? null : archiveRelPath(original.page_path, revertId), writer: "revert",
    producer: original.producer, model_ref: original.model_ref, authority, confidence: original.confidence,
    sensitivity: original.sensitivity, taint: original.taint, provenance: [...original.provenance],
    superseded: [...original.superseded], candidates: [], retrieval_ops: ops,
    reverts: original.receipt_id, reverted_by: null, at,
  };
  commitCanonWrite(scope, io, { receipt: revert, before, after,
    completion: { mode: "revert", claim_kind: "revert", page_id: pageId, subject_key: subjectOf(page), original_receipt_id: original.receipt_id },
  }, () => requireSourceEvents(io.db, page === null ? original.provenance : stringArray(page.data["sources"]), { owner: true, purpose: "derive" }));
  return finishUndoProjection(scope, io, revert);
}

/** sha256 of bytes currently on disk, or the absent-page hash when gone. */
export function pageHashOrAbsent(path: string): string {
  if (!existsSync(path)) return ABSENT_PAGE_HASH;
  return hashBytes(readFileSync(path));
}
