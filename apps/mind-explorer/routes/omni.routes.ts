import type { RouteModuleContext, RouteModuleFactory, RouteModuleHandler } from "../contracts.ts";
import type { BoardOmniHit } from "../board-mind-bridge.ts";
import { OmniIndex } from "../omni-index.ts";

declare global {
  // Exposed for Area 6 (command-plane.ts) in-process C4 entity/omni queries
  var __kizukiOmniIndex: OmniIndex | undefined;
}

type SupplementNode = {
  id: string;
  label: string;
  kind: string;
  summary: string;
  updated_at: string | null;
};

const SUPPLEMENT_CACHE_MAX = 256;

function readSqliteDataVersion(db: ReturnType<RouteModuleContext["api"]["getDb"]>): number {
  try {
    const row = db.query("PRAGMA data_version").get() as { data_version?: number } | null;
    return Number(row?.data_version ?? 0) || 0;
  } catch {
    return 0;
  }
}

function supplementNodesFromDb(
  db: ReturnType<RouteModuleContext["api"]["getDb"]>,
  q: string,
  limit: number,
): SupplementNode[] {
  const like = `%${q.trim().replace(/%/g, "").replace(/_/g, "")}%`;
  const out: Array<{ id: string; label: string; kind: string; summary: string; updated_at: string | null }> = [];
  const seen = new Set<string>();
  const isHex = (s: string): boolean => /^[0-9a-f]{16,}$/i.test(s.trim());
  const normKind = (raw: unknown, fallback: string): string => {
    const s = String(raw || "").trim().toLowerCase();
    return s ? s.replace(/^world\./, "") : fallback;
  };
  const clip = (raw: unknown, max: number): string => {
    const s = String(raw ?? "").replace(/\s+/g, " ").trim();
    return s.length <= max ? s : `${s.slice(0, max - 3)}...`;
  };

  try {
    const worldRows = db
      .query(
        `SELECT wc.handle_id,
                wc.kind,
                wc.summary,
                COALESCE(wc.completed_at, wc.created_at) AS updated_at,
                MAX(CASE WHEN s.predicate IN ('concept.label','situation.label','identity.display_name','artifact.label')
                         THEN json_extract(s.payload, '$.object.value') END) AS sem_label
         FROM world_consolidation wc
         LEFT JOIN world_consolidation_basis wcb ON wcb.basis_digest = wc.basis_digest
         LEFT JOIN claim_v2_semantics s ON s.claim_id = wcb.claim_id
         GROUP BY wc.basis_digest
         HAVING wc.summary LIKE ? OR sem_label LIKE ?
         ORDER BY CASE WHEN wc.status = 'complete' THEN 0 ELSE 1 END, updated_at DESC
         LIMIT ?`,
      )
      .all(like, like, limit) as Array<{
      handle_id: string;
      kind: string;
      summary: string | null;
      updated_at: string | null;
      sem_label: string | null;
    }>;

    for (const r of worldRows) {
      if (!r.handle_id || seen.has(r.handle_id)) continue;
      seen.add(r.handle_id);
      const summary = clip(r.summary || "", 260);
      const label =
        (r.sem_label && !isHex(r.sem_label) ? clip(r.sem_label, 72) : "") ||
        clip(summary.split(/[.!?]/)[0] || r.handle_id, 72);
      out.push({
        id: r.handle_id,
        label,
        kind: normKind(r.kind, "concept"),
        summary,
        updated_at: r.updated_at || null,
      });
    }
  } catch {
    // table may not exist in lightweight fixture DBs
  }

  if (out.length < limit) {
    try {
      const semRows = db
        .query(
          `SELECT s.subject_id,
                  MAX(CASE WHEN s.predicate IN ('situation.label','concept.label','identity.display_name','artifact.label')
                           THEN json_extract(s.payload, '$.object.value') END) AS label,
                  MAX(CASE WHEN s.predicate = 'world.kind'
                           THEN json_extract(s.payload, '$.object.ref.id') END) AS world_kind,
                  MAX(CASE WHEN s.predicate IN ('concept.definition','situation.objective','situation.blocker','situation.commitment','situation.change','project.status')
                           THEN json_extract(s.payload, '$.object.value') END) AS detail_text,
                  MAX(c.created_at) AS updated_at
           FROM claim_v2_semantics s
           JOIN claims c ON c.claim_id = s.claim_id AND c.status = 'live'
           WHERE s.subject_id IS NOT NULL
             AND s.payload LIKE ?
           GROUP BY s.subject_id
           ORDER BY updated_at DESC
           LIMIT ?`,
        )
        .all(like, limit - out.length) as Array<{
        subject_id: string;
        label: string | null;
        world_kind: string | null;
        detail_text: string | null;
        updated_at: string | null;
      }>;

      for (const r of semRows) {
        if (!r.subject_id || seen.has(r.subject_id)) continue;
        const label =
          (r.label && !isHex(r.label) ? clip(r.label, 72) : "") ||
          (r.detail_text ? clip(r.detail_text, 64) : "");
        if (!label) continue;
        seen.add(r.subject_id);
        out.push({
          id: r.subject_id,
          label,
          kind: normKind(r.world_kind, "situation"),
          summary: clip(r.detail_text || label, 260),
          updated_at: r.updated_at || null,
        });
      }
    } catch {
      // fail-soft
    }
  }
  return out;
}

