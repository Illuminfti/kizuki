import { countAgents } from "../agents";
import { listClaims } from "../claims/store";
import { timelineSelection } from "../query/timeline";
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
const CONNECTOR_PAGE = 500;

/** Whether `grant` can read at least one live event of `connectorId`. The scan is bounded like the counts. */
function connectorReadable(ctx: ServeContext, connectorId: string): boolean {
  const grant = ctx.principal.grant;
  let after: { occurred_at: string; event_id: string } | undefined;
  for (let seen = 0; seen < AGENT_VIEW_CAP; seen += CONNECTOR_PAGE) {
    const page = timelineSelection(ctx.db, {
      ceiling: grant.ceiling,
      limit: CONNECTOR_PAGE,
      connector_id: connectorId,
      source: { owner: false, purpose: "recall" },
      ...(after === undefined ? {} : { after }),
      ...(grant.subjects === null ? {} : { subjects: [...grant.subjects] }),
      ...(grant.types === null ? {} : { kinds: [...grant.types] }),
    });
    if (page.length === 0) return false;
    const facts = readServableEvents(ctx.db, page.map((row) => row.event_id));
    for (const row of page) {
      const event = facts.get(row.event_id);
      if (event !== undefined && eventDecision(grant, event, ctx).allow) return true;
    }
    if (page.length < CONNECTOR_PAGE) return false;
    const last = page[page.length - 1]!;
    const lastFacts = facts.get(last.event_id);
    if (lastFacts === undefined) return false;
    after = { occurred_at: lastFacts.occurred_at, event_id: last.event_id };
  }
  return false;
}

/** What `grant` can read of the ledger and the claim store, and the connectors that feed it. */
function readableView(ctx: ServeContext): { events: number; connectors: Set<string>; claims: number; capped: boolean } {
  const grant = ctx.principal.grant;
  const selected = timelineSelection(ctx.db, {
    ceiling: grant.ceiling,
    limit: AGENT_VIEW_CAP,
    source: { owner: false, purpose: "recall" },
    ...(grant.subjects === null ? {} : { subjects: [...grant.subjects] }),
    ...(grant.types === null ? {} : { kinds: [...grant.types] }),
  });
  const facts = readServableEvents(ctx.db, selected.map((row) => row.event_id));
  let events = 0;
  for (const row of selected) {
    const event = facts.get(row.event_id);
    if (event === undefined || !eventDecision(grant, event, ctx).allow) continue;
    events += 1;
  }
  const reader = claimReader(ctx.db, grant, { owner: false, purpose: "recall" });
  const claims = listClaims(ctx.db, { status: "live", limit: AGENT_VIEW_CAP, filter: reader.canRead }).length;
  // Connections do not depend on the count window: each connector is asked on its own.
  const connectors = new Set<string>();
  for (const connection of listConnections(ctx.db)) {
    if (connectorReadable(ctx, connection.connector_id)) connectors.add(connection.connector_id);
  }
  return { events, connectors, claims, capped: selected.length >= AGENT_VIEW_CAP || claims >= AGENT_VIEW_CAP };
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
            connections: listConnections(ctx.db)
              .filter((connection) => view.connectors.has(connection.connector_id))
              .map(({ connector_id, source_key }) => ({ connector_id, source_key })),
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
