import type { Database } from "bun:sqlite";
import { isAuthorityTier } from "../contracts/proposal";
import type { AuthorityTier } from "../contracts/proposal";
import {
  getSourceSurvivorLineage,
  isLineageHash,
  isLineageId,
  isLineageTimestamp,
  lineageReceiptEarlier,
  parseSourceSurvivorLineage,
  sameUnredactedPage,
  sourceSurvivorLineageTableReady,
  type SourceSurvivorLineage,
} from "../ledger/canon-source-survivor-lineage";
import { tableExists } from "../ledger/schema";
import type { CanonPage } from "../vault/pages";
interface Materialization {
  receipt_id: string;
  page_path: string;
  receipt_kind: string;
  page_action: string;
  before_hash: string | null;
  after_hash: string;
  authority: string;
  reverts: string | null;
  writer: string;
  producer: string;
  archive_path: string | null;
  model_ref: string | null;
  at: string;
}
const MAX_PAGE_RECEIPTS = 4096;
const MAX_CHAIN_DEPTH = 128;
const HASH = /^[a-f0-9]{64}$/;
const RECEIPT_COLUMNS =
  "receipt_id,page_path,receipt_kind,page_action,before_hash,after_hash,authority,reverts,writer,producer,archive_path,model_ref,at";
export interface CanonRevisionBasis {
  receipt_id: string;
  after_hash: string;
  at: string;
  authority: AuthorityTier;
}
interface RevisionState {
  authority: AuthorityTier;
  basis: CanonRevisionBasis | null;
}
const UNRECORDED: RevisionState = { authority: "owner_authored", basis: null };
const UNAVAILABLE: RevisionState = { authority: "model_inference", basis: null };
function earlier(left: Materialization, right: Materialization): boolean {
  return lineageReceiptEarlier(left, right);
}
function validTime(at: string): boolean {
  return Number.isFinite(Date.parse(at));
}
/** A snapshot of durable receipt history, independent of mutable claim/revert status. */
export class CanonAuthorityResolver {
  private readonly db: Database;
  private readonly byPath = new Map<string, Materialization[]>();
  private readonly byId = new Map<string, Materialization>();
  private readonly checkpoints = new Map<string, SourceSurvivorLineage | "none" | "invalid">();
  private readonly charged = new Map<string, Set<string>>();
  private readonly overflow = new Set<string>();
  private readonly hasLineage: boolean;
  constructor(db: Database, paths: readonly string[]) {
    this.db = db;
    this.hasLineage = sourceSurvivorLineageTableReady(db);
    if (!tableExists(db, "canon_receipts")) {
      return;
    }
    const distinct = [...new Set(paths.filter(path => path !== ""))];
    for (let offset = 0; offset < distinct.length; offset += 400) {
      const group = distinct.slice(offset, offset + 400);
      const slots = group.map(() => "?").join(",");
      const rows = db.query<Materialization, string[]>(`SELECT * FROM (
    SELECT ${RECEIPT_COLUMNS},
    row_number() OVER(PARTITION BY page_path ORDER BY at DESC,receipt_id DESC) AS ordinal
    FROM canon_receipts WHERE page_path IN (${slots})) WHERE ordinal<=${MAX_PAGE_RECEIPTS + 1}
    ORDER BY at DESC,receipt_id DESC`).all(...group);
      for (const row of rows) {
        const charged = this.charged.get(row.page_path) ?? new Set<string>();
        charged.add(row.receipt_id);
        this.charged.set(row.page_path, charged);
        if (row.page_path !== "") {
          const page = this.byPath.get(row.page_path) ?? [];
          page.push(row);
          this.byPath.set(row.page_path, page);
          if (page.length > MAX_PAGE_RECEIPTS) this.overflow.add(row.page_path);
        }
        this.byId.set(row.receipt_id, row);
      }
    }
    for (const rows of this.byPath.values()) {
      rows.sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || b.receipt_id.localeCompare(a.receipt_id));
    }
    this.loadCheckpoints([...this.byId.keys()]);
  }
  resolve(path: string, hash: string): AuthorityTier {
    return this.state(path, hash, null, new Set()).authority;
  }
  /** Positive evidence never inherits the protective owner fallback. */
  basis(path: string, hash: string): CanonRevisionBasis | null {
    return this.state(path, hash, null, new Set()).basis;
  }
  /** The materialized state immediately before a receipt, including undo-of-undo. */
  before(receiptId: string): AuthorityTier {
    const receipt = this.byId.get(receiptId) ?? this.lookup(receiptId, "");
    if (receipt === undefined || receipt.before_hash === null || !isAuthorityTier(receipt.authority)) {
      return "model_inference";
    }
    return this.state(receipt.page_path, receipt.before_hash, receipt, new Set([receiptId])).authority;
  }
  private loadCheckpoints(ids: readonly string[]): void {
    if (!this.hasLineage || ids.length === 0) return;
    for (let offset = 0; offset < ids.length; offset += 400) {
      const group = ids.slice(offset, offset + 400).filter(id => !this.checkpoints.has(id));
      if (group.length === 0) continue;
      const slots = group.map(() => "?").join(",");
      const rows = this.db.query<Record<string, unknown>, string[]>(
        `SELECT version,kind,child_receipt_id,predecessor_receipt_id,before_hash,after_hash,predecessor_effective_authority,result_authority
         FROM canon_source_survivor_lineage WHERE child_receipt_id IN (${slots})`,
      ).all(...group);
      for (const row of rows) {
        try {
          const parsed = parseSourceSurvivorLineage(row);
          this.checkpoints.set(parsed.child_receipt_id, parsed);
        } catch {
          const child = row["child_receipt_id"];
          if (typeof child === "string") this.checkpoints.set(child, "invalid");
        }
      }
      for (const id of group) {
        if (!this.checkpoints.has(id)) this.checkpoints.set(id, "none");
      }
    }
  }
  private checkpoint(id: string): SourceSurvivorLineage | "none" | "invalid" {
    if (!this.hasLineage) return "none";
    const cached = this.checkpoints.get(id);
    if (cached !== undefined) return cached;
    try {
      const row = getSourceSurvivorLineage(this.db, id);
      const value = row === null ? "none" : row;
      this.checkpoints.set(id, value);
      return value;
    } catch {
      this.checkpoints.set(id, "invalid");
      return "invalid";
    }
  }
  private charge(path: string, id: string): boolean {
    if (path === "") return true;
    const charged = this.charged.get(path) ?? new Set<string>();
    if (charged.has(id)) return !this.overflow.has(path);
    charged.add(id);
    this.charged.set(path, charged);
    if (charged.size > MAX_PAGE_RECEIPTS) {
      this.overflow.add(path);
      return false;
    }
    return !this.overflow.has(path);
  }
  private lookup(id: string, chargePath: string): Materialization | undefined {
    const existing = this.byId.get(id);
    if (existing !== undefined) {
      if (chargePath !== "" && !this.charge(chargePath, id)) return undefined;
      return existing;
    }
    if (!isLineageId(id) || this.overflow.has(chargePath)) return undefined;
    if (chargePath !== "" && !this.charge(chargePath, id)) return undefined;
    const row = this.db.query<Materialization, [string]>(
      `SELECT ${RECEIPT_COLUMNS} FROM canon_receipts WHERE receipt_id=?`,
    ).get(id);
    if (row === null) return undefined;
    this.byId.set(id, row);
    this.loadCheckpoints([id]);
    return row;
  }
  private state(path: string, hash: string, before: Materialization | null, seen: Set<string>): RevisionState {
    if (!HASH.test(hash) || this.overflow.has(path) || seen.size >= MAX_CHAIN_DEPTH) {
      return UNAVAILABLE;
    }
    if (path === "") return UNAVAILABLE;
    const receipt = this.byPath.get(path)?.find(row => row.after_hash === hash && (before === null || earlier(row, before)));
    if (receipt === undefined) {
      return UNRECORDED;
    }
    return this.evaluate(path, receipt, seen, false);
  }
  private evaluate(path: string, receipt: Materialization, seen: Set<string>, viaBinding: boolean): RevisionState {
    if (seen.has(receipt.receipt_id) || !validTime(receipt.at) || !isAuthorityTier(receipt.authority)) {
      return UNAVAILABLE;
    }
    if (!viaBinding && receipt.page_path !== path) return UNAVAILABLE;
    if (receipt.page_path !== "" && receipt.page_path !== path) return UNAVAILABLE;
    seen.add(receipt.receipt_id);
    const checkpoint = this.checkpoint(receipt.receipt_id);
    if (checkpoint === "invalid") return UNAVAILABLE;
    if (checkpoint !== "none") return this.fromCheckpoint(path, receipt, checkpoint, seen);
    const recorded = (state: RevisionState): RevisionState => ({
      authority: state.authority,
      basis: state.basis === null ? null : {
        receipt_id: receipt.receipt_id,
        after_hash: receipt.after_hash,
        at: receipt.at,
        authority: state.authority,
      },
    });
    switch (receipt.receipt_kind) {
      case "write": return receipt.reverts === null &&
        (receipt.before_hash === null || HASH.test(receipt.before_hash)) ? {
          authority: receipt.authority,
          basis: { receipt_id: receipt.receipt_id, after_hash: receipt.after_hash, at: receipt.at, authority: receipt.authority },
        } : UNAVAILABLE;
      case "purge_rewrite":
        if (receipt.before_hash === null || receipt.reverts !== null) {
          return UNAVAILABLE;
        }
        return recorded(this.state(path, receipt.before_hash, receipt, seen));
      case "revert": {
        if (receipt.reverts === null || seen.has(receipt.reverts)) return UNAVAILABLE;
        const target = this.lookup(receipt.reverts, path);
        if (
          target === undefined ||
          !this.samePage(path, target.page_path, true) ||
          !earlier(target, receipt) ||
          target.before_hash === null ||
          !HASH.test(target.after_hash) ||
          receipt.before_hash !== target.after_hash ||
          receipt.after_hash !== target.before_hash ||
          !isAuthorityTier(target.authority) ||
          seen.has(target.receipt_id)
        ) {
          return UNAVAILABLE;
        }
        seen.add(target.receipt_id);
        return recorded(this.state(path, target.before_hash, target, seen));
      }
      default: return UNAVAILABLE;
    }
  }
  private samePage(livePath: string, otherPath: string, allowEmptyBinding: boolean): boolean {
    if (otherPath === "") return allowEmptyBinding;
    return sameUnredactedPage(livePath, otherPath);
  }
  private fromCheckpoint(
    path: string,
    child: Materialization,
    checkpoint: SourceSurvivorLineage,
    seen: Set<string>,
  ): RevisionState {
    if (
      checkpoint.child_receipt_id !== child.receipt_id ||
      child.receipt_kind !== "purge_rewrite" ||
      child.page_action !== "edit" ||
      child.writer !== "loop" ||
      child.producer !== "deterministic" ||
      child.model_ref !== null ||
      child.reverts !== null ||
      child.archive_path !== null ||
      child.before_hash !== checkpoint.before_hash ||
      child.after_hash !== checkpoint.after_hash ||
      child.authority !== checkpoint.result_authority ||
      !isLineageHash(child.after_hash) ||
      !isLineageTimestamp(child.at)
    ) {
      return UNAVAILABLE;
    }
    if (child.page_path !== "" && child.page_path !== path) return UNAVAILABLE;
    const predecessor = this.lookup(checkpoint.predecessor_receipt_id, path);
    if (
      predecessor === undefined ||
      predecessor.receipt_id !== checkpoint.predecessor_receipt_id ||
      predecessor.after_hash !== checkpoint.before_hash ||
      !isAuthorityTier(predecessor.authority) ||
      !isLineageTimestamp(predecessor.at) ||
      !earlier(predecessor, child) ||
      seen.has(predecessor.receipt_id)
    ) {
      return UNAVAILABLE;
    }
    if (predecessor.page_path !== "" && predecessor.page_path !== path) return UNAVAILABLE;
    seen.add(predecessor.receipt_id);
    if (!this.validPredecessor(path, predecessor, seen)) return UNAVAILABLE;
    const prior = this.checkpoint(predecessor.receipt_id);
    if (prior === "invalid") return UNAVAILABLE;
    if (prior !== "none") {
      const nested = this.fromCheckpoint(path, predecessor, prior, seen);
      if (nested.basis === null || nested.authority !== checkpoint.predecessor_effective_authority) {
        return UNAVAILABLE;
      }
    } else if (
      predecessor.receipt_kind === "write" &&
      predecessor.authority !== checkpoint.predecessor_effective_authority
    ) {
      return UNAVAILABLE;
    }
    return {
      authority: checkpoint.result_authority,
      basis: {
        receipt_id: child.receipt_id,
        after_hash: child.after_hash,
        at: child.at,
        authority: checkpoint.result_authority,
      },
    };
  }
  private validPredecessor(path: string, predecessor: Materialization, seen: Set<string>): boolean {
    switch (predecessor.receipt_kind) {
      case "write":
        return predecessor.reverts === null &&
          (predecessor.before_hash === null || HASH.test(predecessor.before_hash));
      case "purge_rewrite":
        return predecessor.before_hash !== null && HASH.test(predecessor.before_hash) && predecessor.reverts === null;
      case "revert": {
        if (predecessor.reverts === null || seen.has(predecessor.reverts)) return false;
        const target = this.lookup(predecessor.reverts, path);
        if (
          target === undefined ||
          !this.samePage(path, target.page_path, true) ||
          !earlier(target, predecessor) ||
          target.before_hash === null || !HASH.test(target.before_hash) ||
          !HASH.test(target.after_hash) ||
          !isAuthorityTier(target.authority) ||
          predecessor.before_hash !== target.after_hash ||
          predecessor.after_hash !== target.before_hash ||
          seen.has(target.receipt_id)
        ) {
          return false;
        }
        seen.add(target.receipt_id);
        return true;
      }
      default:
        return false;
    }
  }
}
export function canonAuthorities(db: Database, pages: readonly CanonPage[]): Map<string, AuthorityTier> {
  const resolver = new CanonAuthorityResolver(db, pages.map(page => page.relPath));
  return new Map(pages.map(page => [page.relPath, resolver.resolve(page.relPath, page.contentHash)]));
}
