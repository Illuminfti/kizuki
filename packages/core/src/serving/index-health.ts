import { resolve } from "node:path";
import type { Database } from "bun:sqlite";
import { authorize, sensitivity, denyClassesOf, type Grant } from "../agents";
import { canonReadGeneration } from "../canon/write-intent";
import { purgeReadEpoch } from "../derived-holds";
import { readDerivedMeta } from "../derived-meta";
import { sourceEventsAllowed, sourcePolicyEpoch, sourceSensitivity } from "../ledger/source-grants";
import { tableExists } from "../ledger/schema";
import { eventIdFromReference } from "../retrieval/ids";
import { timelineSelection } from "../query/timeline";
import type { ServeContext } from "./types";
import type { CanonPage } from "../vault/pages";
import { stringArray } from "../vault/pages";
import { isDeterministicBrief, projectablePageEvidence } from "../vault/provenance";
import { createPageReadAccess, eligible, pageDecision, pageScope, registerServingCacheTrimmer, type CanonIndex } from "./canon";
import type { CanonAccessPhase } from "./canon-access";
import { claimsEpoch } from "./epoch";
import { principalName } from "./gate";

const MAX_INDEX_HEALTH_CACHE = 32;
const MAX_SCOPE_CACHE = 16;

const indexDegradedCache = new Map<string, boolean>();
const ledgerMissingCache = new Map<string, boolean>();
const canonScopeCache = new Map<string, { canonIds: string[]; canonPaths: string[] }>();

function lruSet<T>(cache: Map<string, T>, key: string, value: T, max: number): void {
  if (cache.has(key)) cache.delete(key);
  else if (cache.size >= max) cache.delete(cache.keys().next().value!);
  cache.set(key, value);
}

registerServingCacheTrimmer(() => {
  indexDegradedCache.clear();
  ledgerMissingCache.clear();
  canonScopeCache.clear();
});

/** Owner-only cache of table presence keyed by SQLite schema_version. */
const ownerTableCache = new WeakMap<Database, { schema: number; sql: string | null }>();

/**
 * Owner-only global content version stamp (ignores `agent_audit` writes).
 * Never used for scoped agents so hidden mutations cannot invalidate agent caches.
 */
export function ownerDbStamp(db: Database, allowReadTransaction = false): string | null {
  if (!allowReadTransaction && db.inTransaction) return null;
  const schema = db.query<{ schema_version: number }, []>("PRAGMA schema_version").get()?.schema_version ?? -1;
  let cached = ownerTableCache.get(db);
  if (cached === undefined || cached.schema !== schema) {
    const parts: string[] = [];
    if (tableExists(db, "events")) {
      parts.push("(SELECT COUNT(*) || ':' || COALESCE(MAX(rowid), 0) || ':' || COALESCE(SUM(deleted = 1), 0) FROM events) AS ev_agg");
    }
    if (tableExists(db, "search_documents")) {
      parts.push("(SELECT COUNT(*) FROM search_documents) AS sd_cnt");
    }
    if (tableExists(db, "canon_receipts")) {
      parts.push("(SELECT COUNT(*) FROM canon_receipts) AS cr_cnt");
    }
    if (tableExists(db, "event_purges")) {
      parts.push("(SELECT COUNT(*) FROM event_purges) AS ep_cnt");
    }
    if (tableExists(db, "event_classes")) {
      parts.push("(SELECT COUNT(*) FROM event_classes) AS ec_cnt");
    }
    if (tableExists(db, "claims")) {
      parts.push("(SELECT COUNT(*) FROM claims WHERE status = 'live') AS cl_cnt");
    }
    if (tableExists(db, "canon_holds")) {
      parts.push("(SELECT COUNT(*) FROM canon_holds) AS ch_cnt");
    }
    cached = { schema, sql: parts.length === 0 ? null : `SELECT ${parts.join(", ")}` };
    ownerTableCache.set(db, cached);
  }
  const counts = cached.sql === null
    ? ""
    : Object.values(db.query<Record<string, number>, []>(cached.sql).get() ?? {}).join(":");
  return `${canonReadGeneration(db)}:${sourcePolicyEpoch(db)}:${purgeReadEpoch(db)}:${claimsEpoch(db)}:${counts}`;
}