const createOmniRoutes: RouteModuleFactory = (ctx: RouteModuleContext): RouteModuleHandler => {
  const omniIndex = new OmniIndex({
    api: ctx.api,
    codexApi: ctx.codexApi,
    tasteApi: ctx.tasteApi,
    agentBoardApi: ctx.agentBoardApi,
    boardBridge: ctx.boardBridge,
  });

  // Bounded LRU cache around warm omni responses keyed by (builtAt, dataVersion, query, limit)
  const omniResponseCache = new Map<string, Record<string, unknown>>();
  const OMNI_RESPONSE_CACHE_MAX = 256;

  // Bounded LRU cache around supplementNodesFromDb keyed by (data_version, query, limit)
  const supplementCache = new Map<string, SupplementNode[]>();
  let supplementCacheVersion = -1;

  const getSupplementNodesCached = (q: string, limit: number): SupplementNode[] => {
    const db = ctx.api.getDb();
    const ver = readSqliteDataVersion(db);
    if (ver !== supplementCacheVersion) {
      supplementCache.clear();
      supplementCacheVersion = ver;
    }
    const cacheKey = `${ver}:${q.trim().toLowerCase()}:${limit}`;
    const hit = supplementCache.get(cacheKey);
    if (hit !== undefined) {
      // Refresh LRU recency
      supplementCache.delete(cacheKey);
      supplementCache.set(cacheKey, hit);
      return hit;
    }
    const fresh = supplementNodesFromDb(db, q, limit);
    if (supplementCache.size >= SUPPLEMENT_CACHE_MAX) {
      const oldestKey = supplementCache.keys().next().value;
      if (oldestKey !== undefined) supplementCache.delete(oldestKey);
    }
    supplementCache.set(cacheKey, fresh);
    return fresh;
  };

  // Expose C4 in-process for Area 6 (command-plane.ts)
  globalThis.__kizukiOmniIndex = omniIndex;

  // Trigger off-request-path warmup after boot settles (unref'd so tests never hang or contend on cold boot)
  const isTestRun =
    process.env.NODE_ENV === "test" ||
    process.env.BUN_ENV === "test" ||
    (typeof Bun !== "undefined" && /\.test\.ts$/.test(String(Bun.main || "")));
  if (!isTestRun) {
    const bootTimer = setTimeout(() => {
      omniIndex.warmInBackground();
    }, 1500);
    if (typeof (bootTimer as unknown as { unref?: () => void }).unref === "function") {
      (bootTimer as unknown as { unref: () => void }).unref();
    }
  }

  return {
    overrides: ["/api/omni", "/api/omni-search"],

    match(req: Request, url: URL): boolean {
      return (
        req.method === "GET" &&
        (url.pathname === "/api/omni" || url.pathname === "/api/omni-search")
      );
    },

    async handle(_req: Request, url: URL): Promise<Response> {
      const q = url.searchParams.get("q") || "";
      const limitParam = url.searchParams.get("limit");
      const limit = limitParam ? Number(limitParam) : 8;
      const safeLimit = Math.max(1, Math.min(30, Number(limit || 8) || 8));

      // Empty query is always an instant O(1) response
      if (!q.trim()) {
        return ctx.json(omniIndex.search("", safeLimit));
      }

      // Warm index serves in <2ms off the request path
      if (omniIndex.isReady()) {
        const stats = omniIndex.getStats();
        const respKey = `${stats.builtAt}:${q.trim().toLowerCase()}:${safeLimit}`;
        const cachedResp = omniResponseCache.get(respKey);
        if (cachedResp) {
          omniResponseCache.delete(respKey);
          omniResponseCache.set(respKey, cachedResp);
          return ctx.json(cachedResp);
        }

        const res = omniIndex.search(q, safeLimit) as Record<string, unknown> & {
          total?: number;
          groups?: Record<string, unknown[]>;
        };
        // If a query misses the in-memory nodes corpus, supplement via data_version-cached bounded SQLite query
        if (q.trim().length >= 3 && res.groups && Array.isArray(res.groups.nodes) && res.groups.nodes.length === 0) {
          try {
            const extraNodes = getSupplementNodesCached(q, safeLimit);
            if (extraNodes.length > 0) {
              res.groups.nodes = extraNodes;
              res.total = Number(res.total || 0) + extraNodes.length;
            }
          } catch {
            // fail-soft
          }
        }
        if (omniResponseCache.size >= OMNI_RESPONSE_CACHE_MAX) {
          const oldestKey = omniResponseCache.keys().next().value;
          if (oldestKey !== undefined) omniResponseCache.delete(oldestKey);
        }
        omniResponseCache.set(respKey, res);
        return ctx.json(res);
      }

      // Cold-start fallback while index finishes background warmup
      if (!isTestRun) {
        omniIndex.warmInBackground();
      }
      const base = await ctx.api.omniSearch(q, safeLimit);
      const trimmedQ = q.trim();
      const codexHits = trimmedQ ? ctx.codexApi.searchForOmni(trimmedQ, safeLimit) : [];
      let boardHits: BoardOmniHit[] = [];
      if (trimmedQ) {
        try {
          boardHits = ctx.boardBridge.searchForOmni(trimmedQ, safeLimit);
        } catch {
          boardHits = [];
        }
      }

      return ctx.json({
        ...base,
        total: base.total + codexHits.length + boardHits.length,
        codex: codexHits,
        board: boardHits,
        groups: {
          ...base.groups,
          codex: codexHits,
          board: boardHits,
        },
      });
    },
  };
};

export default createOmniRoutes;
