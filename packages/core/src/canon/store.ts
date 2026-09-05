import type { Database } from "bun:sqlite";
import {
  appendFileSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tableExists } from "../ledger/schema";
import { ulid } from "../util/ulid";
import { parseFrontmatter } from "../vault/frontmatter";
import type { VaultPage } from "../vault/frontmatter";
import { listCanonPagesReport } from "../vault/pages";
import type { RetrievalPort } from "../contracts/retrieval";
import { hashBytes } from "../vault/write";
import { RECEIPTS_PATH, latestReceiptForPage } from "./receipts";
import type { CanonReceipt } from "./receipts";
import { initCanon } from "./schema";

/**
 * The canon store as the writer sees it: the SQLite ledger that holds
 * receipts and the page index, and the Markdown vault on disk. Only modules
 * under `canon/` import this adapter; everything else uses `applyCanonWrite`
 * and the read helpers exported from `canon/index.ts`.
 */
export interface CanonIo {
  readonly db: Database;
  readonly vault_path: string;
  /** RFC3339 clock, injectable so receipts are byte-reproducible in tests. */
  readonly now?: () => string;
  /** ULID mint, injectable for the same reason. */
  readonly ids?: () => string;
  /**
   * Id of the retrieval port the loop refreshes after a write. When set, the
   * receipt names the upsert the refresh stage will perform (§4.6).
   */
  readonly retrieval_store?: string;
  /**
   * Bound retrieval port used to reverse `retrieval_ops` on undo. Optional:
   * a vault with no retrieval still undoes bytes and claims.
   */
  readonly retrieval?: RetrievalPort;
}

export function nowOf(io: CanonIo): string {
  return io.now?.() ?? new Date().toISOString();
}

export function mintId(io: CanonIo): string {
  return io.ids?.() ?? ulid();
}

export interface ExistingPage {
  path: string;
  relPath: string;
  content: string;
  hash: string;
  page: VaultPage;
}

/** Reconstructed from PR427: only an actual ENOENT means the page is absent. */
export class CanonPageUnreadable extends Error {
  override readonly name = "CanonPageUnreadable";
  constructor(readonly relPath: string, readonly code: string) {
    super("canon page is unreadable");
  }
}
export function readPage(io: CanonIo, relPath: string): ExistingPage | null {
  const path = join(io.vault_path, relPath);
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    throw new CanonPageUnreadable(
      relPath, typeof code === "string" && /^[A-Z][A-Z0-9_]+$/.test(code) ? code : "EIO",
    );
  }
  const content = bytes.toString("utf8");
  return {
    path,
    relPath,
    content,
    hash: hashBytes(bytes),
    page: parseFrontmatter(content),
  };
}

export function appendReceiptLine(io: CanonIo, receipt: CanonReceipt): void {
  const receiptsPath = join(io.vault_path, RECEIPTS_PATH);
  mkdirSync(dirname(receiptsPath), { recursive: true });
  appendFileSync(receiptsPath, `${JSON.stringify(receipt)}\n`, {encoding:"utf8",mode:0o600});
  const fd = openSync(receiptsPath, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function insertReceiptRow(
  db: Database,
  receipt: CanonReceipt,
  claimKind: string,
): void {
  db.query(
    `INSERT INTO canon_receipts
       (receipt_id, claim_ids, provenance, sensitivity, page_path, kind,
        before_hash, after_hash, at, receipt_kind, page_action, archive_path,
        writer, producer, model_ref, authority, confidence, taint,
        candidates, superseded, retrieval_ops, reverts, reverted_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    receipt.receipt_id,
    JSON.stringify(receipt.claim_ids),
    JSON.stringify(receipt.provenance),
    receipt.sensitivity,
    receipt.page_path,
    claimKind,
    receipt.before_hash,
    receipt.after_hash,
    receipt.at,
    receipt.kind,
    receipt.page_action,
    receipt.archive_path,
    receipt.writer,
    receipt.producer,
    receipt.model_ref,
    receipt.authority,
    receipt.confidence,
    receipt.taint,
    JSON.stringify(receipt.candidates),
    JSON.stringify(receipt.superseded),
    JSON.stringify(receipt.retrieval_ops),
    receipt.reverts,
    receipt.reverted_by,
  );
}

export interface PageIndexEntry {
  page_id: string;
  rel_path: string;
  subject_key: string | null;
  last_receipt: string | null;
  last_hash: string;
}

export function upsertPageIndex(db: Database, entry: PageIndexEntry): void {
  db.query("DELETE FROM page_index WHERE rel_path = ? AND page_id <> ?").run(
    entry.rel_path,
    entry.page_id,
  );
  db.query(
    `INSERT INTO page_index (page_id, rel_path, subject_key, last_receipt, last_hash)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(page_id) DO UPDATE SET
       rel_path = excluded.rel_path,
       subject_key = coalesce(excluded.subject_key, page_index.subject_key),
       last_receipt = excluded.last_receipt,
       last_hash = excluded.last_hash`,
  ).run(
    entry.page_id,
    entry.rel_path,
    entry.subject_key,
    entry.last_receipt,
    entry.last_hash,
  );
}

export function pageIndexById(db: Database, pageId: string): PageIndexEntry | null {
  if (!tableExists(db, "page_index")) return null;
  return db
    .query<PageIndexEntry, [string]>("SELECT * FROM page_index WHERE page_id = ?")
    .get(pageId);
}

export function pageIndexByPath(db: Database, relPath: string): PageIndexEntry | null {
  if (!tableExists(db, "page_index")) return null;
  return db
    .query<PageIndexEntry, [string]>("SELECT * FROM page_index WHERE rel_path = ?")
    .get(relPath);
}

export function pagesForSubject(db: Database, subjectKey: string): PageIndexEntry[] {
  if (!tableExists(db, "page_index")) return [];
  return db
    .query<PageIndexEntry, [string]>(
      "SELECT * FROM page_index WHERE subject_key = ? ORDER BY page_id LIMIT 64",
    )
    .all(subjectKey);
}

export function markReceiptReverted(
  db: Database,
  receiptId: string,
  revertedBy: string,
): void {
  db.query("UPDATE canon_receipts SET reverted_by = ? WHERE receipt_id = ?").run(
    revertedBy,
    receiptId,
  );
}

export function deletePageIndex(db: Database, relPath: string): void {
  if (!tableExists(db, "page_index")) return;
  db.query("DELETE FROM page_index WHERE rel_path = ?").run(relPath);
}

function subjectKeyOf(data: Record<string, unknown>): string | null {
  const raw = data["x-subject-id"];
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

/**
 * `page_index` is derived state (architecture invariant 2): it is rebuilt
 * from the vault plus the receipt rows, and a rebuild is what a vault that
 * predates v4 runs once so the arbiter can see its pages.
 */
export function rebuildPageIndex(io: CanonIo): { pages: number; skipped: number } {
  initCanon(io.db);
  const report = listCanonPagesReport(io.vault_path);
  const rebuild = io.db.transaction((): number => {
    io.db.exec("DELETE FROM page_index");
    let count = 0;
    for (const page of report.pages) {
      upsertPageIndex(io.db, {
        page_id: page.id,
        rel_path: page.relPath,
        subject_key: subjectKeyOf(page.data),
        last_receipt: latestReceiptForPage(io.db, page.relPath)?.receipt_id ?? null,
        last_hash: page.contentHash,
      });
      count += 1;
    }
    return count;
  });
  return { pages: rebuild(), skipped: report.skipped.length };
}