export function grantCacheKey(ctx: ServeContext, grant: Grant): string {
  return JSON.stringify([
    ctx.principal.kind,
    principalName(ctx.principal),
    ctx.sourcePurpose ?? "recall",
    ctx.selection ?? null,
    grant.ceiling,
    grant.types,
    grant.subjects,
    grant.since,
    grant.until,
    denyClassesOf(grant),
    grant.relay_owner_corrections,
  ]);
}

/**
 * Caller-visible canon stamp: depends strictly on pages, receipts, index rows,
 * source grants, and purges reachable by this caller's grant. Hidden mutations
 * never change this stamp and cannot cause cache-invalidation side channels,
 * while `agent_audit` writes never invalidate consecutive MCP calls.
 */
export function visibleCanonStamp(
  ctx: ServeContext,
  grant: Grant,
  index: CanonIndex,
  allowReadTransaction = false,
): string | null {
  if (!allowReadTransaction && ctx.db.inTransaction) return null;
  const permitted = index.pages.filter(
    (page) => !index.deniedPaths.has(page.relPath) && eligible(page) && authorize(grant, pageScope(ctx, page, grant)).allow,
  );
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(`${permitted.length}:${index.holds.size}\n`);
  const paths: string[] = [];
  const docIds: string[] = [];
  const sourceIdSet = new Set<string>();
  for (const page of permitted) {
    hasher.update(`${page.relPath}\0${page.id}\0${page.contentHash}\n`);
    paths.push(page.relPath);
    docIds.push(`page:${page.id}`);
    for (const ref of stringArray(page.data["sources"])) {
      sourceIdSet.add(eventIdFromReference(ref));
    }
  }
  for (const held of index.holds) hasher.update(`H:${held}\n`);
  const pageDigest = hasher.digest("hex");

  const pathsJson = JSON.stringify(paths);
  const docIdsJson = JSON.stringify(docIds);
  const sourcesJson = JSON.stringify([...sourceIdSet]);

  const hasReceipts = tableExists(ctx.db, "canon_receipts");
  const hasLineage = hasReceipts && tableExists(ctx.db, "canon_source_survivor_lineage");
  const hasSearch = tableExists(ctx.db, "search_documents");
  const hasGrants = tableExists(ctx.db, "source_grants") && tableExists(ctx.db, "source_event_bindings");
  const hasPurges = tableExists(ctx.db, "event_purges");
  const hasEvents = tableExists(ctx.db, "events");
  const hasClasses = tableExists(ctx.db, "event_classes");

  const cols: string[] = [];
  const binds: string[] = [];
  if (hasReceipts) {
    cols.push("(SELECT count(*) FROM canon_receipts WHERE page_path IN (SELECT value FROM json_each(?))) AS r_n");
    cols.push("(SELECT coalesce(max(rowid), 0) FROM canon_receipts WHERE page_path IN (SELECT value FROM json_each(?))) AS r_head");
    binds.push(pathsJson, pathsJson);
  }
  if (hasLineage) {
    cols.push("(SELECT count(*) FROM canon_source_survivor_lineage WHERE child_receipt_id IN (SELECT receipt_id FROM canon_receipts WHERE page_path IN (SELECT value FROM json_each(?)))) AS l_n");
    binds.push(pathsJson);
  }
  if (hasSearch) {
    cols.push("(SELECT count(*) FROM search_documents WHERE scope='canon' AND doc_id IN (SELECT value FROM json_each(?))) AS s_n");
    cols.push("(SELECT coalesce(max(rowid), 0) FROM search_documents WHERE scope='canon' AND doc_id IN (SELECT value FROM json_each(?))) AS s_head");
    binds.push(docIdsJson, docIdsJson);
  }
  if (hasGrants) {
    cols.push(`(SELECT coalesce(group_concat(g.source_key || ':' || g.revision || ':' || g.status || ':' || length(g.policy)), '')
       FROM source_grants g
       WHERE EXISTS (
         SELECT 1 FROM source_event_bindings b
         WHERE b.source_key = g.source_key AND b.event_id IN (SELECT value FROM json_each(?))
       )) AS g_agg`);
    binds.push(sourcesJson);
  }
  if (hasPurges) {
    cols.push("(SELECT count(*) FROM event_purges WHERE event_id IN (SELECT value FROM json_each(?))) AS p_n");
    binds.push(sourcesJson);
  }
  if (hasEvents) {
    cols.push("(SELECT count(*) FROM events WHERE deleted = 1 AND event_id IN (SELECT value FROM json_each(?))) AS d_n");
    binds.push(sourcesJson);
  }
  if (hasClasses) {
    cols.push("(SELECT count(*) FROM event_classes WHERE event_id IN (SELECT value FROM json_each(?))) AS c_n");
    binds.push(sourcesJson);
  }

  const row = cols.length === 0
    ? null
    : ctx.db.query<Record<string, number | string>, string[]>(`SELECT ${cols.join(", ")}`).get(...binds);

  return `${pageDigest}|r=${row?.r_n ?? 0}:${row?.r_head ?? 0}:${row?.l_n ?? 0}|s=${row?.s_n ?? 0}:${row?.s_head ?? 0}|g=${row?.g_agg ?? ""}|p=${row?.p_n ?? 0}:${row?.d_n ?? 0}:${row?.c_n ?? 0}`;
}

