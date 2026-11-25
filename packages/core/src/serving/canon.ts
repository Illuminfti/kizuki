import { selectedPage } from "../query/selection";
import { boundScrubText } from "../producer/scrub";
import { resolve } from "node:path";
import type { Database } from "bun:sqlite";
import { inspectSourceGrant, sourceEventsAllowed, sourceSensitivity, sourceServingSql, type SourceGrant, type SourceGrantLookup } from "../ledger/source-grants";
import { readLiveEvent } from "../ledger/ledger";
import { CanonAuthorityResolver, canonAuthorities } from "../canon/authority";
import { classesOfEvents } from "../ledger/event-classes";
import { classesOfPage } from "../canon/page-classes";
import { compareRfc3339 } from "../agents/time";
import { placeholders } from "../util/sql";
import { canonPageRecoveryPending, canonReadGeneration } from "../canon/write-intent";
import { ceilingSql, requireCeiling, instantPairSql, instantBoundPair } from "../query/sql";
import { authorize, sensitivity, denyClassesOf } from "../agents";
import type { DenyReason, Grant, Sensitivity, Servable } from "../agents";
import type { AuthorityTier } from "../contracts/proposal";
import { getWorldCanonReceipt } from "../canon/receipts";
import { purgeDiscoveryPending } from "../derived-holds";
import { eventIdFromReference } from "../retrieval/ids";
import { isHeld } from "../ledger/purge";
import { tableExists } from "../ledger/schema";
import {
  createCanonPageCache,
  isLiveCanonPage,
  listCanonPagesReport,
  splitServingSkips,
  stringArray,
} from "../vault/pages";
import type { CanonPageCache } from "../vault/pages";
import type { CanonPage, SkippedPage } from "../vault/pages";
import { assessLivePageEvidence, type LivePageEvidence, type PageEvidenceReader } from "../vault/provenance";
import { PAGE_TAINTS } from "../vault/schema";
import type { PageTaint } from "../vault/schema";
import { purgeReadEpoch } from "../derived-holds";
import { sourcePolicyEpoch } from "../ledger/source-grants";
import { claimsEpoch } from "./epoch";
import { redactorOf } from "./redact";
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
  /** Durable permission denials survive malformed or relabeled page bytes. */
  deniedPaths: Set<string>;
  /** Hash-bound effective authority of the current page bytes. */
  authority: Map<string, AuthorityTier>;
  /** Single page files the walk could not use: named, and served to no one. */
  withheld: SkippedPage[];
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
interface AuthorityMemo {
  authorityStamp: string;
  authority: Map<string, { contentHash: string; tier: AuthorityTier }>;
}
interface VaultMemo {
  pages: CanonPageCache;
  authorities: Map<string, AuthorityMemo>;
}

/** A process serves one vault; a few more cover tests and multi-vault hosts. */
const MEMO_VAULTS = 4;
const MEMO_SCOPES = 8;
const MAX_MEMO_PAGES = 16_384;
const MAX_MEMO_BODY_BYTES = 32 * 1024 * 1024;
const MAX_SINGLE_CACHED_BODY_BYTES = 131_072;
const MEMO_IDLE_TTL_MS = 120_000;
const MAX_OWNER_DECISION_CACHE = 512;
const memos = new Map<string, VaultMemo>();
let ownerDecisionByDb = new WeakMap<Database, Map<string, ReturnType<typeof pageSnapshotDecision>>>();
const servingCacheTrimmers: (() => void)[] = [];
let memoIdleTimer: ReturnType<typeof setTimeout> | null = null;

function ownerDecisionMap(db: Database): Map<string, ReturnType<typeof pageSnapshotDecision>> {
  let cache = ownerDecisionByDb.get(db);
  if (cache === undefined) {
    cache = new Map();
    ownerDecisionByDb.set(db, cache);
  }
  return cache;
}

export function registerServingCacheTrimmer(trimmer: () => void): void {
  servingCacheTrimmers.push(trimmer);
}

function scheduleMemoIdleTrim(): void {
  if (memoIdleTimer !== null) clearTimeout(memoIdleTimer);
  memoIdleTimer = setTimeout(() => {
    memoIdleTimer = null;
    memos.clear();
    ownerDecisionByDb = new WeakMap();
    for (const trimmer of servingCacheTrimmers) trimmer();
  }, MEMO_IDLE_TTL_MS);
  memoIdleTimer.unref?.();
}

export function trimServingCaches(): void {
  if (memoIdleTimer !== null) {
    clearTimeout(memoIdleTimer);
    memoIdleTimer = null;
  }
  memos.clear();
  ownerDecisionByDb = new WeakMap();
  for (const trimmer of servingCacheTrimmers) trimmer();
}

