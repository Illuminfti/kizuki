import { resolve } from "node:path";
import { authorize, countAgents } from "../agents";
import { CanonAuthorityResolver } from "../canon/authority";
import { claimReadSql } from "../claims/read-scope";
import { listClaims } from "../claims/store";
import type { Sensitivity, Tool } from "../agents";
import { countClaims, countPendingRetrievalOps } from "../claims/store";
import { readDerivedMeta } from "../derived-meta";
import { getCheckpoint, listConnections } from "../ledger/connections";
import { count, readLiveEvent } from "../ledger/ledger";
import { readSqliteRuntime } from "../ledger/runtime";
import type { SqliteRuntime } from "../ledger/runtime";
import { tableExists } from "../ledger/schema";
import { inspectSourceGrant, type SourceGrant } from "../ledger/source-grants";
import { assessLivePageEvidence } from "../vault/provenance";
import { claimReader } from "./claims";
import { asSensitivity, asTaint, eligible, loadCanon, pageDecision, pageScope, registerServingCacheTrimmer } from "./canon";
import { auditArguments, gate, principalName } from "./gate";
import type { Served } from "./gate";
import { buildHealthV2, type HealthV2Data, type HealthV2Rail } from "./health-v2";
import { grantCacheKey, ownerDbStamp, visibleCanonStamp } from "./index-health";
import { eventDecision, readServableEvents } from "./ledger";
import { authorizedEventSql } from "../world/policy-sql";
import type { ServeContext, ResponseContract, ResponseEnvelope } from "./types";
import { ENVELOPE_SCHEMA, ENVELOPE_V2_SCHEMA } from "./types";

export type { HealthV2Data, HealthV2Rail };

/**
 * The owner sees the vault. An agent sees only counts over what its grant can
 * read, and only the connections that contribute to that view; the fields
 * marked owner-only are absent from its answer.
 */
export interface HealthData {
  /** Owner only. */
  runtime?: SqliteRuntime;
  principal: {
    kind: "owner" | "agent";
    name: string;
    ceiling: Sensitivity;
    tools: Tool[];
  };
  pages: {
    /** Pages this principal may read. */
    servable: number;
    /** The following diagnostics are owner only. */
    total?: number;
    active?: number;
    labeled?: number;
    /** Pages carrying a taint stamp: an unstamped page is served to nobody. */
    stamped?: number;
    held?: number;
    /** Page files the walk could not read or parse; none of them is served. */
    withheld?: number;
  };
  /** Unreadable paths and problems are owner only. */
  withheld_pages?: { path: string; problem: string }[];
  /** Events this principal may read. */
  events: number;
  /**
   * Claims the writer can act on that this principal may read. There is no
   * queue and no `pending`: a filed claim is live until something of higher
   * authority retires it.
   */
  live_claims: number;
  /**
   * Retrieval refreshes a write enqueued and the port has not taken yet
   * (RFC 0002 §4.6). A number above zero means the index is behind the
   * store, not that a write was lost. Owner only.
   */
  pending_retrieval_ops?: number;
  /** Owner only. */
  derived?: { search: string | null; graph: string | null };
  /** An agent gets `connector_id` and `source_key` of the connections it reads from, nothing else. */
  connections: {
    connector_id: string;
    source_key: string;
    connected_at?: string;
    last_run_at?: string | null;
    last_result?: {
      stored: number;
      duplicates: number;
      errors: number;
      proposals_created: number;
      withdrawn: number;
      retractions_filed: number;
    } | null;
  }[];
  /** Present for an agent when `events` or `live_claims` stopped at the bound one call counts to. */
  counts_capped?: true;
  /** Owner only. */
  agents?: { total: number; revoked: number; quarantined: number };
}

/** A bound on what one health call counts, so the call stays cheap on a large ledger. */
const AGENT_VIEW_CAP = 100_000;
const AGENT_VIEW_BATCH = 2_000;
const MAX_HEALTH_SNAPSHOT_CACHE = 16;

