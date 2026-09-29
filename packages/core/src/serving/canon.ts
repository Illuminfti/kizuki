import { resolve } from "node:path";
import type { Database } from "bun:sqlite";
import { sourceEventsAllowed, sourceSensitivity } from "../ledger/source-grants";
import { canonPageRecoveryPending, canonReadGeneration } from "../canon/write-intent";
import { authorize, sensitivity } from "../agents";
import type { DenyReason, Grant, Sensitivity, Servable } from "../agents";
import type { AuthorityTier } from "../contracts/proposal";
import { canonAuthorities } from "../canon/authority";
import { purgeDiscoveryPending } from "../derived-holds";
import { eventIdFromReference } from "../retrieval/ids";
import { isHeld, readHolds } from "../ledger/purge";
import { tableExists } from "../ledger/schema";
import {
  createCanonPageCache,
  fatalCanonSkips,
  isLiveCanonPage,
  listCanonPagesReport,
  stringArray,
} from "../vault/pages";
import type { CanonPageCache } from "../vault/pages";
import type { CanonPage, SkippedPage } from "../vault/pages";
import { assessLivePageEvidence, type LivePageEvidence } from "../vault/provenance";
import { PAGE_TAINTS } from "../vault/schema";
import type { PageTaint } from "../vault/schema";
import { ServeError } from "./types";
import type { CanonChunk, ServeContext } from "./types";

export interface CanonIndex {
  sourceContext: ServeContext;
  generation: number;
  pages: CanonPage[];
  byId: Map<string, CanonPage>;
  /** Vault-relative path with forward slashes, as the walk produced it. */
  byPath: Map<string, CanonPage>;
  holds: Set<string>;
  /** Hash-bound effective authority of the current page bytes. */
  authority: Map<string, AuthorityTier>;
}

export { sensitivity as asSensitivity };

/** A frontmatter value only when it is a string; every other shape is absent. */
export function stringField(page: CanonPage, key: string): string | null {
  const value = page.data[key];
  return typeof value === "string" ? value : null;
}

/** RFC 0002 §10.5: a page carries `clean` produced prose or `quoted` capture. */
export function asTaint(value: unknown): PageTaint | null {
  return typeof value === "string" &&
    (PAGE_TAINTS as readonly string[]).includes(value)
    ? (value as PageTaint)
    : null;
}

/**
 * The vault walk reports what it could not use instead of throwing, so the
 * refusal carries that report: the caller-facing message names nothing, and
 * the owner's own tooling reads the paths and reasons off the cause.
 */
export class CanonUnreadableError extends Error {
  override name = "CanonUnreadableError";
  readonly skipped: SkippedPage[];

  constructor(skipped: SkippedPage[]) {
    super(`canon is not fully readable: ${skipped.length} page(s)`);
    this.skipped = skipped;
  }
}

/**
 * What one adapter process remembers about one vault between served calls: the
 * parsed pages, and the authority each page's bytes resolved to under one
 * state of the receipt history. Both are validated on every call, so a canon
 * write, an edit on disk or a purge is visible to the next call.
 */
interface VaultMemo {
  pages: CanonPageCache;
  authorityStamp: string;
  authority: Map<string, { contentHash: string; tier: AuthorityTier }>;
}

/** A process serves one vault; a few more cover tests and multi-vault hosts. */
const MEMO_VAULTS = 4;
const memos = new Map<string, VaultMemo>();

function vaultMemo(vaultPath: string): VaultMemo {
  const key = resolve(vaultPath);
  const known = memos.get(key);
  if (known !== undefined) return known;
  if (memos.size >= MEMO_VAULTS) memos.delete(memos.keys().next().value!);
  const created: VaultMemo = { pages: createCanonPageCache(), authorityStamp: "", authority: new Map() };
  memos.set(key, created);
  return created;
}

/**
 * The receipt history a page's authority is resolved from. Every canon write,
 * recovery, withdrawal and purge advances the read generation; the counts
 * additionally cover history that arrives without it.
 */
