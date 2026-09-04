import type { AuditDenial, Grant } from "../agents";
import { neighbors } from "../graph/graph";
import type { GraphEdge, GraphEdgeKind } from "../graph/graph";
import { enumOf, identifier } from "./arguments";
import { eligible, loadCanon, pageDecision, resolveLink } from "./canon";
import { auditArguments, gate } from "./gate";
import type { Served } from "./gate";
import { eventDecision, readServableEvents } from "./ledger";
import { ServeError } from "./types";
import type { Envelope, ServeContext } from "./types";

const GRAPH_EDGE_KINDS = ["wikilink", "subject", "source"] as const;

const MAX_EDGES = 100;

export interface GraphArgs {
  id: string;
  /** A typed caller is held to the bound; `depthOf` re-checks the rest. */
  depth?: 1 | 2;
  kinds?: GraphEdgeKind[];
}

export interface GraphData {
  id: string;
  edges: GraphEdge[];
  truncated: boolean;
}

function depthOf(value: unknown): 1 | 2 {
  if (value === undefined) return 1;
  if (value !== 1 && value !== 2) {
    throw new ServeError(
      "invalid_arguments",
      "invalid arguments: depth: must be 1 or 2",
    );
  }
  return value;
}

function kindsOf(
  value: GraphEdgeKind[] | undefined,
): GraphEdgeKind[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    throw new ServeError(
      "invalid_arguments",
      "invalid arguments: kinds: must be a non-empty array",
    );
  }
  const kinds = value.map((kind) => enumOf("kinds", kind, GRAPH_EDGE_KINDS));
  if (new Set(kinds).size !== kinds.length) {
    throw new ServeError(
      "invalid_arguments",
      "invalid arguments: kinds: must not repeat an entry",
    );
  }
  return kinds;
}

export function serveGraph(
  ctx: ServeContext,
  args: GraphArgs,
): Envelope<GraphData> {
  return gate(
    ctx,
    "graph_neighbors",
    auditArguments(args),
    ({ ctx }): Served<GraphData> => {
      const grant: Grant = ctx.principal.grant;
      const id = identifier("id", args.id);
      const depth = depthOf(args.depth);
      const kinds = kindsOf(args.kinds);

      const index = loadCanon(ctx);
      const root = index.byId.get(id);
      if (root !== undefined) {
        if (!eligible(root)) {
          return {
            canon: [],
            quoted: [],
            withheld: [],
            data: { id, edges: [], truncated: false },
          };
        }
        const decision = pageDecision(index, grant, root);
        if (!decision.allow) {
          return {
            canon: [],
            quoted: [],
            withheld: [{ id: root.id, reason: decision.reason }],
            data: { id, edges: [], truncated: false },
          };
        }
      }

      const found = neighbors(ctx.db, id, {
        depth,
        limit: MAX_EDGES,
        ...(kinds === undefined ? {} : { kinds }),
      });
      const facts = readServableEvents(
        ctx.db,
        found.edges
          .filter((edge) => edge.kind === "source")
          .map((edge) => edge.dst),
      );

      const edges: GraphEdge[] = [];
      const withheld: AuditDenial[] = [];
      for (const edge of found.edges) {
        const source = index.byId.get(edge.src);
        // A stale edge whose page is gone or retracted is dropped, not counted.
        if (source === undefined || !eligible(source)) continue;
        const sourceDecision = pageDecision(index, grant, source);
        if (!sourceDecision.allow) {
          withheld.push({ id: source.id, reason: sourceDecision.reason });
          continue;
        }

        if (edge.kind === "wikilink") {
          const target = resolveLink(index, edge.dst);
          // Unresolved link text is the servable page's own prose.
          if (target === undefined) {
            edges.push(edge);
            continue;
          }
          if (!eligible(target)) continue;
          const targetDecision = pageDecision(index, grant, target);
          if (!targetDecision.allow) {
            withheld.push({ id: target.id, reason: targetDecision.reason });
            continue;
          }
          edges.push(edge);
          continue;
        }

        if (edge.kind === "subject") {
          if (grant.subjects !== null && !grant.subjects.includes(edge.dst)) {
            withheld.push({ id: edge.dst, reason: "subject_out_of_scope" });
            continue;
          }
          edges.push(edge);
          continue;
        }

        const event = facts.get(edge.dst);
        if (event === undefined) continue;
        const eventAccess = eventDecision(grant, event);
        if (!eventAccess.allow) {
          withheld.push({ id: event.event_id, reason: eventAccess.reason });
          continue;
        }
        edges.push(edge);
      }

      return {
        canon: [],
        quoted: [],
        withheld,
        data: {
          id,
          edges: edges.slice(0, MAX_EDGES),
          truncated: found.truncated || edges.length > MAX_EDGES,
        },
      };
    },
  );
}