interface CachedHealthScan {
  active: number;
  labeled: number;
  stamped: number;
  servable: number;
  servablePageIds: string[];
  view: { events: number; connections: { connector_id: string; source_key: string }[]; claims: number; capped: boolean } | null;
}

const healthScanCache = new Map<string, CachedHealthScan>();
registerServingCacheTrimmer(() => {
  healthScanCache.clear();
});

/** What the principal reads, counted and listed only after SQL authorization. */
function readableView(ctx: ServeContext): { events: number; connections: { connector_id: string; source_key: string }[]; claims: number; capped: boolean } {
  const grant = ctx.principal.grant;
  const permitted = authorizedEventSql(ctx);
  const where = permitted.clauses.join(" AND ");
  const sourceGrants = new Map<string, SourceGrant | null>();
  const grantOf = (sourceKey: string): SourceGrant | null => {
    if (sourceGrants.has(sourceKey)) return sourceGrants.get(sourceKey)!;
    const loaded = inspectSourceGrant(ctx.db, sourceKey);
    sourceGrants.set(sourceKey, loaded);
    return loaded;
  };
  let events = 0;
  let scanned = 0;
  let afterId = "";
  const pageStmt = ctx.db.query<{ event_id: string }, (string | number)[]>(
    `SELECT events.event_id FROM events WHERE (${where}) AND events.event_id > ? ORDER BY events.event_id LIMIT ?`,
  );
  while (scanned < AGENT_VIEW_CAP) {
    const take = Math.min(AGENT_VIEW_BATCH, AGENT_VIEW_CAP - scanned);
    const batch = pageStmt.all(...permitted.bindings, afterId, take);
    if (batch.length === 0) break;
    scanned += batch.length;
    afterId = batch[batch.length - 1]!.event_id;
    const facts = readServableEvents(ctx.db, batch.map(row => row.event_id));
    for (const row of batch) {
      const event = facts.get(row.event_id);
      if (event !== undefined && eventDecision(grant, event, ctx, grantOf).allow) events += 1;
    }
    if (batch.length < take) break;
  }
  const reader = claimReader(ctx.db, grant, { owner: false, purpose: ctx.sourcePurpose ?? "recall", grantOf });
  const claims = listClaims(ctx.db, { status: "live", limit: AGENT_VIEW_CAP, scope: reader.scope, filter: reader.canRead }).length;
  // A connector may have many accounts. Only an exact source binding proves
  // which connection contributed readable evidence; legacy guesses fail closed.
  const connections = ctx.db.query<{ connector_id: string; source_key: string }, (string | number)[]>(`
    SELECT connections.connector_id, connections.source_key FROM connections
    WHERE connections.disconnected_at IS NULL AND EXISTS (
      SELECT 1 FROM source_event_bindings binding JOIN events ON events.event_id=binding.event_id
      WHERE binding.source_key=connections.source_key AND events.connector_id=connections.connector_id AND ${where}
    ) ORDER BY connections.connector_id, connections.source_key
  `).all(...permitted.bindings);
  return { events, connections, claims, capped: events >= AGENT_VIEW_CAP || claims >= AGENT_VIEW_CAP };
}

