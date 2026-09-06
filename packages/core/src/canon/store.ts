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
import { fatalCanonSkips, listCanonPagesReport } from "../vault/pages";
import type { RetrievalPort } from "../contracts/retrieval";
import { hashBytes } from "../vault/write";
import { RECEIPTS_PATH, getCanonReceipt, latestReceiptForPage } from "./receipts";
import type { CanonReceipt } from "./receipts";
import { initCanon } from "./schema";
import type { MachineByteIntent } from "../ledger/event-origin";

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

export class CanonPageUnreadable extends Error {
  override readonly name = "CanonPageUnreadable";

  constructor(
    readonly relPath: string,
    readonly code: string,
  ) {
    super("canon page is unreadable");
  }
}

function fsCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = error.code;
    if (typeof code === "string" && /^[A-Z][A-Z0-9_]+$/.test(code)) return code;
  }
  return "EIO";
}


export function readPage(io: CanonIo, relPath: string): ExistingPage | null {
  const path = join(io.vault_path, relPath);
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    if (fsCode(error) === "ENOENT") return null;
    throw new CanonPageUnreadable(relPath, fsCode(error));
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
  db.transaction(() => {
    using select = db.prepare<MachineByteIntent, [string]>(
      "SELECT receipt_id,before_hash,after_hash FROM canon_machine_byte_intents WHERE receipt_id=?",
    );
    const intent = select.get(receipt.receipt_id);
    if (intent !== null && (receipt.writer !== "loop" || intent.before_hash !== receipt.before_hash || intent.after_hash !== receipt.after_hash)) {
      throw new Error("machine byte receipt conflicts with its intent");
    }
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
    if (intent !== null) {
      using remove = db.prepare("DELETE FROM canon_machine_byte_intents WHERE receipt_id=?");
      remove.run(receipt.receipt_id);
    }
  }).immediate();
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

/**
 * page_index last_receipt/last_hash must agree with the receipt they name.
 * A missing receipt or a hash that does not match that receipt is drift,
 * not a hand edit (hand edits change the file, not the receipt row).
 */
export function inspectPageIndex(db: Database): string[] {
  if (!tableExists(db, "page_index") || !tableExists(db, "canon_receipts")) return [];
  const rows = db.query<PageIndexEntry, []>("SELECT * FROM page_index").all();
  const failures: string[] = [];
  for (const row of rows) {
    if (row.last_receipt === null) continue;
    const receipt = getCanonReceipt(db, row.last_receipt);
    if (receipt === null) {
      failures.push("page_index last_receipt missing");
      continue;
    }
    if (receipt.page_path !== row.rel_path) {
      failures.push("page_index last_receipt path mismatch");
    }
    if (receipt.after_hash !== row.last_hash) {
      failures.push("page_index last_hash does not match receipt");
    }
  }
  return failures;
}

function subjectKeyOf(data: Record<string, unknown>): string | null {
  const raw = data["x-subject-id"];
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

/**
 * `page_index` is derived state (architecture invariant 2): it is rebuilt
 * from the vault plus the receipt rows, and a rebuild is what a vault that
 * predates v4 runs once so the arbiter can see its pages.
 * A named schema-invalid page stays in the index so the arbiter cannot fork
 * its subject; serving still withholds it. A truncated or fatal walk refuses
 * without wiping the existing index.
 * `last_hash` is the latest receipt's `after_hash` when one exists, so
 * doctor can distinguish receipt/index drift from a later hand edit.
 */
export function rebuildPageIndex(io: CanonIo): { pages: number; skipped: number } {
  initCanon(io.db);
  const report = listCanonPagesReport(io.vault_path);
  if (report.truncated || fatalCanonSkips(report.skipped).length > 0) {
    throw new Error("canon is unreadable; page index rebuild refused");
  }
  const rebuild = io.db.transaction((): number => {
    io.db.exec("DELETE FROM page_index");
    let count = 0;
    const indexed = new Set<string>();
    const put = (
      pageId: string,
      relPath: string,
      data: Record<string, unknown>,
      contentHash: string,
    ): void => {
      if (indexed.has(pageId)) return;
      const latest = latestReceiptForPage(io.db, relPath);
      upsertPageIndex(io.db, {
        page_id: pageId,
        rel_path: relPath,
        subject_key: subjectKeyOf(data),
        last_receipt: latest?.receipt_id ?? null,
        last_hash: latest?.after_hash ?? contentHash,
      });
      indexed.add(pageId);
      count += 1;
    };
    for (const page of report.pages) {
      put(page.id, page.relPath, page.data, page.contentHash);
    }
    for (const entry of report.skipped) {
      if (entry.code !== "invalid") continue;
      const existing = readPage(io, entry.relPath);
      if (existing === null) continue;
      const id = existing.page.data["id"];
      if (typeof id !== "string" || id.length === 0) continue;
      put(id, entry.relPath, existing.page.data, existing.hash);
    }
    return count;
  });
  return { pages: rebuild(), skipped: report.skipped.length };
}
