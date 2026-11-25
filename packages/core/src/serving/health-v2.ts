import { countClaims, countPendingRetrievalOps } from "../claims/store";
import { listConnections } from "../ledger/connections";
import { count } from "../ledger/ledger";
import { tableExists } from "../ledger/schema";
import { loadConfiguredRetrieval } from "../retrieval/config";
import { authorizedEventSql } from "../world/policy-sql";
import type { Sensitivity, Tool } from "../agents";
import type { CanonIndex } from "./canon";
import { asSensitivity, asTaint, eligible, loadCanon, pageDecision } from "./canon";
import type { MemtHealthSnapshot, ServeContext } from "./types";

export interface HealthV2Rail {
  rail: string;
  status: "healthy" | "running" | "stale" | "degraded" | "idle" | "disabled" | "unknown";
  enabled: boolean;
  last_run_at: string | null;
  last_success_at: string | null;
  interval_s: number | null;
}

export interface HealthV2Data {
  vault_ready: boolean;
  principal: {
    kind: "owner" | "agent";
    ceiling: Sensitivity;
    tools: Tool[];
  };
  counts: {
    servable_pages: number;
    events: number;
    live_claims: number;
    connections: number;
    counts_capped?: true;
  };
  backlog: {
    extract_events: number;
    pending_retrieval_ops: number;
  };
  last_extracted_at: string | null;
  rails: HealthV2Rail[];
  vector_layer: {
    enabled: boolean;
    status: "online" | "offline" | "disabled" | "unknown";
    mode: "vector" | "fts5" | "unknown";
  };
  memt: MemtHealthSnapshot;
  degraded: string[];
}

export interface ScopedViewSummary {
  events: number;
  claims: number;
  connections: number;
  capped: boolean;
}

function readLastExtractedAt(ctx: ServeContext): string | null {
  if (tableExists(ctx.db, "run_receipts")) {
    const row = ctx.db.query<{ ts: string | null }, []>(
      "SELECT MAX(finished_at) AS ts FROM run_receipts WHERE rail = 'extract' AND status IN ('ok', 'completed', 'partial', 'success')",
    ).get();
    if (typeof row?.ts === "string" && row.ts.length > 0) return row.ts;
  }
  if (tableExists(ctx.db, "extract_batches")) {
    const row = ctx.db.query<{ ts: string | null }, []>(
      "SELECT MAX(created_at) AS ts FROM extract_batches WHERE outcome = 'ok'",
    ).get();
    if (typeof row?.ts === "string" && row.ts.length > 0) return row.ts;
  }
  return null;
}

