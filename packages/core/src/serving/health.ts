import { countAgents } from "../agents";
import { listClaims } from "../claims/store";
import type { Sensitivity, Tool } from "../agents";
import { countClaims, countPendingRetrievalOps } from "../claims/store";
import { readDerivedMeta } from "../derived-meta";
import { getCheckpoint, listConnections } from "../ledger/connections";
import { count } from "../ledger/ledger";
import { readSqliteRuntime } from "../ledger/runtime";
import type { SqliteRuntime } from "../ledger/runtime";
import { claimReader } from "./claims";
import { asSensitivity, asTaint, eligible, loadCanon, pageDecision } from "./canon";
import { auditArguments, gate, principalName } from "./gate";
import type { Served } from "./gate";
import { eventDecision, readServableEvents } from "./ledger";
import { authorizedEventSql } from "../world/policy-sql";
import type { Envelope, ServeContext } from "./types";

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
    /** The four below are owner only. */
    total?: number;
    active?: number;
    labeled?: number;
    /** Pages carrying a taint stamp: an unstamped page is served to nobody. */
    stamped?: number;
    held?: number;
  };
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
/** What the principal reads, counted and listed only after SQL authorization. */
function readableView(ctx: ServeContext): { events: number; connections: { connector_id: string; source_key: string }[]; claims: number; capped: boolean } {
  const grant = ctx.principal.grant;
  const permitted = authorizedEventSql(ctx);
  const where = permitted.clauses.join(" AND ");
  const selected = ctx.db.query<{ event_id: string }, (string | number)[]>(
    `SELECT events.event_id FROM events WHERE ${where} ORDER BY events.event_id LIMIT ?`,
  ).all(...permitted.bindings, AGENT_VIEW_CAP);
  const facts = readServableEvents(ctx.db, selected.map(row => row.event_id));
  let events = 0;
  for (const row of selected) {
    const event = facts.get(row.event_id);
    if (event !== undefined && eventDecision(grant, event, ctx).allow) events += 1;
  }
  const reader = claimReader(ctx.db, grant, { owner: false, purpose: ctx.sourcePurpose ?? "recall" });
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

export function serveHealth(ctx: ServeContext): Envelope<HealthData> {
  return gate(
    ctx,
    "system_health",
    auditArguments({}),
    ({ ctx }): Served<HealthData> => {
      const grant = ctx.principal.grant;
      const index = loadCanon(ctx);

      let active = 0;
      let labeled = 0;
      let stamped = 0;
      let servable = 0;
      for (const page of index.pages) {
        if (asSensitivity(page.data["sensitivity"]) !== null) labeled += 1;
        if (asTaint(page.data["taint"]) !== null) stamped += 1;
        if (!eligible(page)) continue;
        active += 1;
        if (pageDecision(index, grant, page).allow) servable += 1;
      }

      const principal = {
        kind: ctx.principal.kind,
        name: principalName(ctx.principal),
        ceiling: grant.ceiling,
        tools: [...grant.tools],
      };
      if (ctx.principal.kind !== "owner") {
        const view = readableView(ctx);
        return {
          canon: [],
          quoted: [],
          withheld: [],
          data: {
            principal,
            pages: { servable },
            events: view.events,
            live_claims: view.claims,
            ...(view.capped ? { counts_capped: true as const } : {}),
            connections: view.connections,
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
          },
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
  );
}