function boundCanonPageCache(cache: CanonPageCache): void {
  let totalBytes = 0;
  for (const [relPath, entry] of cache.files) {
    const len = entry.body.length;
    if (len > MAX_SINGLE_CACHED_BODY_BYTES) {
      cache.files.delete(relPath);
      continue;
    }
    totalBytes += len;
  }
  if (cache.files.size > MAX_MEMO_PAGES || totalBytes > MAX_MEMO_BODY_BYTES) {
    for (const [relPath, entry] of cache.files) {
      if (cache.files.size <= MAX_MEMO_PAGES && totalBytes <= MAX_MEMO_BODY_BYTES) break;
      totalBytes -= entry.body.length;
      cache.files.delete(relPath);
    }
  }
}

function vaultMemo(vaultPath: string): VaultMemo {
  scheduleMemoIdleTrim();
  const key = resolve(vaultPath);
  const known = memos.get(key);
  if (known !== undefined) return known;
  if (memos.size >= MEMO_VAULTS) memos.delete(memos.keys().next().value!);
  const created: VaultMemo = { pages: createCanonPageCache(), authorities: new Map() };
  memos.set(key, created);
  return created;
}

/**
 * The receipt history a page's authority is resolved from. Every canon write,
 * recovery and withdrawal affecting permitted paths changes this stamp.
 * Hidden receipt history cannot invalidate a reader's authority memo.
 */
function receiptStamp(db: Database, pages: readonly CanonPage[]): string {
  const paths = JSON.stringify(pages.map(page => page.relPath));
  const receipts = db.query<{ n: number; head: number }, [string]>(`
    SELECT count(*) AS n, coalesce(max(rowid), 0) AS head FROM canon_receipts
    WHERE page_path IN (SELECT value FROM json_each(?))
  `).get(paths)!;
  const lineage = tableExists(db, "canon_source_survivor_lineage")
    ? db.query<{ n: number }, [string]>(`
      SELECT count(*) AS n FROM canon_source_survivor_lineage
      WHERE child_receipt_id IN (SELECT receipt_id FROM canon_receipts WHERE page_path IN (SELECT value FROM json_each(?)))
    `).get(paths)!.n : 0;
  return `${receipts.n}:${receipts.head}:${lineage}`;
}

/** Durable receipt labels isolate failures in paths the reader cannot see. */
function deniedCanonPaths(ctx: ServeContext): Set<string> {
  // One aggregate row on every request: hidden receipts cannot change work
  // counters by adding returned rows or per-page authorization queries.
  const grant = ctx.principal.grant;
  const ceiling = requireCeiling(grant.ceiling);
  const source = ctx.principal.kind === "owner" ? null : sourceServingSql(ctx.db, { owner: false, purpose: ctx.sourcePurpose ?? "recall", deny_classes: denyClassesOf(grant) }, ceiling);
  const deniedSource = source === null ? "0" : `EXISTS (
    SELECT 1 FROM json_each(r.provenance) p WHERE NOT EXISTS (
      SELECT 1 FROM events WHERE events.event_id=CASE WHEN p.value LIKE 'event:%' THEN substr(p.value,7) ELSE p.value END
      AND ${source.sql}
    )
  )`;
  const scopeDenials: string[] = [];
  const scopeBindings: (string | number)[] = [];
  if (grant.types !== null) {
    // A complete receipt's page-writing claims can deny the old path before
    // parsing changed bytes. Unknown typed frontmatter is not a type proof.
    scopeDenials.push(`(r.receipt_kind='write' AND EXISTS(SELECT 1 FROM json_each(r.claim_ids))
      AND NOT EXISTS(SELECT 1 FROM json_each(r.claim_ids) ids LEFT JOIN claims c ON c.claim_id=ids.value
        WHERE c.claim_id IS NULL OR json_type(c.frontmatter,'$.type') IS NOT 'text'
          OR json_extract(c.frontmatter,'$.type') IN (SELECT value FROM json_each(?))))`);
    scopeBindings.push(JSON.stringify(grant.types));
  }
  if (grant.since !== null || grant.until !== null) {
    const within: string[] = [];
    if (grant.since !== null) { within.push(`${instantPairSql("events.occurred_at")} >= (?,?)`); scopeBindings.push(...instantBoundPair(grant.since, "grant since")); }
    if (grant.until !== null) { within.push(`${instantPairSql("events.occurred_at")} <= (?,?)`); scopeBindings.push(...instantBoundPair(grant.until, "grant until")); }
    scopeDenials.push(`(json_array_length(r.provenance)=0 OR EXISTS(SELECT 1 FROM json_each(r.provenance) p
      WHERE NOT EXISTS(SELECT 1 FROM events WHERE events.event_id=CASE WHEN p.value LIKE 'event:%' THEN substr(p.value,7) ELSE p.value END
        AND ${within.join(" AND ")})))`);
  }
  if (denyClassesOf(grant).includes("credential") && tableExists(ctx.db, "canon_page_classes"))
    scopeDenials.push(`EXISTS(SELECT 1 FROM page_index pi JOIN canon_page_classes pc USING(page_id)
      WHERE pi.rel_path=r.page_path AND pc.content_hash=r.after_hash AND pc.credential=1)`);
  const subjects = grant.subjects === null ? null : JSON.stringify(grant.subjects);
  const row = ctx.db.query<{ paths: string }, (string | number | null)[]>(`
    SELECT json_group_array(page_path) AS paths FROM canon_receipts r
    WHERE page_path <> '' AND (
      NOT (${ceilingSql("r.sensitivity")})
      OR ${deniedSource}
      ${scopeDenials.map(sql => `OR ${sql}`).join("\n")}
      OR (r.receipt_kind='write' AND ? IS NOT NULL AND EXISTS (
        SELECT 1 FROM json_each(r.claim_ids) ids JOIN claims c ON c.claim_id=ids.value
        WHERE json_type(c.frontmatter, '$.subjects')='array'
          AND NOT EXISTS (SELECT 1 FROM json_each(c.frontmatter, '$.subjects') s
            JOIN json_each(?) allowed ON allowed.value=s.value)
      ))
    )
      AND NOT EXISTS (SELECT 1 FROM canon_receipts newer WHERE newer.page_path=r.page_path
        AND (newer.at, newer.receipt_id) > (r.at, r.receipt_id))
  `).get(ceiling, ...(source?.bindings ?? []), ...scopeBindings, subjects, subjects)!;
  return new Set(JSON.parse(row.paths) as string[]);
}

