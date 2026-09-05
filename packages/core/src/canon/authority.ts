import type { Database } from "bun:sqlite";
import { isAuthorityTier } from "../contracts/proposal";
import type { AuthorityTier } from "../contracts/proposal";
import { tableExists } from "../ledger/schema";
import type { CanonPage } from "../vault/pages";
interface Materialization {
  receipt_id: string;
  page_path: string;
  receipt_kind: string;
  before_hash: string | null;
  after_hash: string;
  authority: string;
  reverts: string | null;
  at: string;
}
const MAX_PAGE_RECEIPTS = 4096;
const MAX_CHAIN_DEPTH = 128;
const HASH = /^[a-f0-9]{64}$/;
function earlier(left: Materialization, right: Materialization): boolean {
  const a = Date.parse(left.at), b = Date.parse(right.at);
  return Number.isFinite(a) && Number.isFinite(b) && (a < b || (a === b && left.receipt_id < right.receipt_id));
}
/** A snapshot of durable receipt history, independent of mutable claim/revert status. */
export class CanonAuthorityResolver {
  private readonly byPath = new Map<string, Materialization[]>();
  private readonly byId = new Map<string, Materialization>();
  private readonly overflow = new Set<string>();
  constructor(db: Database, paths: readonly string[]) {
    if (!tableExists(db, "canon_receipts")) {
      return;
    }
    const distinct = [...new Set(paths)];
    for (let offset = 0; offset < distinct.length; offset += 400) {
      const group = distinct.slice(offset, offset + 400);
      const slots = group.map(() => "?").join(",");
      const rows = db.query<Materialization, string[]>(`SELECT * FROM (
    SELECT receipt_id,page_path,receipt_kind,before_hash,after_hash,authority,reverts,at,
    row_number() OVER(PARTITION BY page_path ORDER BY at DESC,receipt_id DESC) AS ordinal
    FROM canon_receipts WHERE page_path IN (${slots})) WHERE ordinal<=${MAX_PAGE_RECEIPTS + 1}
    ORDER BY at DESC,receipt_id DESC`).all(...group);
      for (const row of rows) {
        const page = this.byPath.get(row.page_path) ?? [];
        page.push(row);
        this.byPath.set(row.page_path, page);
        this.byId.set(row.receipt_id, row);
        if (page.length > MAX_PAGE_RECEIPTS) {
          this.overflow.add(row.page_path);
        }
      }
    }
    for (const rows of this.byPath.values()) {
      rows.sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || b.receipt_id.localeCompare(a.receipt_id));
    }
  }
  resolve(path: string, hash: string): AuthorityTier {
    return this.state(path, hash, null, new Set());
  }
  /** The materialized state immediately before a receipt, including undo-of-undo. */
  before(receiptId: string): AuthorityTier {
    const receipt = this.byId.get(receiptId);
    if (receipt === undefined || receipt.before_hash === null || !isAuthorityTier(receipt.authority)) {
      return "model_inference";
    }
    return this.state(receipt.page_path, receipt.before_hash, receipt, new Set([receiptId]));
  }
  private state(path: string, hash: string, before: Materialization | null, seen: Set<string>): AuthorityTier {
    if (!HASH.test(hash) || this.overflow.has(path) || seen.size >= MAX_CHAIN_DEPTH) {
      return "model_inference";
    }
    const receipt = this.byPath.get(path)?.find(row => row.after_hash === hash && (before === null || earlier(row, before)));
    if (receipt === undefined) {
      return "owner_authored";
    }
    if (seen.has(receipt.receipt_id) || !Number.isFinite(Date.parse(receipt.at)) || !isAuthorityTier(receipt.authority)) {
      return "model_inference";
    }
    seen.add(receipt.receipt_id);
    switch (receipt.receipt_kind) {
      case "write": return receipt.reverts === null ? receipt.authority : "model_inference";
      case "purge_rewrite":
        if (receipt.before_hash === null) {
          return "model_inference";
        }
        return this.state(path, receipt.before_hash, receipt, seen);
      case "revert": {
        const target = receipt.reverts === null ? undefined : this.byId.get(receipt.reverts);
        if (
          target === undefined || target.page_path !== path || !earlier(target, receipt) ||
          target.before_hash === null || receipt.before_hash !== target.after_hash ||
          receipt.after_hash !== target.before_hash || !isAuthorityTier(target.authority) ||
          seen.has(target.receipt_id)
        ) {
          return "model_inference";
        }
        seen.add(target.receipt_id);
        return this.state(path, target.before_hash, target, seen);
      }
      default: return "model_inference";
    }
  }
}
export function canonAuthorities(db: Database, pages: readonly CanonPage[]): Map<string, AuthorityTier> {
  const resolver = new CanonAuthorityResolver(db, pages.map(page => page.relPath));
  return new Map(pages.map(page => [page.relPath, resolver.resolve(page.relPath, page.contentHash)]));
}
