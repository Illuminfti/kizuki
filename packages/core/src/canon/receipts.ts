import { isWorldCanonReceipt, parseWorldCanonReceipt, type WorldCanonReceiptRecord, type ErasedWorldCanonReceipt } from "./world-receipt";
import { completedEventPurgeProofs } from "../ledger/purge";
import { canonicalJson } from "../util/hash";
import { ABSENT_PAGE_HASH } from "../vault/write";
import { RECEIPTS_PATH } from "./receipt-path";
import { assertReceiptPaths } from "./paths";
import type { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Sensitivity } from "../agents/types";
import type {
  AuthorityTier,
  CanonicalProducer,
  ClaimTaint,
} from "../contracts/proposal";
import { oneShotGet, tableExists } from "../ledger/schema";
import type { Writer } from "../vault/write";

/** Shared with the pre-RFC promotion log so a vault keeps one receipt file. */
export { RECEIPTS_PATH } from "./receipt-path";

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
  prior_receipt_id?: string | null; record_codec?: string; receipt_state?: string; world_basis?: string | null; own_id_origin?: string | null; purge_receipt_id?: string | null; erased_at?: string | null; erasure_integrity?: string | null;
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
  if (row.receipt_state === "erased") throw new Error("canon_receipt_erased");
  assertReceiptPaths(row);
  const receipt: CanonReceipt = {
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
  if (row.record_codec === "kizuki.canon-receipt/v2") {
    const typed = parseWorldCanonReceipt({...receipt, schema:row.record_codec, state:row.receipt_state, own_id_origin:row.own_id_origin, prior_receipt_id:row.prior_receipt_id, basis:parseJson(row.world_basis ?? "", null)});
    if (typed === null || typed.state !== "retained") throw new Error("canon_receipt_invalid");
    return typed;
  }
  if (row.record_codec !== undefined && row.record_codec !== "v1") throw new Error("canon_receipt_invalid");
  return receipt;
}