/** Private audit evidence for a selector filtered before file parsing. */
export function deniedPageAudit(index: CanonIndex, selector: { id: string } | { path: string }): { id: string; reason: DenyReason }[] {
  const { db, principal } = index.sourceContext;
  const denied = JSON.stringify(denyClassesOf(principal.grant));
  const pageClass = tableExists(db, "canon_page_classes")
    ? `EXISTS(SELECT 1 FROM canon_page_classes pc WHERE pc.page_id=pi.page_id AND pc.content_hash=pi.last_hash AND pc.credential=1) AND EXISTS(SELECT 1 FROM json_each(?) WHERE value='credential')` : "0";
  const sourceClass = tableExists(db, "event_classes")
    ? `EXISTS(SELECT 1 FROM canon_receipts r, json_each(r.provenance) p JOIN event_classes ec ON ec.event_id=CASE WHEN p.value LIKE 'event:%' THEN substr(p.value,7) ELSE p.value END
        WHERE r.receipt_id=pi.last_receipt AND ec.class IN (SELECT value FROM json_each(?)))` : "0";
  const window: string[] = [];
  const windowBindings: (string | number)[] = [];
  if (principal.grant.since !== null) {
    window.push(`${instantPairSql("events.occurred_at")} >= (?,?)`);
    windowBindings.push(...instantBoundPair(principal.grant.since, "grant since"));
  }
  if (principal.grant.until !== null) {
    window.push(`${instantPairSql("events.occurred_at")} <= (?,?)`);
    windowBindings.push(...instantBoundPair(principal.grant.until, "grant until"));
  }
  const timeDenied = window.length === 0 ? "0" : `EXISTS (
    SELECT 1 FROM canon_receipts r WHERE r.receipt_id=pi.last_receipt AND
      (json_array_length(r.provenance)=0 OR EXISTS (SELECT 1 FROM json_each(r.provenance) p
        WHERE NOT EXISTS (SELECT 1 FROM events
          WHERE events.event_id=CASE WHEN p.value LIKE 'event:%' THEN substr(p.value,7) ELSE p.value END
            AND ${window.join(" AND ")}))))`;
  // Aggregate to one bounded result even for an absent selector. No denied
  // file is read, and these identities never enter an agent's response.
  const row = db.query<{ value: string }, (string | number)[]>(`SELECT json_group_array(json_object('id',pi.page_id,'path',pi.rel_path,
    'classDenied',(${pageClass}) OR (${sourceClass}), 'timeDenied',(${timeDenied}))) AS value FROM page_index pi WHERE ${"id" in selector ? "pi.page_id" : "pi.rel_path"}=?`)
    .get(...(pageClass === "0" ? [] : [denied]), ...(sourceClass === "0" ? [] : [denied]), ...windowBindings, "id" in selector ? selector.id : selector.path)!;
  const entries = JSON.parse(row.value) as { id: string; path: string; classDenied: number; timeDenied: number }[];
  return entries.filter(item => index.deniedPaths.has(item.path)).map(item => ({ id: item.id, reason: item.classDenied ? "class_denied" : item.timeDenied ? "time_out_of_scope" : "held" }));
}

