import { countAgents } from "../agents";
import type { Sensitivity, Tool } from "../agents";
import { countClaims, pendingRetrievalOps } from "../claims/store";
import { readDerivedMeta } from "../derived-meta";
import { getCheckpoint, listConnections } from "../ledger/connections";
import { count } from "../ledger/ledger";
import { asSensitivity, asTaint, eligible, loadCanon, pageDecision } from "./canon";
import { auditArguments, gate, principalName } from "./gate";
import type { Served } from "./gate";
import type { Envelope, ServeContext } from "./types";

export interface HealthData {
  principal: {
    kind: "owner" | "agent";
    name: string;
    ceiling: Sensitivity;
    tools: Tool[];
  };
  pages: {
    total: number;
    active: number;
    labeled: number;
    /** Pages carrying a taint stamp: an unstamped page is served to nobody. */
    stamped: number;
    servable: number;
    held: number;
  };
  events: number;
  /**
   * Claims the writer can act on. There is no queue and no `pending`: a
   * filed claim is live until something of higher authority retires it.
   */
  live_claims: number;
  /**
   * Retrieval refreshes a write enqueued and the port has not taken yet
   * (RFC 0002 §4.6). A number above zero means the index is behind the
   * store, not that a write was lost.
   */
  pending_retrieval_ops: number;
  derived: { search: string | null; graph: string | null };
  connections: {
    connector_id: string;
    source_key: string;
    connected_at: string;
    last_run_at: string | null;
    last_result: {
      stored: number;
      duplicates: number;
      errors: number;
      proposals_created: number;
      withdrawn: number;
      retractions_filed: number;
    } | null;
  }[];
  agents: { total: number; revoked: number; quarantined: number };
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

      const agents = countAgents(ctx.db);
      return {
        canon: [],
        quoted: [],
        withheld: [],
        data: {
          principal: {
            kind: ctx.principal.kind,
            name: principalName(ctx.principal),
            ceiling: grant.ceiling,
            tools: [...grant.tools],
          },
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
          pending_retrieval_ops: pendingRetrievalOps(ctx.db).length,
          derived: {
            search: readDerivedMeta(ctx.db, "search")?.rebuilt_at ?? null,
            graph: readDerivedMeta(ctx.db, "graph")?.rebuilt_at ?? null,
          },
          connections,
          agents,
        },
      };
    },
  );
}