function receiptStamp(db: Database): string {
  const receipts = db
    .query<{ n: number; head: number }, []>("SELECT count(*) AS n, coalesce(max(rowid), 0) AS head FROM canon_receipts")
    .get()!;
  const purges = db.query<{ n: number }, []>("SELECT count(*) AS n FROM event_purges").get()!.n;
  const lineage = tableExists(db, "canon_source_survivor_lineage")
    ? db.query<{ n: number }, []>("SELECT count(*) AS n FROM canon_source_survivor_lineage").get()!.n
    : 0;
  return `${canonReadGeneration(db)}:${receipts.n}:${receipts.head}:${purges}:${lineage}`;
}

/** Resolves only the pages whose bytes, or the receipt history, changed since the last call. */
function resolveAuthorities(db: Database, memo: VaultMemo, pages: readonly CanonPage[]): Map<string, AuthorityTier> {
  const stamp = receiptStamp(db);
  if (memo.authorityStamp !== stamp) {
    memo.authority = new Map();
    memo.authorityStamp = stamp;
  }
  const stale = pages.filter((page) => memo.authority.get(page.relPath)?.contentHash !== page.contentHash);
  const resolved = stale.length === 0 ? new Map<string, AuthorityTier>() : canonAuthorities(db, stale);
  // Rebuilt from the current pages, so a deleted page's entry does not linger.
  const next = new Map<string, { contentHash: string; tier: AuthorityTier }>();
  const tiers = new Map<string, AuthorityTier>();
  for (const page of pages) {
    const tier = resolved.get(page.relPath) ?? memo.authority.get(page.relPath)!.tier;
    next.set(page.relPath, { contentHash: page.contentHash, tier });
    tiers.set(page.relPath, tier);
  }
  memo.authority = next;
  return tiers;
}

/**
 * One vault walk and one hold read per served call; a file the walk finds
 * unchanged is not read again (see `VaultMemo`). A page that cannot be
 * read, parsed, or uniquely identified makes the whole read refuse: serving
 * a silently short list would under-report canon without anyone noticing.
 * Schema-invalid and oversized files are withheld and reported by doctor.
 */
export function loadCanon(ctx: ServeContext): CanonIndex {
  const generation = canonReadGeneration(ctx.db);
  assertCanonReadAdmission(ctx);
  const memo = vaultMemo(ctx.vaultPath);
  const report = listCanonPagesReport(ctx.vaultPath, memo.pages);
  const fatal = fatalCanonSkips(report.skipped);
  if (fatal.length > 0) {
    throw new CanonUnreadableError(fatal);
  }
  const byId = new Map<string, CanonPage>();
  const byPath = new Map<string, CanonPage>();
  for (const page of report.pages) {
    byId.set(page.id, page);
    byPath.set(page.relPath, page);
  }
  assertCanonReadAdmission(ctx);
  if (canonReadGeneration(ctx.db) !== generation) throw new ServeError("held", "canon changed during request; retry");
  return {
    sourceContext: ctx,
    generation,
    pages: report.pages,
    byId,
    byPath,
    holds: new Set(readHolds(ctx.db).map((hold) => hold.page_path)),
    authority: resolveAuthorities(ctx.db, memo, report.pages),
  };
}

/** Recheck durable admission even for a canon snapshot loaded before recovery. */
function canonReadHeld(ctx: ServeContext, page?: CanonPage): boolean {
  if (purgeDiscoveryPending(ctx.db)) return true;
  if (page === undefined) return false;
  if (canonPageRecoveryPending(ctx.db, page.relPath)) return true;
  if (isHeld(ctx.db, page.relPath)) return true;
  const sources = stringArray(page.data["sources"]).map(eventIdFromReference);
  // A completed rewrite can lift the current hold while an older in-memory
  // page still carries erased evidence. Such a snapshot must never revive.
  return sources.length > 0 && ctx.db.query(
    "SELECT 1 FROM event_purges WHERE event_id IN (SELECT value FROM json_each(?)) LIMIT 1",
  ).get(JSON.stringify(sources)) !== null;
}

function assertCanonReadAdmission(ctx: ServeContext, page?: CanonPage): void {
  if (canonReadHeld(ctx, page)) throw new ServeError("held", "canon unavailable during purge recovery");
}