function visibleHealthStamp(
  ctx: ServeContext,
  index: ReturnType<typeof loadCanon>,
  includeArchived: boolean,
): string | null {
  const grant = ctx.principal.grant;
  if (ctx.principal.kind === "owner") {
    const ownerStamp = ownerDbStamp(ctx.db, true);
    if (ownerStamp === null) return null;
    const hasher = new Bun.CryptoHasher("sha256");
    for (const p of index.pages) hasher.update(`${p.relPath}\0${p.id}\0${p.contentHash}\n`);
    return `${resolve(ctx.vaultPath)}|owner|${includeArchived ? "1" : "0"}|${ownerStamp}|${hasher.digest("hex")}`;
  }
  const canonStamp = visibleCanonStamp(ctx, grant, index, true);
  if (canonStamp === null) return null;
  const permitted = authorizedEventSql(ctx);
  const where = permitted.clauses.join(" AND ");
  const evRow = tableExists(ctx.db, "events")
    ? ctx.db.query<{ n: number; head: number }, (string | number)[]>(
        `SELECT count(*) AS n, coalesce(max(rowid), 0) AS head FROM events WHERE ${where}`,
      ).get(...permitted.bindings)
    : null;
  let claimStamp = "0:0";
  if (tableExists(ctx.db, "claims")) {
    const scope = claimReadSql(ctx.db, {
      grant,
      source: { owner: false, purpose: ctx.sourcePurpose ?? "recall" },
      ...(ctx.selection === undefined ? {} : { selection: ctx.selection }),
    });
    const clRow = ctx.db.query<{ n: number; head: number }, (string | number)[]>(
      `SELECT count(*) AS n, coalesce(max(rowid), 0) AS head FROM claims WHERE status = 'live' AND (${scope.sql})`,
    ).get(...scope.bindings);
    claimStamp = `${clRow?.n ?? 0}:${clRow?.head ?? 0}`;
  }
  const connAgg = tableExists(ctx.db, "connections") && tableExists(ctx.db, "source_event_bindings")
    ? (ctx.db.query<{ agg: string }, (string | number)[]>(
        `SELECT coalesce(group_concat(connections.connector_id || ':' || connections.source_key), '') AS agg
         FROM connections
         WHERE connections.disconnected_at IS NULL AND EXISTS (
           SELECT 1 FROM source_event_bindings binding JOIN events ON events.event_id = binding.event_id
           WHERE binding.source_key = connections.source_key AND events.connector_id = connections.connector_id AND ${where}
         )`,
      ).get(...permitted.bindings)?.agg ?? "")
    : "";
  return `${resolve(ctx.vaultPath)}|agent|${canonStamp}|e=${evRow?.n ?? 0}:${evRow?.head ?? 0}|c=${claimStamp}|k=${connAgg}|${grantCacheKey(ctx, grant)}`;
}