/** Cacheable permitted canon IDs/paths for search under one caller-visible snapshot. */
export function cachedSearchCanonScope(
  index: CanonIndex,
  grant: Grant,
  access: CanonAccessPhase,
): { canonIds: string[]; canonPaths: string[]; stamp: string | null } {
  const ctx = index.sourceContext;
  const stamp = visibleCanonStamp(ctx, grant, index);
  const key = stamp === null
    ? null
    : `${resolve(ctx.vaultPath)}|${stamp}|${grantCacheKey(ctx, grant)}`;
  if (key !== null) {
    const cached = canonScopeCache.get(key);
    if (cached !== undefined) {
      return { canonIds: [...cached.canonIds], canonPaths: [...cached.canonPaths], stamp };
    }
  }
  const canonIds = index.pages
    .filter((page) => eligible(page) && access.decision(page).allow)
    .map((page) => `page:${page.id}`);
  const canonPaths = index.pages
    .filter((page) => authorize(grant, pageScope(ctx, page, grant)).allow)
    .map((page) => page.relPath);
  if (key !== null) {
    lruSet(canonScopeCache, key, { canonIds: [...canonIds], canonPaths: [...canonPaths] }, MAX_SCOPE_CACHE);
  }
  return { canonIds, canonPaths, stamp };
}

