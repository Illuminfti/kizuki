import { CanonAuthorityResolver } from "./authority";
import { refreshDerivedPage } from "../derived";
import { listCanonPagesReport } from "../vault/pages";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import type { Sensitivity } from "../agents/types";
import {
  getClaim,
  markClaimReverted,
  reinstateClaim,
  resupersedeClaim,
  supersessionsForReceipt,
} from "../claims/store";
import type { RetrievalDoc } from "../contracts/retrieval";
import type { AuthorityTier, ClaimTaint } from "../contracts/proposal";
import { parseFrontmatter } from "../vault/frontmatter";
import type { VaultPage } from "../vault/frontmatter";
import { PAGE_SENSITIVITIES } from "../vault/schema";
import { ABSENT_PAGE_HASH, hashBytes, hashFile } from "../vault/write";
import { applyRevertWrite } from "./apply";
import { UndoError } from "./errors";
import {
  getCanonReceipt,
  laterReceiptsForPage,
} from "./receipts";
import type { CanonReceipt, PageAction, RetrievalOpRef } from "./receipts";
import {
  appendReceiptLine,
  deletePageIndex,
  insertReceiptRow,
  markReceiptReverted,
  mintId,
  nowOf,
  pageIndexByPath,
  upsertPageIndex,
} from "./store";
import type { CanonIo } from "./store";

export interface UndoReceiptOptions {
  cascade?: boolean;
}