export function serveHealth<C extends ResponseContract = typeof ENVELOPE_SCHEMA>(ctx: ServeContext, contract: C = ENVELOPE_SCHEMA as C): ResponseEnvelope<HealthData, C> {
  return gate(
    ctx,
    "system_health",
    auditArguments({}),
    ({ ctx }): Served<HealthData> => {
      const grant = ctx.principal.grant;
      const includeArchived = ctx.principal.kind === "owner";
      const index = loadCanon(ctx, { include_archived: includeArchived });
      const cacheKey = visibleHealthStamp(ctx, index, includeArchived);

      let scan = cacheKey === null ? undefined : healthScanCache.get(cacheKey);
      if (scan === undefined) {
        // Build one shared authority resolver + source grant / live event caches
        // instead of CanonAccessPhase (which self-invalidates inside transactions).
        const eligiblePaths = index.pages
          .filter((page) => !index.deniedPaths.has(page.relPath) && eligible(page) && authorize(grant, pageScope(ctx, page, grant)).allow)
          .map((page) => page.relPath);
        const resolver = new CanonAuthorityResolver(ctx.db, eligiblePaths);
        const resolverPaths = new Set(eligiblePaths);
        const liveEvents = new Map<string, boolean>();
        const liveExternalEvent = (id: string): boolean => {
          const cached = liveEvents.get(id);
          if (cached !== undefined) return cached;
          const ok = readLiveEvent(ctx.db, id)?.origin === "external";
          if (liveEvents.size < 65_536) liveEvents.set(id, ok);
          return ok;
        };
        const sourceGrants = new Map<string, SourceGrant | null>();
        const grantOf = (sourceKey: string): SourceGrant | null => {
          if (sourceGrants.has(sourceKey)) return sourceGrants.get(sourceKey)!;
          const loaded = inspectSourceGrant(ctx.db, sourceKey);
          sourceGrants.set(sourceKey, loaded);
          return loaded;
        };
        const readAccess = {
          evidence: (page: (typeof index.pages)[number], context: ServeContext, historical = false) =>
            assessLivePageEvidence(
              ctx.db,
              page,
              resolverPaths.has(page.relPath) ? resolver : undefined,
              context,
              historical,
              liveExternalEvent,
            ),
          grantOf,
        };

        let active = 0;
        let labeled = 0;
        let stamped = 0;
        let servable = 0;
        const servablePageIds: string[] = [];
        for (const page of index.pages) {
          const isLabeled = asSensitivity(page.data["sensitivity"]) !== null;
          const isStamped = asTaint(page.data["taint"]) !== null;
          if (isLabeled) labeled += 1;
          if (isStamped) stamped += 1;
          if (!eligible(page)) continue;
          active += 1;
          if (pageDecision(index, grant, page, readAccess).allow) {
            servable += 1;
            if (isLabeled && isStamped) servablePageIds.push(page.id);
          }
        }
        const view = ctx.principal.kind !== "owner" ? readableView(ctx) : null;
        scan = { active, labeled, stamped, servable, servablePageIds, view };
        if (cacheKey !== null) {
          if (healthScanCache.size >= MAX_HEALTH_SNAPSHOT_CACHE) {
            healthScanCache.delete(healthScanCache.keys().next().value!);
          }
          healthScanCache.set(cacheKey, scan);
        }
      }

      const { active, labeled, stamped, servable, servablePageIds, view } = scan;

      const principal = {
        kind: ctx.principal.kind,
        name: principalName(ctx.principal),
        ceiling: grant.ceiling,
        tools: [...grant.tools],
      };
      if (contract === ENVELOPE_V2_SCHEMA) {
        return {
          canon: [],
          quoted: [],
          withheld: [],
          data: buildHealthV2(
            ctx,
            view === null
              ? null
              : {
                  events: view.events,
                  claims: view.claims,
                  connections: view.connections.length,
                  capped: view.capped,
                },
            index,
            servablePageIds,
          ) as unknown as HealthData,
        };
      }

      if (ctx.principal.kind !== "owner") {
        const scoped = view!;
        return {
          canon: [],
          quoted: [],
          withheld: [],
          data: {
            principal,
            pages: { servable },
            events: scoped.events,
            live_claims: scoped.claims,
            ...(scoped.capped ? { counts_capped: true as const } : {}),
            connections: scoped.connections,
          },
        };
      }

      const connections = listConnections(ctx.db).map((connection) => {
        const checkpoint = getCheckpoint(
          ctx.db,
          connection.connector_id,
          connection.source_key,
        );
        return {
          connector_id: connection.connector_id,
          source_key: connection.source_key,
          connected_at: connection.connected_at,
          last_run_at: checkpoint?.last_run_at ?? null,
          // `errors` is a count: the strings can carry paths from a connector.
          last_result:
            checkpoint === null
              ? null
              : {
                  stored: checkpoint.last_result.stored,
                  duplicates: checkpoint.last_result.duplicates,
                  errors: checkpoint.last_result.errors.length,
                  proposals_created: checkpoint.last_result.proposals_created,
                  withdrawn: checkpoint.last_result.withdrawn,
                  retractions_filed: checkpoint.last_result.retractions_filed,
                },
        };
      });

      return {
        canon: [],
        quoted: [],
        withheld: [],
        data: {
          runtime: readSqliteRuntime(ctx.db),
          principal,
          pages: {
            total: index.pages.length,
            active,
            labeled,
            stamped,
            servable,
            held: index.pages.filter((page) => index.holds.has(page.relPath))
              .length,
            withheld: index.withheld.length,
          },
          withheld_pages: index.withheld.map((entry) => ({ path: entry.relPath, problem: entry.reason })),
          events: count(ctx.db),
          live_claims: countClaims(ctx.db, { status: "live" }),
          pending_retrieval_ops: countPendingRetrievalOps(ctx.db),
          derived: {
            search: readDerivedMeta(ctx.db, "search")?.rebuilt_at ?? null,
            graph: readDerivedMeta(ctx.db, "graph")?.rebuilt_at ?? null,
          },
          connections,
          agents: countAgents(ctx.db),
        },
      };
    },
    contract,
  );
}