export type CanonReceiptRecord = CanonReceipt | WorldCanonReceiptRecord;
export function rowToReceiptRecord(row: CanonReceiptRow): CanonReceiptRecord {
  if (row.receipt_state !== "erased") return rowToReceipt(row);
  const typed = parseWorldCanonReceipt({schema:row.record_codec,state:row.receipt_state,receipt_id:row.receipt_id,prior_receipt_id:row.prior_receipt_id,purge_receipt_id:row.purge_receipt_id,own_id_origin:row.own_id_origin,erased_at:row.erased_at,sensitivity:row.sensitivity,integrity:row.erasure_integrity});
  if (typed === null || typed.state !== "erased") throw new Error("canon_receipt_invalid");
  return typed;
}
export function isErasedReceipt(record: CanonReceiptRecord): record is ErasedWorldCanonReceipt {
  return "state" in record && record.state === "erased";
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
  assertReceiptPaths({ page_path: line.page_path, archive_path: null });
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

export function parseReceiptRecordLine(line: string): CanonReceiptRecord {
  const parsed = JSON.parse(line) as Record<string, unknown>;
  if (typeof parsed["proposal_id"] === "string" && !("claim_ids" in parsed)) {
    return fromLegacyLine(parsed as unknown as LegacyLine);
  }
  if ("schema" in parsed) {
    const typed = parseWorldCanonReceipt(parsed);
    if (typed === null) throw new Error("canon_receipt_invalid");
    return typed;
  }
  const receipt = parsed as unknown as CanonReceipt;
  assertReceiptPaths(receipt);
  return receipt;
}

export function parseReceiptLine(line: string): CanonReceipt {
  const receipt = parseReceiptRecordLine(line);
  if (isErasedReceipt(receipt)) throw new Error("canon_receipt_erased");
  return receipt;
}
export function readReceiptRecords(vaultPath: string): CanonReceiptRecord[] {
  const receiptsPath = join(vaultPath, RECEIPTS_PATH);
  if (!existsSync(receiptsPath)) return [];
  return readFileSync(receiptsPath, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map(parseReceiptRecordLine);
}

export function readReceiptsLog(vaultPath: string): CanonReceipt[] {
  return readReceiptRecords(vaultPath).filter((record): record is CanonReceipt => !isErasedReceipt(record));
}
export function getCanonReceiptRecord(db: Database, receiptId: string): CanonReceiptRecord | null {
  if (!tableExists(db, "canon_receipts")) return null;
  const row = db
    .query<CanonReceiptRow, [string]>("SELECT * FROM canon_receipts WHERE receipt_id = ?")
    .get(receiptId);
  return row === null ? null : rowToReceiptRecord(row);
}
export function getCanonReceipt(db: Database, receiptId: string): CanonReceipt | null {
  const record = getCanonReceiptRecord(db, receiptId);
  return record === null || isErasedReceipt(record) ? null : record;
}

/** One bounded causal history in the existing journal, including erased bridges.
 * Erased records keep only opaque operation edges. Page identity comes from
 * retained records; entirely erased histories with no retained page detach.
 */
export function worldReceiptChain(db: Database, pagePath: string): WorldCanonReceiptRecord[] {
  return receiptJournalShape(db).typed ? typedReceiptChain(db, pagePath) : [];
}

/** One bounded schema probe; per-row readers call it once per receipt. */
function receiptJournalShape(db: Database): { exists: boolean; typed: boolean } {
  const shape = oneShotGet<{ columns: number; typed: number | null }>(
    db,
    "SELECT count(*) AS columns, max(name = 'prior_receipt_id') AS typed FROM pragma_table_info('canon_receipts')",
  );
  return { exists: (shape?.columns ?? 0) > 0, typed: shape?.typed === 1 };
}

function typedReceiptChain(db: Database, pagePath: string): WorldCanonReceiptRecord[] {
  const anchors = db.query<{ receipt_id: string }, [string]>(
    "SELECT receipt_id FROM canon_receipts WHERE page_path=? AND record_codec='kizuki.canon-receipt/v2' LIMIT 4097",
  ).all(pagePath);
  if (anchors.length === 0) return [];
  const fail = (): never => { throw new Error("typed canon receipt lineage invalid"); };
  if (anchors.length > 4096) fail();
  const cache = new Map<string, WorldCanonReceiptRecord>();
  const read = (id: string): WorldCanonReceiptRecord => {
    const cached = cache.get(id); if (cached !== undefined) return cached;
    if (cache.size >= 4096) fail();
    const record = getCanonReceiptRecord(db, id);
    if (record === null || (!isErasedReceipt(record) && !isWorldCanonReceipt(record))) return fail();
    if (isErasedReceipt(record)) {
      const event = db.query<{ event_id: string }, [string]>(
        "SELECT event_id FROM event_purges WHERE receipt_id=?",
      ).get(record.purge_receipt_id);
      const proof = event === null ? null : completedEventPurgeProofs(db, [event.event_id]);
      if (proof?.[0]?.purge_receipt_id !== record.purge_receipt_id) fail();
    } else if (record.page_path !== pagePath) fail();
    cache.set(id, record);
    return record;
  };
  const ancestry = new Set<string>();
  let root = read(anchors[0]!.receipt_id);
  while (root.prior_receipt_id !== null) {
    if (ancestry.has(root.receipt_id)) fail();
    ancestry.add(root.receipt_id);
    root = read(root.prior_receipt_id);
  }
  // A retained root must prove an initial creation. A purge rewrite or revert
  // cannot turn into one merely by dropping its edge to erased history.
  if (!isErasedReceipt(root) && (root.kind !== "write" || root.page_action !== "create" ||
      root.before_hash !== null || root.basis.before !== null || root.reverts !== null)) fail();
  const result: WorldCanonReceiptRecord[] = [], seen = new Set<string>();
  let current = root;
  while (true) {
    if (seen.has(current.receipt_id)) fail();
    seen.add(current.receipt_id); result.push(current);
    const children = db.query<{ receipt_id: string }, [string]>(
      "SELECT receipt_id FROM canon_receipts WHERE prior_receipt_id=? LIMIT 2",
    ).all(current.receipt_id);
    if (children.length === 0) break;
    if (children.length !== 1) fail();
    const child = read(children[0]!.receipt_id);
    if (!isErasedReceipt(current) && !isErasedReceipt(child) &&
      ((child.before_hash ?? ABSENT_PAGE_HASH) !== current.after_hash ||
       canonicalJson(child.basis.before) !== canonicalJson(current.basis.after))) fail();
    current = child;
  }
  if (anchors.some(anchor => !seen.has(anchor.receipt_id))) fail();
  return result;
}

export function latestWorldReceiptRecord(db: Database, pagePath: string): WorldCanonReceiptRecord | null {
  return worldReceiptChain(db, pagePath).at(-1) ?? null;
}

/**
 * Canon receipts recorded after `afterReceiptId`, or all of them when null.
 * Freshness checks run on every read, so they count rows instead of
 * materializing and parsing every receipt.
 */
export function countCanonReceipts(
  db: Database,
  afterReceiptId: string | null = null,
): number {
  if (!tableExists(db, "canon_receipts")) return 0;
  if (afterReceiptId === null) {
    return db.query<{ count: number }, []>(
      "SELECT COUNT(*) AS count FROM canon_receipts",
    ).get()?.count ?? 0;
  }
  return db.query<{ count: number }, [string]>(
    "SELECT COUNT(*) AS count FROM canon_receipts WHERE receipt_id > ?",
  ).get(afterReceiptId)?.count ?? 0;
}

export interface ListCanonReceiptsOptions {
  page_path?: string;
  writer?: string;
  since?: string;
  newest_first?: boolean;
  include_reverted?: boolean;
  only_reverted?: boolean;
  only_ambiguous?: boolean;
  only_contested?: boolean;
  limit?: number;
  offset?: number;
}

export function listCanonReceipts(
  db: Database,
  opts: ListCanonReceiptsOptions = {},
): CanonReceipt[] {
  if (!tableExists(db, "canon_receipts")) return [];
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 10_000);
  const offset = Math.max(opts.offset ?? 0, 0);
  const clauses: string[] = ["page_path IS NOT NULL"];
  const params: (string | number)[] = [];
  if (opts.page_path !== undefined) {
    clauses.push("page_path = ?");
    params.push(opts.page_path);
  }
  if (opts.writer !== undefined) {
    clauses.push("writer = ?");
    params.push(opts.writer);
  }
  if (opts.since !== undefined) {
    clauses.push("at >= ?");
    params.push(opts.since);
  }
  if (opts.include_reverted === false) {
    clauses.push("reverted_by IS NULL");
  }
  if (opts.only_reverted === true) clauses.push("reverted_by IS NOT NULL");
  if (opts.only_ambiguous === true) clauses.push("json_array_length(candidates) > 0");
  if (opts.only_contested === true) {
    if (!tableExists(db, "claims")) return [];
    clauses.push(`EXISTS (
      SELECT 1 FROM claims receipt_claim
      JOIN claims sibling_claim
        ON sibling_claim.claim_key = receipt_claim.claim_key
       AND sibling_claim.status = 'live'
      WHERE receipt_claim.receipt_id = canon_receipts.receipt_id
        AND receipt_claim.claim_key IS NOT NULL
        AND receipt_claim.status = 'live'
      GROUP BY receipt_claim.claim_key
      HAVING count(*) > 1
    )`);
  }
  const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
  const order = opts.newest_first === true ? "at DESC, receipt_id DESC" : "at, receipt_id";
  return db
    .query<CanonReceiptRow, (string | number)[]>(
      `SELECT * FROM canon_receipts${where} ORDER BY ${order} LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset)
    .map(rowToReceipt);
}

/** Later un-reverted receipts on the same page, newest first. */
export function laterReceiptsForPage(
  db: Database,
  pagePath: string,
  after: { at: string; receipt_id: string },
): CanonReceipt[] {
  if (!tableExists(db, "canon_receipts")) return [];
  const chain = worldReceiptChain(db, pagePath);
  if (chain.length > 0) {
    const index = chain.findIndex(record => record.receipt_id === after.receipt_id);
    if (index < 0) throw new Error("typed canon receipt lineage invalid");
    return chain.slice(index + 1).reverse().filter((record): record is import("./world-receipt").RetainedWorldCanonReceipt =>
      !isErasedReceipt(record) && record.reverted_by === null);
  }
  return db
    .query<CanonReceiptRow, [string, string, string, string]>(
      `SELECT * FROM canon_receipts
        WHERE page_path = ?
          AND reverted_by IS NULL
          AND (at > ? OR (at = ? AND receipt_id > ?))
        ORDER BY at DESC, receipt_id DESC`,
    )
    .all(pagePath, after.at, after.at, after.receipt_id)
    .map(rowToReceipt);
}

/** The next receipt on the same page, including reverted writes; one indexed row. */
export function nextReceiptForPage(
  db: Database,
  pagePath: string,
  after: { at: string; receipt_id: string },
): CanonReceipt | null {
  const shape = receiptJournalShape(db);
  if (!shape.exists) return null;
  const chain = shape.typed ? typedReceiptChain(db, pagePath) : [];
  if (chain.length > 0) {
    const index = chain.findIndex(record => record.receipt_id === after.receipt_id);
    if (index < 0) throw new Error("typed canon receipt lineage invalid");
    const next = chain[index + 1];
    return next === undefined || isErasedReceipt(next) ? null : next;
  }
  const row = db
    .query<CanonReceiptRow, [string, string, string, string]>(
      `SELECT * FROM canon_receipts
        WHERE page_path = ?
          AND (at > ? OR (at = ? AND receipt_id > ?))
        ORDER BY at, receipt_id LIMIT 1`,
    )
    .get(pagePath, after.at, after.at, after.receipt_id);
  return row === null ? null : rowToReceipt(row);
}

export function latestReceiptForPage(db: Database, pagePath: string): CanonReceipt | null {
  if (!tableExists(db, "canon_receipts")) return null;
  const typed = latestWorldReceiptRecord(db, pagePath);
  if (typed !== null) return isErasedReceipt(typed) ? null : typed;
  // Receipt timestamps describe the asserted fact and may be backdated. The
  // page index instead records the receipt that produced the bytes on disk.
  if (tableExists(db, "page_index")) {
    const indexed = db
      .query<{ last_receipt: string | null }, [string]>(
        "SELECT last_receipt FROM page_index WHERE rel_path = ? LIMIT 1",
      )
      .get(pagePath);
    if (indexed?.last_receipt !== null && indexed?.last_receipt !== undefined) {
      const current = getCanonReceipt(db, indexed.last_receipt);
      if (current !== null && current.page_path === pagePath) return current;
    }
  }
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
