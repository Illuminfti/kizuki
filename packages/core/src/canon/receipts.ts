import type { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Sensitivity } from "../agents/types";
import type {
  AuthorityTier,
  CanonicalProducer,
  ClaimTaint,
} from "../contracts/proposal";
import { tableExists } from "../ledger/schema";
import type { Writer } from "../vault/write";

/** Shared with the pre-RFC promotion log so a vault keeps one receipt file. */
export const RECEIPTS_PATH = ".kizuki/receipts/promotions.jsonl";

export const RECEIPT_KINDS = ["write", "revert", "purge_rewrite"] as const;
export type ReceiptKind = (typeof RECEIPT_KINDS)[number];

export const PAGE_ACTIONS = ["create", "edit", "archive"] as const;
export type PageAction = (typeof PAGE_ACTIONS)[number];

export interface PageCandidate {
  page_id: string;
  rel_path: string;
  /** Authority of the page's most recent receipted write. */
  authority: AuthorityTier;
  /** `at` of the page's first receipt; "" when the page has none. */
  created_at: string;
}

export interface RetrievalOpRef {
  store: string;
  op: "upsert" | "remove";
  doc: string;
}

/** RFC 0002 §4.5. Key order here is the order the JSONL line is written in. */
export interface CanonReceipt {
  receipt_id: string;
  kind: ReceiptKind;
  claim_ids: string[];
  page_path: string;
  page_action: PageAction;
  before_hash: string | null;
  after_hash: string;
  archive_path: string | null;
  writer: Writer;
  producer: CanonicalProducer;
  model_ref: string | null;
  authority: AuthorityTier;
  confidence: number;
  sensitivity: Sensitivity;
  taint: ClaimTaint;
  provenance: string[];
  superseded: { claim_id: string; claim_key: string }[];
  candidates: PageCandidate[];
  retrieval_ops: RetrievalOpRef[];
  reverts: string | null;
  reverted_by: string | null;
  at: string;
}

export interface CanonReceiptRow {
  receipt_id: string;
  claim_ids: string;
  provenance: string;
  sensitivity: string;
  page_path: string;
  kind: string;
  before_hash: string | null;
  after_hash: string;
  at: string;
  receipt_kind: string;
  page_action: string;
  archive_path: string | null;
  writer: string;
  producer: string;
  model_ref: string | null;
  authority: string;
  confidence: number;
  taint: string;
  candidates: string;
  superseded: string;
  retrieval_ops: string;
  reverts: string | null;
  reverted_by: string | null;
}

function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function rowToReceipt(row: CanonReceiptRow): CanonReceipt {
  return {
    receipt_id: row.receipt_id,
    kind: row.receipt_kind as ReceiptKind,
    claim_ids: parseJson<string[]>(row.claim_ids, []),
    page_path: row.page_path,
    page_action: row.page_action as PageAction,
    before_hash: row.before_hash,
    after_hash: row.after_hash,
    archive_path: row.archive_path,
    writer: row.writer as Writer,
    producer: row.producer as CanonicalProducer,
    model_ref: row.model_ref,
    authority: row.authority as AuthorityTier,
    confidence: row.confidence,
    sensitivity: row.sensitivity as Sensitivity,
    taint: row.taint as ClaimTaint,
    provenance: parseJson<string[]>(row.provenance, []),
    superseded: parseJson<CanonReceipt["superseded"]>(row.superseded, []),
    candidates: parseJson<PageCandidate[]>(row.candidates, []),
    retrieval_ops: parseJson<RetrievalOpRef[]>(row.retrieval_ops, []),
    reverts: row.reverts,
    reverted_by: row.reverted_by,
    at: row.at,
  };
}

interface LegacyLine {
  receipt_id: string;
  proposal_id: string;
  provenance: string[];
  sensitivity: Sensitivity;
  page_path: string;
  kind: string;
  before_hash: string | null;
  after_hash: string;
  at: string;
}

/** Same mapping the v4 migration applies to a `promotions` row (§18.1). */
function fromLegacyLine(line: LegacyLine): CanonReceipt {
  return {
    receipt_id: line.receipt_id,
    kind: "write",
    claim_ids: [line.proposal_id],
    page_path: line.page_path,
    page_action:
      line.before_hash === null
        ? "create"
        : line.kind === "deletion"
          ? "archive"
          : "edit",
    before_hash: line.before_hash,
    after_hash: line.after_hash,
    archive_path: null,
    writer: "import",
    producer: "deterministic",
    model_ref: null,
    authority: "connector_evidence",
    confidence: 1,
    sensitivity: line.sensitivity,
    taint: "quoted",
    provenance: line.provenance,
    superseded: [],
    candidates: [],
    retrieval_ops: [],
    reverts: null,
    reverted_by: null,
    at: line.at,
  };
}

export function parseReceiptLine(line: string): CanonReceipt {
  const parsed = JSON.parse(line) as Record<string, unknown>;
  if (typeof parsed["proposal_id"] === "string" && !("claim_ids" in parsed)) {
    return fromLegacyLine(parsed as unknown as LegacyLine);
  }
  return parsed as unknown as CanonReceipt;
}

export function readReceiptsLog(vaultPath: string): CanonReceipt[] {
  const receiptsPath = join(vaultPath, RECEIPTS_PATH);
  if (!existsSync(receiptsPath)) return [];
  return readFileSync(receiptsPath, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map(parseReceiptLine);
}

export function getCanonReceipt(db: Database, receiptId: string): CanonReceipt | null {
  if (!tableExists(db, "canon_receipts")) return null;
  const row = db
    .query<CanonReceiptRow, [string]>("SELECT * FROM canon_receipts WHERE receipt_id = ?")
    .get(receiptId);
  return row === null ? null : rowToReceipt(row);
}

export function listCanonReceipts(
  db: Database,
  opts: { page_path?: string; limit?: number } = {},
): CanonReceipt[] {
  if (!tableExists(db, "canon_receipts")) return [];
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 10_000);
  if (opts.page_path !== undefined) {
    return db
      .query<CanonReceiptRow, [string, number]>(
        "SELECT * FROM canon_receipts WHERE page_path = ? ORDER BY at, receipt_id LIMIT ?",
      )
      .all(opts.page_path, limit)
      .map(rowToReceipt);
  }
  return db
    .query<CanonReceiptRow, [number]>(
      "SELECT * FROM canon_receipts ORDER BY at, receipt_id LIMIT ?",
    )
    .all(limit)
    .map(rowToReceipt);
}

export function latestReceiptForPage(db: Database, pagePath: string): CanonReceipt | null {
  if (!tableExists(db, "canon_receipts")) return null;
  const row = db
    .query<CanonReceiptRow, [string]>(
      "SELECT * FROM canon_receipts WHERE page_path = ? ORDER BY at DESC, receipt_id DESC LIMIT 1",
    )
    .get(pagePath);
  return row === null ? null : rowToReceipt(row);
}

export function receiptsForClaim(db: Database, claimId: string): CanonReceipt[] {
  if (!tableExists(db, "canon_receipts")) return [];
  return db
    .query<CanonReceiptRow, [string]>(
      `SELECT r.* FROM canon_receipts r, json_each(r.claim_ids) j
        WHERE j.value = ? ORDER BY r.at, r.receipt_id`,
    )
    .all(claimId)
    .map(rowToReceipt);
}