function currentHash(io: CanonIo, relPath: string): string {
  const path = join(io.vault_path, relPath);
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
  const path = join(io.vault_path, archivePath);
  if (!existsSync(path)) {
    throw new UndoError("archive_missing", `undo: no archive copy exists at ${archivePath}`);
  }
  return parseFrontmatter(readFileSync(path, "utf8"));
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

function isSensitivity(value: unknown): value is Sensitivity {
  return typeof value === "string" && (PAGE_SENSITIVITIES as readonly string[]).includes(value);
}

function taintOf(page: VaultPage, fallback: ClaimTaint): ClaimTaint {
  return page.data["taint"] === "quoted" ? "quoted" : page.data["taint"] === "clean" ? "clean" : fallback;
}

function provenanceOf(page: VaultPage, fallback: readonly string[]): string[] {
  const sources = page.data["sources"];
  if (Array.isArray(sources) && sources.every((item) => typeof item === "string")) {
    return sources;
  }
  return [...fallback];
}

function pageDoc(
  pageId: string,
  page: VaultPage,
  meta: CanonReceipt,
  authority: AuthorityTier,
  at: string,
): RetrievalDoc {
  const title = page.data["title"];
  const subject = subjectOf(page);
  return {
    doc_id: `page:${pageId}`,
    kind: "page",
    title: typeof title === "string" ? title : meta.page_path,
    text: page.body,
    sensitivity: isSensitivity(page.data["sensitivity"]) ? page.data["sensitivity"] : meta.sensitivity,
    taint: taintOf(page, meta.taint),
    authority,
    subjects: subject === null ? [] : [subject],
    provenance: provenanceOf(page, meta.provenance),
    occurred_at: null,
    updated_at: at,
  };
}

function recoverArchiveForHash(io: CanonIo, relPath: string, wantHash: string): string | null {
  const dir = join(io.vault_path, "archive");
  if (!existsSync(dir)) return null;
  const stem = basename(relPath, extname(relPath));
  const prefix = `${stem}.prev-`;
  let found: string | null = null;
  for (const name of readdirSync(dir)) {
    if (!name.startsWith(prefix) || !name.endsWith(".md")) continue;
    const rel = `archive/${name}`;
    if (hashFile(join(io.vault_path, rel)) !== wantHash) continue;
    if (found === null || name > basename(found)) found = rel;
  }
  return found;
}

async function reverseRetrieval(
  io: CanonIo,
  original: CanonReceipt,
  restored: VaultPage | null,
  authority: AuthorityTier,
  at: string,
): Promise<RetrievalOpRef[]> {
  const port = io.retrieval;
  if (port === undefined || original.retrieval_ops.length === 0) return [];

  const docs = original.retrieval_ops.map((op) => op.doc);
  if (restored === null) {
    await port.remove(docs);
    const proof = await port.verifyAbsent(docs);
    if (proof.found.length > 0) {
      throw new UndoError(
        "not_undoable",
        `undo: retrieval still holds ${proof.found.length} document(s)`,
      );
    }
    return docs.map((doc) => ({ store: port.descriptor.id, op: "remove" as const, doc }));
  }

  const pageId = pageIdOf(restored, pageIndexByPath(io.db, original.page_path)?.page_id ?? null);
  if (pageId === null) return [];
  await port.upsert([pageDoc(pageId, restored, original, authority, at)]);
  return docs.map((doc) => ({ store: port.descriptor.id, op: "upsert" as const, doc }));
}

function earlierTimestamp(left: string | null, right: string | null): string | null {
  if (left === null || left === "") return right;
  if (right === null || right === "") return left;
  return left < right ? left : right;
}

function restoreClaims(io: CanonIo, original: CanonReceipt, at: string): void {
  if (original.kind === "revert") {
    for (const claimId of original.claim_ids) {
      const claim = getClaim(io.db, claimId);
      if (claim === null) continue;
      reinstateClaim(io.db, claim.claim_id, claim.valid_to);
    }
    const winnerId = original.claim_ids[0];
    const writeId = original.reverts;
    const rows = writeId === null ? [] : supersessionsForReceipt(io.db, writeId);
    const priorByLoser = new Map(rows.map((row) => [row.loser, row.prior_valid_to]));
    const winner = winnerId === undefined ? null : getClaim(io.db, winnerId);
    for (const ref of original.superseded) {
      if (winnerId === undefined) break;
      resupersedeClaim(
        io.db,
        ref.claim_id,
        winnerId,
        at,
        earlierTimestamp(priorByLoser.get(ref.claim_id) ?? null, winner?.valid_from ?? null),
      );
    }
    return;
  }

  for (const claimId of original.claim_ids) {
    markClaimReverted(io.db, claimId, at);
  }
  const rows = supersessionsForReceipt(io.db, original.receipt_id);
  const priorByLoser = new Map(rows.map((row) => [row.loser, row.prior_valid_to]));
  for (const ref of original.superseded) {
    reinstateClaim(io.db, ref.claim_id, priorByLoser.get(ref.claim_id) ?? null);
  }
}

function restoreBytes(
  io: CanonIo,
  original: CanonReceipt,
  revertId: string,
  current: string,
): { outcome: { archive_path: string | null; after_hash: string }; page: VaultPage | null; action: PageAction } {
  const undoTarget = original.before_hash ?? ABSENT_PAGE_HASH;
  if (current === undoTarget && current !== original.after_hash) {
    const archive = recoverArchiveForHash(io, original.page_path, original.after_hash);
    if (original.page_action === "create" && original.kind !== "revert") {
      return {
        outcome: { archive_path: archive, after_hash: ABSENT_PAGE_HASH },
        page: null,
        action: "archive",
      };
    }
    if (original.archive_path === null) {
      throw new UndoError(
        "not_undoable",
        `undo: no archive copy exists; this write is not undoable`,
      );
    }
    return {
      outcome: { archive_path: archive, after_hash: current },
      page: loadArchivePage(io, original.archive_path),
      action: original.after_hash === ABSENT_PAGE_HASH ? "create" : "edit",
    };
  }

  if (original.page_action === "create" && original.kind !== "revert") {
    const outcome = applyRevertWrite(io, {
      receipt_id: revertId,
      rel_path: original.page_path,
      expected_hash: current,
      page: null,
    });
    return { outcome, page: null, action: "archive" };
  }

  if (original.archive_path === null) {
    throw new UndoError(
      "not_undoable",
      `undo: no archive copy exists; this write is not undoable`,
    );
  }
  const page = loadArchivePage(io, original.archive_path);
  const expected = current === ABSENT_PAGE_HASH ? null : current;
  const outcome = applyRevertWrite(io, {
    receipt_id: revertId,
    rel_path: original.page_path,
    expected_hash: expected,
    page,
  });
  const action: PageAction = expected === null ? "create" : "edit";
  return { outcome, page, action };
}

function updateIndex(
  io: CanonIo,
  original: CanonReceipt,
  revert: CanonReceipt,
  page: VaultPage | null,
): void {
  if (page === null) {
    deletePageIndex(io.db, original.page_path);
    return;
  }
  const existing = pageIndexByPath(io.db, original.page_path);
  const pageId = pageIdOf(page, existing?.page_id ?? null);
  if (pageId === null) return;
  upsertPageIndex(io.db, {
    page_id: pageId,
    rel_path: original.page_path,
    subject_key: subjectOf(page),
    last_receipt: revert.receipt_id,
    last_hash: revert.after_hash,
  });
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
): Promise<CanonReceipt> {
  const original = getCanonReceipt(io.db, receiptId);
  if (original === null) {
    throw new UndoError("receipt_unknown", `undo: receipt ${receiptId} is unknown`);
  }
  if (original.reverted_by !== null) {
    throw new UndoError(
      "already_reverted",
      `undo: already reverted by ${original.reverted_by}`,
    );
  }

  const current = currentHash(io, original.page_path);
  const later = laterIds(io, original);
  const undoTarget = original.before_hash ?? ABSENT_PAGE_HASH;
  if (current !== original.after_hash) {
    if (opts.cascade === true && later.length > 0) {
      for (const id of later) {
        await undoReceipt(io, id, { cascade: false });
      }
      return undoReceipt(io, receiptId, { cascade: false });
    }
    if (current !== undoTarget) {
      throw new UndoError(
        "page_changed",
        `undo: page changed since receipt ${receiptId}; later receipts: ${later.join(", ")}`,
      );
    }
  }

  if (reversing.has(receiptId)) {
    throw new UndoError("already_reverted", `undo: already reverting ${receiptId}`);
  }
  reversing.add(receiptId);
  try {
    return await applyUndo(io, original, current);
  } finally {
    reversing.delete(receiptId);
  }
}

async function applyUndo(
  io: CanonIo,
  original: CanonReceipt,
  current: string,
): Promise<CanonReceipt> {
  const revertId = mintId(io);
  const at = nowOf(io);
  const authority = new CanonAuthorityResolver(io.db, [original.page_path]).before(original.receipt_id);
  const restored = restoreBytes(io, original, revertId, current);
  restoreClaims(io, original, at);
  const retrievalOps = await reverseRetrieval(io, original, restored.page, authority, at);

  const revert: CanonReceipt = {
    receipt_id: revertId,
    kind: "revert",
    claim_ids: [...original.claim_ids],
    page_path: original.page_path,
    page_action: restored.action,
    before_hash: original.after_hash,
    after_hash: restored.outcome.after_hash,
    archive_path: restored.outcome.archive_path,
    writer: "revert",
    producer: original.producer,
    model_ref: original.model_ref,
    authority,
    confidence: original.confidence,
    sensitivity: original.sensitivity,
    taint: original.taint,
    provenance: [...original.provenance],
    superseded: [...original.superseded],
    candidates: [],
    retrieval_ops: retrievalOps,
    reverts: original.receipt_id,
    reverted_by: null,
    at,
  };

  appendReceiptLine(io, revert);
  io.db.transaction((): void => {
    insertReceiptRow(io.db, revert, "revert");
    markReceiptReverted(io.db, original.receipt_id, revert.receipt_id);
    updateIndex(io, original, revert, restored.page);
  })();

  if (restored.page !== null) {
    const page = listCanonPagesReport(io.vault_path).pages.find(item => item.relPath === original.page_path);
    if (page !== undefined) refreshDerivedPage(io.db, page, io.vault_path);
  }
  return revert;
}

/** sha256 of bytes currently on disk, or the absent-page hash when gone. */
export function pageHashOrAbsent(path: string): string {
  if (!existsSync(path)) return ABSENT_PAGE_HASH;
  return hashBytes(readFileSync(path));
}