/** Query health is a property of the caller's visible corpus, never a global stamp. */
export function visibleIndexDegraded(
  index: CanonIndex,
  grant: Grant,
  layer: "search" | "graph",
  pages: readonly CanonPage[] = index.pages,
  access?: CanonAccessPhase,
  precomputedStamp?: string | null,
): boolean {
  if (access !== undefined && !access.appliesTo(index, grant)) access = undefined;
  const ctx = index.sourceContext;
  const stamp = pages === index.pages
    ? (precomputedStamp !== undefined ? precomputedStamp : visibleCanonStamp(ctx, grant, index))
    : null;
  const cacheKey = stamp === null
    ? null
    : `${resolve(ctx.vaultPath)}|${layer}|${stamp}|${grantCacheKey(ctx, grant)}`;
  if (cacheKey !== null) {
    const cached = indexDegradedCache.get(cacheKey);
    if (cached !== undefined) return cached;
  }

  const readAccess = access === undefined ? createPageReadAccess(index, grant) : undefined;
  const grantOf = access === undefined ? readAccess!.grantOf : access.grantOf;

  // Scope and source policy precede all receipt/provenance reconstruction.
  const permitted = pages.filter(page => {
    if (index.deniedPaths.has(page.relPath) || !eligible(page) || isDeterministicBrief(page) || !authorize(grant, pageScope(ctx, page, grant)).allow) return false;
    const sources = stringArray(page.data["sources"]).map(eventIdFromReference);
    if (ctx.principal.kind !== "owner" && sources.length === 0) return false;
    const original = sensitivity(page.data["sensitivity"]);
    return original !== null
      && sourceEventsAllowed(ctx.db, sources, { owner: ctx.principal.kind === "owner", purpose: ctx.sourcePurpose ?? "recall", deny_classes: denyClassesOf(grant), grantOf })
      && authorize(grant, { ...pageScope(ctx, page, grant), sensitivity: sourceSensitivity(ctx.db, sources, original, grantOf) }).allow;
  });
  const projectable = access === undefined ? projectablePageEvidence(ctx.db, permitted)
    : new Set(permitted.filter(page => access.projectable(page)).map(page => page.relPath));
  const exists = layer === "search"
    ? tableExists(ctx.db, "search_documents") && tableExists(ctx.db, "search_docs")
    : tableExists(ctx.db, "graph_edges");

  // Chunked IN-list lookup scoped strictly to permitted pages (noninterference-safe + avoids N per-page SELECTs).
  let indexedCanon: Set<string> | null = null;
  if (layer === "search" && exists && permitted.length > 0) {
    indexedCanon = new Set<string>();
    const stmt = ctx.db.query<{ path: string; doc_id: string }, [string]>(
      "SELECT sd.path, sd.doc_id FROM search_documents sd WHERE sd.scope='canon' AND sd.doc_id IN (SELECT value FROM json_each(?)) AND EXISTS (SELECT 1 FROM search_docs f WHERE f.rowid=sd.rowid AND f.doc_id=sd.doc_id)",
    );
    const docIds = permitted.map((page) => `page:${page.id}`);
    for (let offset = 0; offset < docIds.length; offset += 500) {
      const rows = stmt.all(JSON.stringify(docIds.slice(offset, offset + 500)));
      for (const row of rows) indexedCanon.add(`${row.path}\0${row.doc_id}`);
    }
  }

  const pageContext = { ...ctx, principal: { ...ctx.principal, grant } };
  let degraded = false;
  for (const page of permitted) {
    const evidence = access === undefined ? readAccess!.evidence(page, pageContext, false) : access.evidence(page);
    if (!evidence.admitted && evidence.reason === "sources_unavailable" && ctx.principal.kind !== "owner") continue;
    if (!(access === undefined ? pageDecision(index, grant, page, readAccess) : access.decision(page)).allow || !projectable.has(page.relPath) || !exists) {
      degraded = true;
      break;
    }
    if (layer === "search" && !indexedCanon!.has(`${page.relPath}\0page:${page.id}`)) {
      degraded = true;
      break;
    }
  }
  if (!degraded && layer === "graph") {
    // Graph has no row for an isolated page. A missing generation indicates it was never projected.
    degraded = !readDerivedMeta(ctx.db, "graph") && permitted.some(page => (access === undefined ? pageDecision(index, grant, page, readAccess) : access.decision(page)).allow);
  }

  if (cacheKey !== null) {
    lruSet(indexDegradedCache, cacheKey, degraded, MAX_INDEX_HEALTH_CACHE);
  }
  return degraded;
}

/** Coverage is checked inside the permitted live ledger corpus, before LIMIT. */
export function visibleLedgerIndexMissing(ctx: ServeContext, grant: Grant): boolean {
  const ownerStamp = ctx.principal.kind === "owner" ? ownerDbStamp(ctx.db) : null;
  const cacheKey = ownerStamp === null
    ? null
    : `${resolve(ctx.vaultPath)}|ledger|${ownerStamp}|${grantCacheKey(ctx, grant)}`;
  if (cacheKey !== null) {
    const cached = ledgerMissingCache.get(cacheKey);
    if (cached !== undefined) return cached;
  }
  const missing = timelineSelection(ctx.db, {
    ceiling: grant.ceiling, limit: 1, missingSearchIndex: true,
    ...(grant.types === null ? {} : { kinds: grant.types }),
    ...(grant.subjects === null ? {} : { subjects: grant.subjects }),
    ...(grant.since === null ? {} : { since: grant.since }),
    ...(grant.until === null ? {} : { until: grant.until }),
    source: { owner: ctx.principal.kind === "owner", purpose: ctx.sourcePurpose ?? "recall", deny_classes: denyClassesOf(grant) },
  }).length > 0;
  if (cacheKey !== null) {
    lruSet(ledgerMissingCache, cacheKey, missing, MAX_INDEX_HEALTH_CACHE);
  }
  return missing;
}
