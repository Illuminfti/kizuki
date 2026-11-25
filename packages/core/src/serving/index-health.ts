import { resolve } from "node:path";
import type { Database } from "bun:sqlite";
import { authorize, sensitivity, denyClassesOf, type Grant } from "../agents";
import { auditRowChanges } from "../agents/audit";
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

let indexDegradedByDb = new WeakMap<Database, Map<string, boolean>>();
let ledgerMissingByDb = new WeakMap<Database, Map<string, boolean>>();
let canonScopeByDb = new WeakMap<Database, Map<string, { canonIds: string[]; canonPaths: string[] }>>();

function dbCache<T>(byDb: WeakMap<Database, Map<string, T>>, db: Database): Map<string, T> {
  let cache = byDb.get(db);
  if (cache === undefined) {
    cache = new Map();
    byDb.set(db, cache);
  }
  return cache;
}

function lruSet<T>(cache: Map<string, T>, key: string, value: T, max: number): void {
  if (cache.has(key)) cache.delete(key);
  else if (cache.size >= max) cache.delete(cache.keys().next().value!);
  cache.set(key, value);
}

registerServingCacheTrimmer(() => {
  indexDegradedByDb = new WeakMap();
  ledgerMissingByDb = new WeakMap();
  canonScopeByDb = new WeakMap();
});

/**
 * Owner-only global content version stamp (ignores committed `agent_audit` writes).
 * Never used for scoped agents so hidden mutations cannot invalidate agent caches.
 */
