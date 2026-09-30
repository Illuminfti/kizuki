import type { AuditDenial, Grant } from "../agents";
import { neighbors } from "../graph/graph";
import type { GraphEdge, GraphEdgeKind } from "../graph/graph";
import { enumOf, identifier } from "./arguments";
import { eligible, loadCanon, pageDecision } from "./canon";
import type { CanonIndex } from "./canon";
import { auditArguments, gateAsync } from "./gate";
import type { Served } from "./gate";
import { eventDecision, readServableEvents } from "./ledger";
import type { ServableEvent } from "./ledger";
import { retrievalGraphEdges } from "./retrieval";
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

type PageDecision = ReturnType<typeof pageDecision>;

function edgeKey(edge: GraphEdge): string {
  return `${edge.src}\u0000${edge.dst}\u0000${edge.kind}`;
}

function classifyGraph(
  edges: GraphEdge[],
  index: CanonIndex,
  grant: Grant,
  facts: Map<string, ServableEvent>,
  seen: Set<string>,
  collect: boolean,
  decisions: Map<string, PageDecision>,
  allowUnresolvedWikilink: boolean,
): { kept: GraphEdge[]; withheld: AuditDenial[] } {
  const kept: GraphEdge[] = [];
  const withheld: AuditDenial[] = [];
  const decisionFor = (page: CanonIndex["pages"][number]): PageDecision => {
    const cached = decisions.get(page.id);
    if (cached !== undefined) return cached;
    const resolved = pageDecision(index, grant, page);
    decisions.set(page.id, resolved);
    return resolved;
  };
  for (const edge of edges) {
    const key = edgeKey(edge);
    if (seen.has(key)) continue;
    seen.add(key);

    const source = index.byId.get(edge.src);
    // A stale edge whose page is gone or retracted is dropped, not counted.
    if (source === undefined || !eligible(source)) continue;
    const sourceDecision = decisionFor(source);
    if (!sourceDecision.allow) {
      withheld.push({ id: source.id, reason: sourceDecision.reason });
      continue;
    }

    switch (edge.kind) {
      case "wikilink": {
        const target = index.byId.get(edge.dst);
        // Raw leftover text is the servable page's own prose. Resolution
        // already happened at index time.
        if (target === undefined) {
          if (collect && allowUnresolvedWikilink) kept.push(edge);
          continue;
        }
        if (!eligible(target)) continue;
        const targetDecision = decisionFor(target);
        if (!targetDecision.allow) {
          withheld.push({ id: target.id, reason: targetDecision.reason });
          continue;
        }
        if (collect) kept.push(edge);
        continue;
      }
      case "subject": {
        if (grant.subjects !== null && !grant.subjects.includes(edge.dst)) {
          withheld.push({ id: edge.dst, reason: "subject_out_of_scope" });
          continue;
        }
        if (collect) kept.push(edge);
        continue;
      }
      case "source": {
        const event = facts.get(edge.dst);
        if (event === undefined) continue;
        const eventAccess = eventDecision(grant, event, index.sourceContext);
        if (!eventAccess.allow) {
          withheld.push({ id: event.event_id, reason: eventAccess.reason });
          continue;
        }
        if (collect) kept.push(edge);
        continue;
      }
      default: {
        const _exhaustive: never = edge.kind;
        throw new Error(`unexpected graph edge kind: ${_exhaustive}`);
      }
    }
  }
  return { kept, withheld };
}

export async function serveGraph(
  ctx: ServeContext,
  args: GraphArgs,
): Promise<Envelope<GraphData>> {
  return gateAsync(
    ctx,
    "graph_neighbors",
    auditArguments(args),
    async ({ ctx }): Promise<Served<GraphData>> => {
      const grant: Grant = ctx.principal.grant;
      const id = identifier("id", args.id);
      const depth = depthOf(args.depth);
      const kinds = kindsOf(args.kinds);

      const walked =
        kinds === undefined
          ? await retrievalGraphEdges(ctx, id, {
              hops: depth,
              limit: MAX_EDGES,
              ceiling: grant.ceiling,
            })
          : { ok: false as const, edges: [], truncated: false, degraded: [] };
      // Re-read current canon only after the engine finishes.
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

      const query = {
        depth,
        limit: MAX_EDGES,
        ...(kinds === undefined ? {} : { kinds }),
      };
      const authorizedDecisions = new Map<string, PageDecision>();
      const authorizedDenials: AuditDenial[] = [];
      const accept = (edge: GraphEdge): boolean => {
        const facts = readServableEvents(ctx.db, edge.kind === "source" ? [edge.dst] : []);
        const classified = classifyGraph([edge], index, grant, facts, new Set(), true, authorizedDecisions, true);
        const allow = classified.kept.length > 0;
        if (authorizedDenials.length < MAX_EDGES) authorizedDenials.push(...classified.withheld);
        return allow;
      };
      let scopedTruncated = false;
      const scopedFloor = () => {
        const result = neighbors(ctx.db, id, { ...query, ceiling: grant.ceiling, filter: accept });
        scopedTruncated ||= result.truncated;
        return result;
      };
      const found = walked.ok
        ? {
            id,
            edges: walked.edges,
            truncated: walked.truncated,
          }
        : ctx.principal.kind === "owner"
          ? neighbors(ctx.db, id, { ...query, ceiling: grant.ceiling })
          : scopedFloor();
      const foundKeys = new Set(found.edges.map(edgeKey));
      // Ceiling shapes the served cap on the local floor. A configured
      // engine already applied the requested ceiling; core still authorizes.
      const auditEdges =
        ctx.principal.kind !== "owner" || walked.ok || grant.ceiling === undefined
          ? []
          : neighbors(ctx.db, id, query).edges.filter(
              (edge) => !foundKeys.has(edgeKey(edge)),
            );
      const facts = readServableEvents(
        ctx.db,
        [...found.edges, ...auditEdges]
          .filter((edge) => edge.kind === "source")
          .map((edge) => edge.dst),
      );
      const seen = new Set<string>();
      const decisions = new Map<string, PageDecision>();
      const served = classifyGraph(
        found.edges,
        index,
        grant,
        facts,
        seen,
        true,
        decisions,
        !walked.ok,
      );
      // A provider's raw overflow cannot reveal how many of its unseen edges
      // survive Core authorization. The local floor can prove scoped overflow.
      if (walked.ok && walked.truncated && ctx.principal.kind !== "owner") {
        const floor = scopedFloor();
        const extra = classifyGraph(floor.edges, index, grant,
          readServableEvents(ctx.db, floor.edges.filter(edge => edge.kind === "source").map(edge => edge.dst)),
          seen, true, decisions, true);
        served.kept.push(...extra.kept);
        served.withheld.push(...extra.withheld);
      }
      const hidden = classifyGraph(
        auditEdges,
        index,
        grant,
        facts,
        seen,
        false,
        decisions,
        !walked.ok,
      );

      return {
        canon: [],
        quoted: [],
        withheld: [...served.withheld, ...hidden.withheld, ...authorizedDenials],
        data: {
          id,
          edges: served.kept.slice(0, MAX_EDGES),
          truncated: (ctx.principal.kind === "owner" ? found.truncated : scopedTruncated) || served.kept.length > MAX_EDGES,
        },
      };
    },
  );
}