/** Resolves only the pages whose bytes, or the receipt history, changed since the last call. */
function resolveAuthorities(db: Database, memo: AuthorityMemo, pages: readonly CanonPage[]): Map<string, AuthorityTier> {
  const stamp = receiptStamp(db, pages);
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
 * parsed or uniquely identified, or a walk that cannot finish, makes the whole
 * read refuse: serving a silently short list would under-report canon without
 * anyone noticing. One page file that cannot be read, a symlink included, says
 * nothing about the rest: it is withheld and named on the index, and
 * `system_health` reports it. Schema-invalid and oversized files are withheld
 * and reported by doctor.
 */
export function loadCanon(ctx: ServeContext, options: { readonly include_archived?: boolean } = {}): CanonIndex {
  const generation = canonReadGeneration(ctx.db);
  assertCanonReadAdmission(ctx);
  const grant = ctx.principal.grant;
  const includeArchived = options.include_archived === true;
  const reqKey = JSON.stringify([includeArchived, ctx.principal.kind, ctx.sourcePurpose ?? "recall", grant.ceiling, grant.types, grant.subjects, grant.since, grant.until, denyClassesOf(grant)]);
  const cachedIndex = ctx.requestCanon?.get(reqKey);
  if (cachedIndex !== undefined && cachedIndex.generation === generation) {
    return cachedIndex;
  }
  const memo = vaultMemo(ctx.vaultPath);
  const denied = deniedCanonPaths(ctx);
  const report = listCanonPagesReport(ctx.vaultPath, memo.pages, denied, { include_archived: includeArchived });
  boundCanonPageCache(memo.pages);
  const { fatal, withheld } = splitServingSkips(report.skipped);
  if (fatal.length > 0) {
    throw new CanonUnreadableError(fatal);
  }
  const scopeKey = JSON.stringify([ctx.principal.kind, ctx.sourcePurpose ?? "recall", grant.ceiling, grant.types, grant.subjects, grant.since, grant.until, denyClassesOf(grant)]);
  let authorityMemo = memo.authorities.get(scopeKey);
  if (authorityMemo === undefined) {
    if (memo.authorities.size >= MEMO_SCOPES) memo.authorities.delete(memo.authorities.keys().next().value!);
    authorityMemo = { authorityStamp: "", authority: new Map() };
    memo.authorities.set(scopeKey, authorityMemo);
  }
  const byId = new Map<string, CanonPage>();
  const byPath = new Map<string, CanonPage>();
  for (const page of report.pages) {
    byId.set(page.id, page);
    byPath.set(page.relPath, page);
  }
  const permitted = report.pages.filter(page => !denied.has(page.relPath) && authorize(grant, pageScope(ctx, page, grant)).allow);
  const holds = tableExists(ctx.db, "canon_holds") ? ctx.db.query<{ page_path: string }, [string]>(`
    SELECT page_path FROM (
      SELECT page_path FROM canon_holds UNION SELECT page_path FROM canon_write_intents
      UNION SELECT page_path FROM canon_projection_obligations
    ) WHERE page_path IN (SELECT value FROM json_each(?))
  `).all(JSON.stringify(permitted.map(page => page.relPath))) : [];
  assertCanonReadAdmission(ctx);
  if (canonReadGeneration(ctx.db) !== generation) throw new ServeError("held", "canon changed during request; retry");
  const index: CanonIndex = {
    sourceContext: ctx,
    generation,
    pages: report.pages,
    byId,
    byPath,
    deniedPaths: denied,
    holds: new Set(holds.map(hold => hold.page_path)),
    authority: resolveAuthorities(ctx.db, authorityMemo, permitted),
    withheld,
  };
  ctx.requestCanon?.set(reqKey, index);
  return index;
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

/** An explicit effective grant omits only dimensions its authorization does not inspect. */
export function pageScope(ctx: ServeContext, page: CanonPage, grant?: Grant): Servable {
  return scopeForSources(ctx, page, stringArray(page.data["sources"]).map(eventIdFromReference), grant);
}

function scopeForSources(ctx: ServeContext, page: CanonPage, ids: readonly string[], grant?: Grant): Servable {
  const type = stringField(page, "type");
  const span = grant !== undefined && grant.since === null && grant.until === null ? null : sourceSpan(ctx.db, ids);
  return {
    id: page.id,
    sensitivity: stringField(page, "sensitivity"),
    ...(type === null ? {} : { type }),
    subjects: stringArray(page.data["subjects"]),
    ...(span === null ? {} : { occurred_span: span }),
    classes: grant !== undefined && denyClassesOf(grant).length === 0
      ? [] : [...new Set([...classesOfPage(ctx.db, page), ...classesOfEvents(ctx.db, ids)])],
  };
}

/**
 * The earliest and latest occurrence among a page's source events, so a
 * time-scoped grant reads it only when every source falls in the window. A
 * source that cannot be read leaves no span, and the window then denies it.
 */
function sourceSpan(db: Database, ids: readonly string[]): { from: string; to: string } | null {
  if (ids.length === 0) return null;
  const found = new Map(
    db
      .query<{ event_id: string; occurred_at: string }, string[]>(
        `SELECT event_id, occurred_at FROM events WHERE event_id IN (${placeholders(ids.length)})`,
      )
      .all(...ids)
      .map((row) => [row.event_id, row]),
  );
  let from: string | null = null;
  let to: string | null = null;
  try {
    for (const id of ids) {
      const at = found.get(id)?.occurred_at;
      if (at === undefined) return null;
      from = from === null || compareRfc3339(at, "occurred_at", from, "occurred_at") < 0 ? at : from;
      to = to === null || compareRfc3339(at, "occurred_at", to, "occurred_at") > 0 ? at : to;
    }
  } catch {
    return null;
  }
  return from === null || to === null ? null : { from, to };
}

/** Internal phase readers; omitted for every final publication/writer check. */
export interface CanonReadAccess {
  evidence: PageEvidenceReader;
  grantOf: SourceGrantLookup;
  /** Optional owner-only DB stamp memoized for one synchronous call. */
  ownerStamp?: () => string | null;
  /** Opt in to the owner-only cross-call page-decision cache (never set by CanonAccessPhase). */
  allowOwnerDecisionCache?: boolean;
}

/**
 * Synchronous single-call read acceleration: shares one authority resolver,
 * live-event check cache, and source-grant lookup across pages without global
 * DB counter queries. Must never outlive a synchronous call phase.
 */
export function createPageReadAccess(
  index: CanonIndex,
  grant: Grant,
  grantOf?: SourceGrantLookup,
): CanonReadAccess {
  const ctx = index.sourceContext;
  const db = ctx.db;
  let resolver: CanonAuthorityResolver | undefined;
  let resolverPaths: Set<string> | undefined;
  let cachedOwnerStamp: string | null | undefined;
  const liveEvents = new Map<string, boolean>();
  const sourceGrants = new Map<string, SourceGrant | null>();
  const lookupGrant: SourceGrantLookup = grantOf ?? ((sourceKey: string): SourceGrant | null => {
    if (sourceGrants.has(sourceKey)) return sourceGrants.get(sourceKey)!;
    const loaded = inspectSourceGrant(db, sourceKey);
    sourceGrants.set(sourceKey, loaded);
    return loaded;
  });
  const liveExternalEvent = (id: string): boolean => {
    const cached = liveEvents.get(id);
    if (cached !== undefined) return cached;
    const ok = readLiveEvent(db, id)?.origin === "external";
    if (liveEvents.size < 65_536) liveEvents.set(id, ok);
    return ok;
  };
  return {
    grantOf: lookupGrant,
    allowOwnerDecisionCache: true,
    ownerStamp() {
      if (ctx.principal.kind !== "owner") return null;
      if (cachedOwnerStamp === undefined) cachedOwnerStamp = ownerPageDecisionStamp(db);
      return cachedOwnerStamp;
    },
    evidence(page, context, historical) {
      if (resolver === undefined) {
        const eligiblePaths = index.pages
          .filter((candidate) => !index.deniedPaths.has(candidate.relPath) && eligible(candidate) && authorize(grant, pageScope(ctx, candidate, grant)).allow)
          .map((candidate) => candidate.relPath);
        resolver = new CanonAuthorityResolver(db, eligiblePaths);
        resolverPaths = new Set(eligiblePaths);
      }
      return assessLivePageEvidence(
        db,
        page,
        resolverPaths!.has(page.relPath) ? resolver : undefined,
        context,
        historical,
        liveExternalEvent,
      );
    },
  };
}

/** Owner-only cache of table presence for page-decision DB stamping. */
const ownerPageStampTableCache = new WeakMap<Database, { schema: number; sql: string | null }>();

/**
 * Owner-only comprehensive DB stamp covering all tables read by page/evidence
 * authorization (including typed world-canon support), while ignoring
 * `agent_audit` writes. Never used for scoped agents.
 */
function ownerPageDecisionStamp(db: Database): string | null {
  if (db.inTransaction) return null;
  const ver = db.query<{ data_version: number; schema_version: number }, []>(
    "SELECT (SELECT data_version FROM pragma_data_version) AS data_version, (SELECT schema_version FROM pragma_schema_version) AS schema_version",
  ).get();
  const schema = ver?.schema_version ?? -1;
  let cached = ownerPageStampTableCache.get(db);
  if (cached === undefined || cached.schema !== schema) {
    const parts: string[] = [];
    if (tableExists(db, "events")) {
      parts.push("(SELECT COUNT(*) || ':' || COALESCE(MAX(rowid), 0) || ':' || COALESCE(SUM(deleted = 1), 0) || ':' || COALESCE(SUM(origin <> 'external'), 0) || ':' || COALESCE(SUM(sensitivity_hint = 'private'), 0) || ':' || COALESCE(SUM(sensitivity_hint = 'personal'), 0) || ':' || COALESCE(SUM(sensitivity_hint IS NULL OR sensitivity_hint NOT IN ('public', 'personal', 'private')), 0) FROM events) AS ev_agg");
    }
    if (tableExists(db, "canon_receipts")) {
      parts.push("(SELECT COUNT(*) || ':' || COALESCE(MAX(rowid), 0) || ':' || COALESCE(SUM(reverted_by IS NOT NULL), 0) || ':' || COALESCE(SUM(receipt_state = 'erased'), 0) FROM canon_receipts) AS cr_agg");
    }
    if (tableExists(db, "canon_source_survivor_lineage")) {
      parts.push("(SELECT COUNT(*) || ':' || COALESCE(MAX(rowid), 0) FROM canon_source_survivor_lineage) AS sl_cnt");
    }
    if (tableExists(db, "canon_holds")) {
      parts.push("(SELECT COUNT(*) || ':' || COALESCE(MAX(rowid), 0) FROM canon_holds) AS ch_cnt");
    }
    if (tableExists(db, "canon_write_intents")) {
      parts.push("(SELECT COUNT(*) || ':' || COALESCE(MAX(rowid), 0) FROM canon_write_intents) AS cwi_cnt");
    }
    if (tableExists(db, "canon_projection_obligations")) {
      parts.push("(SELECT COUNT(*) || ':' || COALESCE(MAX(rowid), 0) FROM canon_projection_obligations) AS cpo_cnt");
    }
    if (tableExists(db, "purge_batches")) {
      parts.push("(SELECT COUNT(*) || ':' || COALESCE(MAX(rowid), 0) FROM purge_batches WHERE state <> 'ready') AS pb_cnt");
    }
    if (tableExists(db, "event_purges")) {
      parts.push("(SELECT COUNT(*) || ':' || COALESCE(MAX(rowid), 0) FROM event_purges) AS ep_cnt");
    }
    if (tableExists(db, "event_classes")) {
      parts.push("(SELECT COUNT(*) || ':' || COALESCE(MAX(event_id), '') FROM event_classes) AS ec_cnt");
    }
    if (tableExists(db, "canon_page_classes")) {
      parts.push("(SELECT COUNT(*) || ':' || COALESCE(SUM(credential), 0) FROM canon_page_classes) AS cpc_cnt");
    }
    if (tableExists(db, "source_grants")) {
      parts.push("(SELECT COALESCE(group_concat(source_key || ':' || revision || ':' || status || ':' || length(policy)), '') FROM source_grants) AS sg_agg");
    }
    if (tableExists(db, "source_store_inventory")) {
      parts.push("(SELECT COALESCE(group_concat(source_key || ':' || COALESCE(erasure_report, '') || ':' || payload_complete), '') FROM source_store_inventory) AS ssi_agg");
    }
    if (tableExists(db, "source_event_bindings")) {
      parts.push("(SELECT COUNT(*) FROM source_event_bindings) AS seb_cnt");
    }
    if (tableExists(db, "claims")) {
      parts.push("(SELECT COUNT(*) || ':' || COALESCE(SUM(status = 'live'), 0) FROM claims) AS cl_agg");
    }
    if (tableExists(db, "claim_v2_support")) {
      parts.push("(SELECT COUNT(*) || ':' || COALESCE(SUM(length(admission)), 0) FROM claim_v2_support) AS c2s_agg");
    }
    if (tableExists(db, "claim_v2_support_events")) {
      parts.push("(SELECT COUNT(*) FROM claim_v2_support_events) AS c2se_cnt");
    }
    if (tableExists(db, "claim_v2_semantics")) {
      parts.push("(SELECT COUNT(*) FROM claim_v2_semantics) AS c2m_cnt");
    }
    if (tableExists(db, "semantic_bindings")) {
      parts.push("(SELECT COUNT(*) FROM semantic_bindings) AS sb_cnt");
    }
    if (tableExists(db, "semantic_allocations")) {
      parts.push("(SELECT COUNT(*) FROM semantic_allocations) AS sa_cnt");
    }
    cached = { schema, sql: parts.length === 0 ? null : `SELECT ${parts.join(", ")}` };
    ownerPageStampTableCache.set(db, cached);
  }
  const counts = cached.sql === null
    ? ""
    : Object.values(db.query<Record<string, number | string>, []>(cached.sql).get() ?? {}).join(":");
  return `${ver?.data_version ?? 0}:${schema}:${canonReadGeneration(db)}:${sourcePolicyEpoch(db)}:${purgeReadEpoch(db)}:${claimsEpoch(db)}:${counts}`;
}

function ownerDecisionCacheKey(
  sourceCtx: ServeContext,
  grant: Grant,
  page: CanonPage,
  read?: CanonReadAccess,
): string | null {
  if (
    read?.allowOwnerDecisionCache !== true ||
    sourceCtx.principal.kind !== "owner" ||
    sourceCtx.selection !== undefined ||
    sourceCtx.db.inTransaction ||
    denyClassesOf(grant).length > 0
  ) {
    return null;
  }
  const stamp = read?.ownerStamp !== undefined ? read.ownerStamp() : ownerPageDecisionStamp(sourceCtx.db);
  if (stamp === null) return null;
  return JSON.stringify([
    resolve(sourceCtx.vaultPath),
    stamp,
    sourceCtx.sourcePurpose ?? "recall",
    grant.ceiling,
    grant.types,
    grant.subjects,
    grant.since,
    grant.until,
    denyClassesOf(grant),
    grant.relay_owner_corrections,
    page.relPath,
    page.id,
    page.contentHash,
    page.data["status"] ?? null,
    page.data["sensitivity"] ?? null,
    page.data["taint"] ?? null,
    page.data["type"] ?? null,
    page.data["subjects"] ?? null,
    page.data["sources"] ?? null,
  ]);
}

function cloneDecision(decision: ReturnType<typeof pageSnapshotDecision>): ReturnType<typeof pageSnapshotDecision> {
  if (!decision.allow) return { allow: false, reason: decision.reason };
  return {
    allow: true,
    sensitivity: decision.sensitivity,
    taint: decision.taint,
    evidence: {
      admitted: true,
      sourceIds: [...decision.evidence.sourceIds],
      revision: { ...decision.evidence.revision },
    },
  };
}

export function pageDecision(
  index: CanonIndex,
  grant: Grant,
  page: CanonPage,
  read?: CanonReadAccess,
): ReturnType<typeof pageSnapshotDecision> {
  if (!selectedPage(index.sourceContext.db, index.sourceContext.selection, stringArray(page.data.sources).map(eventIdFromReference))) return { allow: false, reason: "held" };
  if (index.deniedPaths.has(page.relPath) || index.generation !== canonReadGeneration(index.sourceContext.db) || index.holds.has(page.relPath)) return { allow: false, reason: "held" };
  return pageSnapshotDecision(index.sourceContext, grant, page, false, read);
}

/** The writer checks each exact snapshot before disclosing correction content. */
export function pageSnapshotDecision(
  sourceCtx: ServeContext,
  grant: Grant,
  page: CanonPage,
  historicalSnapshot = false,
  read?: CanonReadAccess,
):
  | { allow: true; sensitivity: Sensitivity; taint: PageTaint; evidence: Extract<LivePageEvidence, { admitted: true }> }
  | { allow: false; reason: DenyReason } {
  const cacheKey = historicalSnapshot ? null : ownerDecisionCacheKey(sourceCtx, grant, page, read);
  const decisionCache = cacheKey === null ? null : ownerDecisionMap(sourceCtx.db);
  if (cacheKey !== null && decisionCache !== null) {
    const cached = decisionCache.get(cacheKey);
    if (cached !== undefined) return cloneDecision(cached);
  }
  // Both labels are read first so the served chunk carries narrowed types
  // instead of casts. A page missing either is withheld from everyone, the
  // owner included: an unstamped page may be verbatim capture, and serving
  // it as canon would hand a reader capture dressed as produced prose.
  const store = (result: ReturnType<typeof pageSnapshotDecision>): ReturnType<typeof pageSnapshotDecision> => {
    if (cacheKey !== null && decisionCache !== null) {
      if (decisionCache.size >= MAX_OWNER_DECISION_CACHE) {
        decisionCache.delete(decisionCache.keys().next().value!);
      }
      decisionCache.set(cacheKey, cloneDecision(result));
    }
    return result;
  };
  const scope = authorize(grant, pageScope(sourceCtx, page, grant));
  if (!scope.allow) return store(scope);
  if (canonReadHeld(sourceCtx, page)) return store({ allow: false, reason: "held" });
  const context = {...sourceCtx,principal:{...sourceCtx.principal,grant}};
  const evidence = read === undefined
    ? assessLivePageEvidence(sourceCtx.db, page, undefined, context, historicalSnapshot)
    : read.evidence(page, context, historicalSnapshot);
  if (!evidence.admitted) return store({ allow: false, reason: "held" });
  if (!sourceEventsAllowed(sourceCtx.db, evidence.sourceIds, { owner: sourceCtx.principal.kind === "owner", purpose: sourceCtx.sourcePurpose ?? "recall", ...(read === undefined ? {} : { grantOf: read.grantOf }) })) return store({ allow: false, reason: "held" });
  const original = sensitivity(page.data["sensitivity"]);
  const label = original === null ? null : sourceSensitivity(sourceCtx.db, evidence.sourceIds, original, read?.grantOf);
  if (label === null) return store({ allow: false, reason: "missing_sensitivity" });
  const recordedTaint = asTaint(page.data["taint"]);
  if (recordedTaint === null) return store({ allow: false, reason: "missing_taint" });
  // Earlier typed model pages may have a receipted clean stamp. Tighten their
  // served trust class without rewriting the immutable receipt or page image.
  const receipt = evidence.revision.authority === "model_inference"
    ? getWorldCanonReceipt(sourceCtx.db, evidence.revision.receipt_id) : null;
  const taint = receipt !== null ? "quoted" : recordedTaint;
  // A page is as old as its evidence and carries the classes of its sources.
  const decision = authorize(grant, {
    ...scopeForSources(sourceCtx, page, evidence.sourceIds, grant),
    sensitivity: label,
  });
  return store(
    decision.allow
      ? { allow: true, sensitivity: label, taint, evidence }
      : { allow: false, reason: decision.reason },
  );
}

export function canonChunk(
  index: CanonIndex,
  page: CanonPage,
  decision: { sensitivity: Sensitivity; taint: PageTaint; evidence?: Extract<LivePageEvidence, { admitted: true }> },
  excerpt: string,
  truncated: boolean,
  preverified = false,
): CanonChunk {
  let evidence: LivePageEvidence;
  if (preverified && decision.evidence !== undefined) {
    evidence = decision.evidence;
  } else {
    assertCanonReadAdmission(index.sourceContext, page);
    if (index.generation !== canonReadGeneration(index.sourceContext.db)) throw new ServeError("held", "canon changed during request; retry");
    evidence = assessLivePageEvidence(index.sourceContext.db, page, undefined, index.sourceContext);
    if (!evidence.admitted || !sourceEventsAllowed(index.sourceContext.db, evidence.sourceIds, {
      owner: index.sourceContext.principal.kind === "owner",
      purpose: index.sourceContext.sourcePurpose ?? "recall",
    })) throw new ServeError("held", "canon evidence unavailable");
  }
  const redactor = redactorOf(index.sourceContext);
  return {
    page_id: redactor.text(page.id),
    path: redactor.text(page.relPath),
    title: redactor.text(stringField(page, "title") ?? ""),
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

/**
 * Code-point safe, so a surrogate pair at the boundary is never split. The
 * body is redacted before it is cut, so a secret straddling the cut is gone
 * whole rather than left half-visible.
 */
export function excerptOf(
  body: string,
  maxChars: number,
  ctx: ServeContext,
  style: "lines" | "inline" = "lines",
): { excerpt: string; truncated: boolean } {
  const bounded = boundScrubText(body, maxChars * 2 + 4096);
  const redactor = redactorOf(ctx);
  const served = redactor.text(bounded.text, { offset: 0, span: maxChars + 1, inline: style === "inline" });
  return {
    excerpt: redactor.text(served, { offset: 0, span: maxChars }),
    truncated: bounded.truncated || Array.from(served).length > maxChars,
  };
}