function readRailsV2(ctx: ServeContext): HealthV2Rail[] {
  const hasSchedules = tableExists(ctx.db, "schedules");
  const hasReceipts = tableExists(ctx.db, "run_receipts");
  if (!hasSchedules && !hasReceipts) return [];

  const schedules = hasSchedules
    ? ctx.db.query<{
        rail: string;
        period_s: number;
        enabled: number;
        last_run_at: string | null;
      }, []>("SELECT rail, period_s, enabled, last_run_at FROM schedules ORDER BY rail ASC").all()
    : [];

  const lastReceiptByRail = new Map<string, { finished_at: string; status: string }>();
  const lastSuccessByRail = new Map<string, string>();
  if (hasReceipts) {
    const latest = ctx.db.query<{ rail: string; finished_at: string; status: string }, []>(
      `SELECT r.rail, r.finished_at, r.status FROM run_receipts r
       WHERE NOT EXISTS (
         SELECT 1 FROM run_receipts newer
         WHERE newer.rail = r.rail AND (newer.finished_at, newer.run_id) > (r.finished_at, r.run_id)
       )`,
    ).all();
    for (const row of latest) lastReceiptByRail.set(row.rail, row);
    const successes = ctx.db.query<{ rail: string; ts: string | null }, []>(
      "SELECT rail, MAX(finished_at) AS ts FROM run_receipts WHERE status IN ('ok', 'completed', 'success') GROUP BY rail",
    ).all();
    for (const row of successes) {
      if (row.ts !== null) lastSuccessByRail.set(row.rail, row.ts);
    }
  }

  const railNames = new Set<string>(schedules.map((row) => row.rail));
  for (const rail of lastReceiptByRail.keys()) railNames.add(rail);
  const scheduleByRail = new Map(schedules.map((row) => [row.rail, row]));

  const rails: HealthV2Rail[] = [];
  for (const rail of [...railNames].sort()) {
    const sched = scheduleByRail.get(rail);
    const receipt = lastReceiptByRail.get(rail);
    const enabled = sched === undefined ? true : sched.enabled !== 0;
    const lastRunAt = sched?.last_run_at ?? receipt?.finished_at ?? null;
    const lastSuccessAt = lastSuccessByRail.get(rail) ?? null;
    let status: HealthV2Rail["status"] = "unknown";
    if (!enabled) status = "disabled";
    else if (receipt === undefined) status = lastRunAt === null ? "idle" : "healthy";
    else if (receipt.status === "running") status = "running";
    else if (receipt.status === "ok" || receipt.status === "completed" || receipt.status === "success") status = "healthy";
    else if (receipt.status === "partial" || receipt.status === "stale") status = "stale";
    else status = "degraded";
    rails.push({
      rail,
      status,
      enabled,
      last_run_at: lastRunAt,
      last_success_at: lastSuccessAt,
      interval_s: sched?.period_s ?? null,
    });
  }
  return rails;
}

function readVectorLayer(ctx: ServeContext): HealthV2Data["vector_layer"] {
  let configuredId = "kizuki.retrieval.fts5";
  try {
    configuredId = loadConfiguredRetrieval(ctx.vaultPath).id;
  } catch {
    return { enabled: false, status: "unknown", mode: "unknown" };
  }
  const vectorConfigured = configuredId !== "kizuki.retrieval.fts5";
  if (ctx.retrieval !== undefined) {
    return { enabled: true, status: "online", mode: "vector" };
  }
  if (ctx.retrievalUnavailable !== undefined) {
    return { enabled: vectorConfigured, status: "offline", mode: vectorConfigured ? "vector" : "fts5" };
  }
  return {
    enabled: vectorConfigured,
    status: vectorConfigured ? "unknown" : "disabled",
    mode: vectorConfigured ? "vector" : "fts5",
  };
}

function scopedPendingRetrievalOps(ctx: ServeContext, servablePageIds: readonly string[]): number {
  if (!tableExists(ctx.db, "retrieval_ops")) return 0;
  if (ctx.principal.kind === "owner") return countPendingRetrievalOps(ctx.db);
  const permitted = authorizedEventSql(ctx);
  const where = permitted.clauses.join(" AND ");
  const eventPending = ctx.db.query<{ n: number }, (string | number)[]>(
    `SELECT COUNT(*) AS n FROM retrieval_ops
     WHERE state = 'pending'
       AND doc_id LIKE 'event:%'
       AND EXISTS (
         SELECT 1 FROM events
         WHERE events.event_id = substr(retrieval_ops.doc_id, 7) AND ${where}
       )`,
  ).get(...permitted.bindings)?.n ?? 0;
  const pagePending = servablePageIds.length === 0
    ? 0
    : (ctx.db.query<{ n: number }, [string]>(
        `SELECT COUNT(*) AS n FROM retrieval_ops
         WHERE state = 'pending'
           AND doc_id LIKE 'page:%'
           AND substr(doc_id, 6) IN (SELECT value FROM json_each(?))`,
      ).get(JSON.stringify(servablePageIds))?.n ?? 0);
  return eventPending + pagePending;
}

