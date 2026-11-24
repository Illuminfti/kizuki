import { resolve } from "node:path";
import type { Database } from "bun:sqlite";
import { authorize, sensitivity, denyClassesOf, type Grant } from "../agents";
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

export function dbVersionStamp(db: Database): string | null {
  if (db.inTransaction) return null;
  const row = db.query<{ changes: number; version: number; schema: number }, []>(
    "SELECT total_changes() AS changes, (SELECT data_version FROM pragma_data_version) AS version, (SELECT schema_version FROM pragma_schema_version) AS schema",
  ).get();
  return row ? `${row.changes}:${row.version}:${row.schema}` : null;
}

export function canonIndexDigest(index: CanonIndex): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(`${index.generation}:${index.pages.length}:${index.holds.size}:${index.deniedPaths.size}\n`);
  for (const page of index.pages) {
    hasher.update(`${page.relPath}\0${page.id}\0${page.contentHash}\n`);
  }
  for (const held of index.holds) hasher.update(`H:${held}\n`);
  for (const denied of index.deniedPaths) hasher.update(`D:${denied}\n`);
  return hasher.digest("hex");
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

/** Cacheable permitted canon IDs/paths for search under one immutable DB + canon + scope snapshot. */
export function cachedSearchCanonScope(
  index: CanonIndex,
  grant: Grant,
  access: CanonAccessPhase,
): { canonIds: string[]; canonPaths: string[] } {
  const ctx = index.sourceContext;
  const dbStamp = dbVersionStamp(ctx.db);
  const key = dbStamp === null
    ? null
    : `${resolve(ctx.vaultPath)}|${dbStamp}|${sourcePolicyEpoch(ctx.db)}|${purgeReadEpoch(ctx.db)}|${canonIndexDigest(index)}|${grantCacheKey(ctx, grant)}`;
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
  const dbStamp = pages === index.pages ? dbVersionStamp(ctx.db) : null;
  const cacheKey = dbStamp === null
    ? null
    : `${resolve(ctx.vaultPath)}|${layer}|${dbStamp}|${sourcePolicyEpoch(ctx.db)}|${purgeReadEpoch(ctx.db)}|${canonIndexDigest(index)}|${grantCacheKey(ctx, grant)}`;
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
  const dbStamp = dbVersionStamp(ctx.db);
  const cacheKey = dbStamp === null
    ? null
    : `${resolve(ctx.vaultPath)}|ledger|${dbStamp}|${sourcePolicyEpoch(ctx.db)}|${purgeReadEpoch(ctx.db)}|${grantCacheKey(ctx, grant)}`;
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
