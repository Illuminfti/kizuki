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
import { assessLivePageEvidence, isDeterministicBrief, projectablePageEvidence } from "../vault/provenance";
import { eligible, pageDecision, pageScope, registerServingCacheTrimmer, type CanonIndex } from "./canon";
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

/**
 * Owner-only global content version stamp (ignores `agent_audit` writes).
 * Never used for scoped agents so hidden mutations cannot invalidate agent caches.
 */
export function ownerDbStamp(db: Database, allowReadTransaction = false): string | null {
  if (!allowReadTransaction && db.inTransaction) return null;
  const parts: string[] = [];
  if (tableExists(db, "events")) {
    parts.push("(SELECT COUNT(*) FROM events) AS ev_cnt");
    parts.push("(SELECT COALESCE(MAX(rowid), 0) FROM events) AS ev_max");
    parts.push("(SELECT COUNT(*) FROM events WHERE deleted = 1) AS ev_del");
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
  const counts = parts.length === 0
    ? ""
    : Object.values(db.query<Record<string, number>, []>(`SELECT ${parts.join(", ")}`).get() ?? {}).join(":");
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

  const receiptRow = tableExists(ctx.db, "canon_receipts")
    ? ctx.db.query<{ n: number; head: number }, [string]>(
        "SELECT count(*) AS n, coalesce(max(rowid), 0) AS head FROM canon_receipts WHERE page_path IN (SELECT value FROM json_each(?))",
      ).get(pathsJson)
    : null;
  const lineageCount = tableExists(ctx.db, "canon_source_survivor_lineage") && tableExists(ctx.db, "canon_receipts")
    ? (ctx.db.query<{ n: number }, [string]>(
        "SELECT count(*) AS n FROM canon_source_survivor_lineage WHERE child_receipt_id IN (SELECT receipt_id FROM canon_receipts WHERE page_path IN (SELECT value FROM json_each(?)))",
      ).get(pathsJson)?.n ?? 0)
    : 0;
  const searchRow = tableExists(ctx.db, "search_documents")
    ? ctx.db.query<{ n: number; head: number }, [string]>(
        "SELECT count(*) AS n, coalesce(max(rowid), 0) AS head FROM search_documents WHERE scope='canon' AND doc_id IN (SELECT value FROM json_each(?))",
      ).get(docIdsJson)
    : null;
  const grantAgg = tableExists(ctx.db, "source_grants") && tableExists(ctx.db, "source_event_bindings")
    ? (ctx.db.query<{ agg: string }, [string]>(
        `SELECT coalesce(group_concat(g.source_key || ':' || g.revision || ':' || g.status || ':' || length(g.policy)), '') AS agg
         FROM source_grants g
         WHERE EXISTS (
           SELECT 1 FROM source_event_bindings b
           WHERE b.source_key = g.source_key AND b.event_id IN (SELECT value FROM json_each(?))
         )`,
      ).get(sourcesJson)?.agg ?? "")
    : "";
  const purgeCount = tableExists(ctx.db, "event_purges")
    ? (ctx.db.query<{ n: number }, [string]>(
        "SELECT count(*) AS n FROM event_purges WHERE event_id IN (SELECT value FROM json_each(?))",
      ).get(sourcesJson)?.n ?? 0)
    : 0;
  const deletedCount = tableExists(ctx.db, "events")
    ? (ctx.db.query<{ n: number }, [string]>(
        "SELECT count(*) AS n FROM events WHERE deleted = 1 AND event_id IN (SELECT value FROM json_each(?))",
      ).get(sourcesJson)?.n ?? 0)
    : 0;
  const classCount = tableExists(ctx.db, "event_classes")
    ? (ctx.db.query<{ n: number }, [string]>(
        "SELECT count(*) AS n FROM event_classes WHERE event_id IN (SELECT value FROM json_each(?))",
      ).get(sourcesJson)?.n ?? 0)
    : 0;

  return `${pageDigest}|r=${receiptRow?.n ?? 0}:${receiptRow?.head ?? 0}:${lineageCount}|s=${searchRow?.n ?? 0}:${searchRow?.head ?? 0}|g=${grantAgg}|p=${purgeCount}:${deletedCount}:${classCount}`;
}

/** Cacheable permitted canon IDs/paths for search under one caller-visible snapshot. */
export function cachedSearchCanonScope(
  index: CanonIndex,
  grant: Grant,
  access: CanonAccessPhase,
): { canonIds: string[]; canonPaths: string[] } {
  const ctx = index.sourceContext;
  const stamp = visibleCanonStamp(ctx, grant, index);
  const key = stamp === null
    ? null
    : `${resolve(ctx.vaultPath)}|${stamp}|${grantCacheKey(ctx, grant)}`;
  if (key !== null) {
    const cached = canonScopeCache.get(key);
    if (cached !== undefined) {
      return { canonIds: [...cached.canonIds], canonPaths: [...cached.canonPaths] };
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
  return { canonIds, canonPaths };
}

/** Query health is a property of the caller's visible corpus, never a global stamp. */
export function visibleIndexDegraded(index: CanonIndex, grant: Grant, layer: "search" | "graph", pages: readonly CanonPage[] = index.pages, access?: CanonAccessPhase): boolean {
  if (access !== undefined && !access.appliesTo(index, grant)) access = undefined;
  const ctx = index.sourceContext;
  const stamp = pages === index.pages ? visibleCanonStamp(ctx, grant, index) : null;
  const cacheKey = stamp === null
    ? null
    : `${resolve(ctx.vaultPath)}|${layer}|${stamp}|${grantCacheKey(ctx, grant)}`;
  if (cacheKey !== null) {
    const cached = indexDegradedCache.get(cacheKey);
    if (cached !== undefined) return cached;
  }

  // Scope and source policy precede all receipt/provenance reconstruction.
  const permitted = pages.filter(page => {
    if (index.deniedPaths.has(page.relPath) || !eligible(page) || isDeterministicBrief(page) || !authorize(grant, pageScope(ctx, page, grant)).allow) return false;
    const sources = stringArray(page.data["sources"]).map(eventIdFromReference);
    if (ctx.principal.kind !== "owner" && sources.length === 0) return false;
    const original = sensitivity(page.data["sensitivity"]);
    return original !== null
      && sourceEventsAllowed(ctx.db, sources, { owner: ctx.principal.kind === "owner", purpose: ctx.sourcePurpose ?? "recall", deny_classes: denyClassesOf(grant), ...(access === undefined ? {} : { grantOf: access.grantOf }) })
      && authorize(grant, { ...pageScope(ctx, page, grant), sensitivity: sourceSensitivity(ctx.db, sources, original, access?.grantOf) }).allow;
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

  let degraded = false;
  for (const page of permitted) {
    const evidence = access === undefined ? assessLivePageEvidence(ctx.db, page, undefined, { ...ctx, principal: { ...ctx.principal, grant } }) : access.evidence(page);
    if (!evidence.admitted && evidence.reason === "sources_unavailable" && ctx.principal.kind !== "owner") continue;
    if (!(access === undefined ? pageDecision(index, grant, page) : access.decision(page)).allow || !projectable.has(page.relPath) || !exists) {
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
    degraded = !readDerivedMeta(ctx.db, "graph") && permitted.some(page => (access === undefined ? pageDecision(index, grant, page) : access.decision(page)).allow);
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