/** A retracted page is absent, not a policy denial: `draft` and `archived` never count. */
export function eligible(page: CanonPage): boolean {
  return isLiveCanonPage(page);
}

export function pageServable(index: CanonIndex, page: CanonPage): Servable {
  const type = stringField(page, "type");
  return {
    id: page.id,
    sensitivity: stringField(page, "sensitivity"),
    ...(type === null ? {} : { type }),
    subjects: stringArray(page.data["subjects"]),
    held: index.generation !== canonReadGeneration(index.sourceContext.db) || index.holds.has(page.relPath) || canonReadHeld(index.sourceContext, page),
  };
}

export function pageDecision(
  index: CanonIndex,
  grant: Grant,
  page: CanonPage,
):
  | { allow: true; sensitivity: Sensitivity; taint: PageTaint; evidence: Extract<LivePageEvidence, { admitted: true }> }
  | { allow: false; reason: DenyReason } {
  // Both labels are read first so the served chunk carries narrowed types
  // instead of casts. A page missing either is withheld from everyone, the
  // owner included: an unstamped page may be verbatim capture, and serving
  // it as canon would hand a reader capture dressed as produced prose.
  const sourceCtx = index.sourceContext;
  if (index.generation !== canonReadGeneration(sourceCtx.db) || canonReadHeld(sourceCtx, page)) return { allow: false, reason: "held" };
  const evidence = assessLivePageEvidence(sourceCtx.db, page, undefined, {...sourceCtx,principal:{...sourceCtx.principal,grant}});
  if (!evidence.admitted) return { allow: false, reason: "held" };
  if (!sourceEventsAllowed(sourceCtx.db, evidence.sourceIds, { owner: sourceCtx.principal.kind === "owner", purpose: sourceCtx.sourcePurpose ?? "recall" })) return { allow: false, reason: "held" };
  const original = sensitivity(page.data["sensitivity"]);
  const label = original === null ? null : sourceSensitivity(sourceCtx.db, evidence.sourceIds, original);
  if (label === null) return { allow: false, reason: "missing_sensitivity" };
  const taint = asTaint(page.data["taint"]);
  if (taint === null) return { allow: false, reason: "missing_taint" };
  const decision = authorize(grant, { ...pageServable(index, page), sensitivity: label });
  return decision.allow
    ? { allow: true, sensitivity: label, taint, evidence }
    : { allow: false, reason: decision.reason };
}

export function canonChunk(
  index: CanonIndex,
  page: CanonPage,
  decision: { sensitivity: Sensitivity; taint: PageTaint },
  excerpt: string,
  truncated: boolean,
): CanonChunk {
  assertCanonReadAdmission(index.sourceContext, page);
  if (index.generation !== canonReadGeneration(index.sourceContext.db)) throw new ServeError("held", "canon changed during request; retry");
  const evidence = assessLivePageEvidence(index.sourceContext.db, page, undefined, index.sourceContext);
  if (!evidence.admitted || !sourceEventsAllowed(index.sourceContext.db, evidence.sourceIds, {
    owner: index.sourceContext.principal.kind === "owner",
    purpose: index.sourceContext.sourcePurpose ?? "recall",
  })) throw new ServeError("held", "canon evidence unavailable");
  return {
    page_id: page.id,
    path: page.relPath,
    title: stringField(page, "title") ?? "",
    type: stringField(page, "type") ?? "",
    sensitivity: decision.sensitivity,
    taint: decision.taint,
    authority: evidence.revision.authority,
    subjects: stringArray(page.data["subjects"]),
    sources: stringArray(page.data["sources"]),
    excerpt,
    truncated,
  };
}

export function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** Code-point safe, so a surrogate pair at the boundary is never split. */
export function excerptOf(
  body: string,
  maxChars: number,
): { excerpt: string; truncated: boolean } {
  const points = Array.from(body);
  if (points.length <= maxChars) return { excerpt: body, truncated: false };
  return { excerpt: points.slice(0, maxChars).join(""), truncated: true };
}