export function ownerDbStamp(db: Database, allowReadTransaction = false): string | null {
  if (!allowReadTransaction && db.inTransaction) return null;
  const ver = db.query<{ dv: number; sv: number; tc: number }, []>(
    "SELECT (SELECT data_version FROM pragma_data_version) AS dv, (SELECT schema_version FROM pragma_schema_version) AS sv, total_changes() AS tc",
  ).get();
  if (ver === null) return null;
  return `${ver.dv}:${ver.sv}:${ver.tc - auditRowChanges(db)}:${canonReadGeneration(db)}:${sourcePolicyEpoch(db)}:${purgeReadEpoch(db)}:${claimsEpoch(db)}`;
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
  const hasSearchFts = hasSearch && tableExists(ctx.db, "search_docs");
  const hasGrants = tableExists(ctx.db, "source_grants") && tableExists(ctx.db, "source_event_bindings");
  const hasInventory = hasGrants && tableExists(ctx.db, "source_store_inventory");
  const hasPurges = tableExists(ctx.db, "event_purges");
  const hasPurgeBatches = tableExists(ctx.db, "purge_batches");
  const hasEvents = tableExists(ctx.db, "events");
  const hasClasses = tableExists(ctx.db, "event_classes");
  const hasPageClasses = tableExists(ctx.db, "canon_page_classes");
  const hasClaimSupport = tableExists(ctx.db, "claim_v2_support_events");

  const pageIdsJson = JSON.stringify(permitted.map((page) => page.id));
  const cols: string[] = [];
  const binds: string[] = [];
  if (hasReceipts) {
    cols.push("(SELECT count(*) || ':' || coalesce(max(rowid), 0) || ':' || coalesce(sum(reverted_by IS NOT NULL), 0) || ':' || coalesce(sum(receipt_state = 'erased'), 0) || ':' || coalesce(group_concat(receipt_id || ':' || coalesce(after_hash, '') || ':' || coalesce(reverted_by, '') || ':' || coalesce(receipt_state, '')), '') FROM canon_receipts WHERE page_path IN (SELECT value FROM json_each(?))) AS r_agg");
    binds.push(pathsJson);
  }
  if (hasLineage) {
    cols.push("(SELECT count(*) FROM canon_source_survivor_lineage WHERE child_receipt_id IN (SELECT receipt_id FROM canon_receipts WHERE page_path IN (SELECT value FROM json_each(?)))) AS l_n");
    binds.push(pathsJson);
  }
  if (hasSearchFts) {
    cols.push("(SELECT count(*) || ':' || coalesce(max(sd.rowid), 0) || ':' || coalesce(sum(length(sd.path)), 0) FROM search_documents sd WHERE sd.scope='canon' AND sd.doc_id IN (SELECT value FROM json_each(?)) AND EXISTS (SELECT 1 FROM search_docs f WHERE f.rowid=sd.rowid AND f.doc_id=sd.doc_id)) AS s_agg");
    binds.push(docIdsJson);
  } else if (hasSearch) {
    cols.push("(SELECT count(*) || ':' || coalesce(max(rowid), 0) FROM search_documents WHERE scope='canon' AND doc_id IN (SELECT value FROM json_each(?))) AS s_agg");
    binds.push(docIdsJson);
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
  if (hasInventory) {
    cols.push(`(SELECT coalesce(group_concat(i.source_key || ':' || coalesce(i.erasure_report, '') || ':' || i.payload_complete), '')
       FROM source_store_inventory i
       WHERE EXISTS (
         SELECT 1 FROM source_event_bindings b
         WHERE b.source_key = i.source_key AND b.event_id IN (SELECT value FROM json_each(?))
       )) AS si_agg`);
    binds.push(sourcesJson);
  }
  if (hasPurges) {
    cols.push("(SELECT count(*) FROM event_purges WHERE event_id IN (SELECT value FROM json_each(?))) AS p_n");
    binds.push(sourcesJson);
  }
  if (hasPurgeBatches) {
    cols.push("(SELECT count(*) FROM purge_batches WHERE state <> 'ready') AS pb_n");
  }
  if (hasEvents) {
    cols.push("(SELECT count(*) FROM events WHERE deleted = 1 AND event_id IN (SELECT value FROM json_each(?))) AS d_n");
    binds.push(sourcesJson);
  }
  if (hasClasses) {
    cols.push("(SELECT count(*) FROM event_classes WHERE event_id IN (SELECT value FROM json_each(?))) AS c_n");
    binds.push(sourcesJson);
  }
  if (hasPageClasses) {
    cols.push("(SELECT count(*) || ':' || coalesce(sum(credential), 0) FROM canon_page_classes WHERE page_id IN (SELECT value FROM json_each(?))) AS pc_agg");
    binds.push(pageIdsJson);
  }
  if (hasClaimSupport) {
    cols.push("(SELECT count(*) FROM claim_v2_support_events WHERE event_id IN (SELECT value FROM json_each(?))) AS cs_n");
    binds.push(sourcesJson);
  }

  const row = cols.length === 0
    ? null
    : ctx.db.query<Record<string, number | string>, string[]>(`SELECT ${cols.join(", ")}`).get(...binds);

  return `${pageDigest}|r=${row?.r_agg ?? ""}:${row?.l_n ?? 0}|s=${hasSearchFts ? 1 : 0}:${row?.s_agg ?? ""}|g=${row?.g_agg ?? ""}|si=${row?.si_agg ?? ""}|p=${row?.p_n ?? 0}:${row?.pb_n ?? 0}:${row?.d_n ?? 0}:${row?.c_n ?? 0}|pc=${row?.pc_agg ?? ""}|cs=${row?.cs_n ?? 0}`;
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
  const scopeCache = key === null ? null : dbCache(canonScopeByDb, ctx.db);
  if (key !== null && scopeCache !== null) {
    const cached = scopeCache.get(key);
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
  if (key !== null && scopeCache !== null) {
    lruSet(scopeCache, key, { canonIds: [...canonIds], canonPaths: [...canonPaths] }, MAX_SCOPE_CACHE);
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
  const graphLayerStamp = layer === "graph"
    ? `|ge=${tableExists(ctx.db, "graph_edges") ? 1 : 0}:${readDerivedMeta(ctx.db, "graph")?.rebuilt_at ?? "none"}`
    : "";
  const cacheKey = stamp === null
    ? null
    : `${resolve(ctx.vaultPath)}|${layer}|${stamp}${graphLayerStamp}|${grantCacheKey(ctx, grant)}`;
  const degradedCache = cacheKey === null ? null : dbCache(indexDegradedByDb, ctx.db);
  if (cacheKey !== null && degradedCache !== null) {
    const cached = degradedCache.get(cacheKey);
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

  if (cacheKey !== null && degradedCache !== null) {
    lruSet(degradedCache, cacheKey, degraded, MAX_INDEX_HEALTH_CACHE);
  }
  return degraded;
}

/** Coverage is checked inside the permitted live ledger corpus, before LIMIT. */
export function visibleLedgerIndexMissing(ctx: ServeContext, grant: Grant): boolean {
  const ownerStamp = ctx.principal.kind === "owner" ? ownerDbStamp(ctx.db) : null;
  const cacheKey = ownerStamp === null
    ? null
    : `${resolve(ctx.vaultPath)}|ledger|${ownerStamp}|${grantCacheKey(ctx, grant)}`;
  const missingCache = cacheKey === null ? null : dbCache(ledgerMissingByDb, ctx.db);
  if (cacheKey !== null && missingCache !== null) {
    const cached = missingCache.get(cacheKey);
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
  if (cacheKey !== null && missingCache !== null) {
    lruSet(missingCache, cacheKey, missing, MAX_INDEX_HEALTH_CACHE);
  }
  return missing;
}
