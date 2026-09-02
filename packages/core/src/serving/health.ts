import { listAgents } from "../agents";
import type { Sensitivity, Tool } from "../agents";
import { readDerivedMeta } from "../derived-meta";
import { getCheckpoint, listConnections } from "../ledger/connections";
import { count } from "../ledger/ledger";
import { tableExists } from "../ledger/schema";
import { asSensitivity, eligible, loadCanon, pageDecision } from "./canon";
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
    servable: number;
    held: number;
  };
  events: number;
  pending_proposals: number;
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
  agents: { total: number; revoked: number };
}

function pendingProposals(ctx: ServeContext): number {
  if (!tableExists(ctx.db, "proposals")) return 0;
  return (
    ctx.db
      .query<{ count: number }, []>(
        "SELECT count(*) AS count FROM proposals WHERE status = 'pending'",
      )
      .get()?.count ?? 0
  );
}

export function serveHealth(ctx: ServeContext): Envelope<HealthData> {
  return gate(
    ctx,
    "system_health",
    auditArguments({}),
    (): Served<HealthData> => {
      const grant = ctx.principal.grant;
      const index = loadCanon(ctx);

      let active = 0;
      let labeled = 0;
      let servable = 0;
      for (const page of index.pages) {
        if (asSensitivity(page.data["sensitivity"]) !== null) labeled += 1;
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

      const agents = listAgents(ctx.db);
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
            servable,
            held: index.pages.filter((page) => index.holds.has(page.relPath))
              .length,
          },
          events: count(ctx.db),
          pending_proposals: pendingProposals(ctx),
          derived: {
            search: readDerivedMeta(ctx.db, "search")?.rebuilt_at ?? null,
            graph: readDerivedMeta(ctx.db, "graph")?.rebuilt_at ?? null,
          },
          connections,
          agents: {
            total: agents.length,
            revoked: agents.filter((agent) => agent.revoked_at !== null).length,
          },
        },
      };
    },
  );
}