function scopedExtractBacklog(ctx: ServeContext, lastExtractedAt: string | null): number {
  if (!tableExists(ctx.db, "events")) return 0;
  if (ctx.principal.kind === "owner") {
    const row = lastExtractedAt === null
      ? ctx.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM events WHERE deleted = 0").get()
      : ctx.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM events WHERE deleted = 0 AND accepted_at > ?").get(lastExtractedAt);
    return row?.n ?? 0;
  }
  const permitted = authorizedEventSql(ctx);
  const where = permitted.clauses.join(" AND ");
  const row = lastExtractedAt === null
    ? ctx.db.query<{ n: number }, (string | number)[]>(
        `SELECT COUNT(*) AS n FROM events WHERE ${where}`,
      ).get(...permitted.bindings)
    : ctx.db.query<{ n: number }, (string | number)[]>(
        `SELECT COUNT(*) AS n FROM events WHERE (${where}) AND events.accepted_at > ?`,
      ).get(...permitted.bindings, lastExtractedAt);
  return row?.n ?? 0;
}

export function buildHealthV2(
  ctx: ServeContext,
  viewSummary: ScopedViewSummary | null,
  preloadedIndex?: CanonIndex,
  precomputedServablePageIds?: readonly string[],
): HealthV2Data {
  const index = preloadedIndex ?? loadCanon(ctx);
  const grant = ctx.principal.grant;
  let servablePageIds: readonly string[];
  if (precomputedServablePageIds !== undefined) {
    servablePageIds = precomputedServablePageIds;
  } else {
    const computed: string[] = [];
    for (const page of index.pages) {
      const labeled = asSensitivity(page.data["sensitivity"]) !== null;
      const stamped = asTaint(page.data["taint"]) !== null;
      if (labeled && stamped && eligible(page) && pageDecision(index, grant, page).allow) {
        computed.push(page.id);
      }
    }
    servablePageIds = computed;
  }

  const counts: HealthV2Data["counts"] = ctx.principal.kind === "owner" || viewSummary === null
    ? {
        servable_pages: servablePageIds.length,
        events: count(ctx.db),
        live_claims: countClaims(ctx.db, { status: "live" }),
        connections: listConnections(ctx.db).length,
      }
    : {
        servable_pages: servablePageIds.length,
        events: viewSummary.events,
        live_claims: viewSummary.claims,
        connections: viewSummary.connections,
        ...(viewSummary.capped ? { counts_capped: true as const } : {}),
      };

  const lastExtractedAt = readLastExtractedAt(ctx);
  const backlog = {
    extract_events: scopedExtractBacklog(ctx, lastExtractedAt),
    pending_retrieval_ops: scopedPendingRetrievalOps(ctx, servablePageIds),
  };
  const rails = readRailsV2(ctx);
  const vectorLayer = readVectorLayer(ctx);
  const memt: MemtHealthSnapshot = ctx.memtHealth !== undefined
    ? ctx.memtHealth(ctx)
    : { enabled: false, mode: "unavailable", status: "unavailable" };

  const degraded: string[] = [];
  if (ctx.retrievalUnavailable !== undefined) degraded.push("retrieval_unavailable");
  if (counts.counts_capped) degraded.push("counts_capped");
  if (backlog.extract_events >= 1000) degraded.push("extraction_backlog_high");
  if (backlog.pending_retrieval_ops > 0) degraded.push("retrieval_ops_pending");
  for (const rail of rails) {
    if (rail.status === "degraded" || rail.status === "stale") {
      degraded.push(`rail_${rail.status}:${rail.rail}`);
    }
  }
  if (memt.status === "degraded") degraded.push("memt_degraded");

  return {
    vault_ready: tableExists(ctx.db, "events") && tableExists(ctx.db, "claims") && tableExists(ctx.db, "canon_receipts"),
    principal: {
      kind: ctx.principal.kind,
      ceiling: grant.ceiling,
      tools: [...grant.tools],
    },
    counts,
    backlog,
    last_extracted_at: lastExtractedAt,
    rails,
    vector_layer: vectorLayer,
    memt,
    degraded,
  };
}
