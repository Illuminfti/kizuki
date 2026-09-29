import { sourcePolicyEpoch, isLocalSourcePort } from "../ledger/source-grants";
import { validateGraphResult, validateRetrievalResult } from "../contracts/retrieval";
import type { RetrievalDocKind, RetrievalPort, RetrievalQuery } from "../contracts/retrieval";
import type { GraphEdge, GraphEdgeKind } from "../graph/graph";
import { bareRetrievalId } from "../retrieval/ids";
import { loadEmbeddingSelection } from "../serve/config";
import type { SearchOptions } from "../search/query";
import type { ServeContext } from "./types";

export interface RetrievalCandidates {
  ids: string[];
  degraded: string[];
}

/** `ok` means a graph-capable engine answered; otherwise the caller keeps the local floor. */
export interface RetrievalGraphCandidates extends RetrievalCandidates {
  ok: boolean;
}

/** The only strings about vector ranking that leave the engine. Anything else it reports is `retrieval-degraded`. */
const VECTOR_LABELS: Readonly<Record<string, string>> = {
  "vector-skipped": "retrieval-vector-unavailable",
  "vector-unavailable": "retrieval-vector-unavailable",
  "embedding-space-mismatch": "retrieval-vector-unavailable",
  "vector-backlog": "retrieval-vector-partial",
};

/** Hybrid only when the bound engine reports it can rank by vector; otherwise the lexical floor it always has. */
export function retrievalMode(descriptor: RetrievalPort["descriptor"]): "hybrid" | "lexical" {
  return descriptor.supports.includes("hybrid") && descriptor.supports.includes("vector") ? "hybrid" : "lexical";
}

/** The vault selects an embedding port, so a read that cannot rank by vector must say so. */
function vectorExpected(ctx: ServeContext): boolean {
  return loadEmbeddingSelection(ctx.vaultPath).state === "configured";
}

function publicDegraded(engine: readonly string[]): string[] {
  return [...new Set(engine.map((label) => VECTOR_LABELS[label] ?? "retrieval-degraded"))];
}

/** A derived engine nominates identities. Its cached text never becomes served evidence. */
export async function retrievalCandidates(
  ctx: ServeContext,
  query: string,
  options: SearchOptions,
): Promise<RetrievalCandidates> {
  if (ctx.retrieval === undefined) {
    return { ids: [], degraded: [
      ...(ctx.retrievalUnavailable ? ["retrieval-unavailable", ...(typeof ctx.retrievalUnavailable === "string" ? [ctx.retrievalUnavailable] : [])] : []),
      ...(vectorExpected(ctx) ? ["retrieval-vector-unavailable"] : []),
    ] };
  }
  if (sourcePolicyEpoch(ctx.db) > 0 && !isLocalSourcePort(ctx.retrieval)) return { ids: [], degraded: ["retrieval-source-egress-denied"] };
  // The v1 port has no page-type predicate. Keep that request on the scoped
  // deterministic index rather than spending its window on excluded types.
  if (options.types !== undefined) {
    return { ids: [], degraded: ["retrieval-type-scope-unavailable"] };
  }
  const kinds: RetrievalDocKind[] = options.scope === "canon" ? ["page"]
    : options.scope === "ledger" ? ["event"] : ["page", "event"];
  const mode = retrievalMode(ctx.retrieval.descriptor);
  const request: RetrievalQuery = {
    text: query, mode, scope: { kinds,
      ...(options.subjects === undefined ? {} : { subjects: options.subjects }),
      ...(options.since === undefined ? {} : { since: options.since }),
      ...(options.until === undefined ? {} : { until: options.until }),
    },
    ceiling: options.ceiling,
    limit: Math.min(100, options.limit ?? 20), deadline_ms: 3_000,
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      ctx.retrieval.search(request),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("retrieval deadline")), 3_000);
      }),
    ]);
    let validated;
    try {
      validated = validateRetrievalResult(result, request.limit);
    } catch {
      // Keep the compatibility marker; distinguish invalid success from an
      // unavailable provider without publishing its payload or error text.
      return { ids: [], degraded: ["retrieval-unavailable", "retrieval-invalid-response"] };
    }
    return {
      ids: validated.hits.map((hit) => hit.doc_id),
      // Provider strings are not a public diagnostic channel.
      degraded: [
        ...publicDegraded(validated.degraded),
        // A configured embedding port the engine could not bind is not a lexical-only choice.
        ...(mode === "lexical" && vectorExpected(ctx) ? ["retrieval-vector-unavailable"] : []),
      ],
    };
  } catch {
    return { ids: [], degraded: ["retrieval-unavailable"] };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function unavailableGraph(reason: string): RetrievalGraphCandidates {
  return { ids: [], degraded: [reason], ok: false };
}

const GRAPH_EDGE_KINDS = ["wikilink", "subject", "source"] as const;

function graphEdgeKind(value: string): GraphEdgeKind | undefined {
  return (GRAPH_EDGE_KINDS as readonly string[]).includes(value)
    ? (value as GraphEdgeKind)
    : undefined;
}

/** `ok` means a graph-capable engine answered; otherwise the caller keeps the local floor. */
export interface RetrievalGraphEdges {
  ok: boolean;
  edges: GraphEdge[];
  truncated: boolean;
  degraded: string[];
}

function unavailableEdges(reason: string): RetrievalGraphEdges {
  return { ok: false, edges: [], truncated: false, degraded: [reason] };
}

/**
 * A derived engine nominates graph edges. Provider type, weight, and
 * provenance never become served evidence; core rechecks live identities.
 */
export async function retrievalGraphEdges(
  ctx: ServeContext,
  entityId: string,
  options: { hops: 1 | 2; limit: number; ceiling: SearchOptions["ceiling"] },
): Promise<RetrievalGraphEdges> {
  if (ctx.retrieval === undefined) {
    return {
      ok: false,
      edges: [],
      truncated: false,
      degraded: ctx.retrievalUnavailable
        ? ["retrieval-unavailable", ...(typeof ctx.retrievalUnavailable === "string" ? [ctx.retrievalUnavailable] : [])]
        : [],
    };
  }
  if (sourcePolicyEpoch(ctx.db) > 0 && !isLocalSourcePort(ctx.retrieval)) {
    return unavailableEdges("retrieval-source-egress-denied");
  }
  if (!ctx.retrieval.descriptor.supports.includes("graph")) {
    return unavailableEdges("retrieval-graph-unavailable");
  }
  const limit = Math.min(100, Math.max(0, options.limit));
  if (limit === 0 || entityId.length === 0) {
    return { ok: true, edges: [], truncated: false, degraded: [] };
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      ctx.retrieval.neighbors(
        { entity_id: entityId },
        { hops: options.hops, limit, ceiling: options.ceiling },
      ),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("retrieval deadline")), 3_000);
      }),
    ]);
    const validated = validateGraphResult(result);
    if (validated.entity !== entityId) return unavailableEdges("retrieval-unavailable");
    const edges: GraphEdge[] = [];
    for (const edge of validated.edges) {
      const kind = graphEdgeKind(edge.type);
      if (kind === undefined) continue;
      edges.push({
        src: bareRetrievalId(edge.from),
        dst: bareRetrievalId(edge.to),
        kind,
      });
      if (edges.length === limit) break;
    }
    return {
      ok: true,
      edges,
      truncated: validated.truncated || validated.edges.length > edges.length,
      degraded: [],
    };
  } catch {
    return unavailableEdges("retrieval-unavailable");
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** A derived engine nominates related identities. Edge text never becomes served evidence. */
export async function retrievalGraphCandidates(
  ctx: ServeContext,
  entityId: string,
  options: { ceiling: SearchOptions["ceiling"]; limit: number },
): Promise<RetrievalGraphCandidates> {
  if (ctx.retrieval === undefined) {
    return {
      ids: [],
      degraded: ctx.retrievalUnavailable
        ? ["retrieval-unavailable", ...(typeof ctx.retrievalUnavailable === "string" ? [ctx.retrievalUnavailable] : [])]
        : [],
      ok: false,
    };
  }
  if (sourcePolicyEpoch(ctx.db) > 0 && !isLocalSourcePort(ctx.retrieval)) {
    return unavailableGraph("retrieval-source-egress-denied");
  }
  if (!ctx.retrieval.descriptor.supports.includes("graph")) {
    return unavailableGraph("retrieval-graph-unavailable");
  }
  const limit = Math.min(100, Math.max(0, options.limit));
  if (limit === 0 || entityId.length === 0) return { ids: [], degraded: [], ok: true };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      ctx.retrieval.neighbors(
        { entity_id: entityId },
        { hops: 1, limit, ceiling: options.ceiling },
      ),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("retrieval deadline")), 3_000);
      }),
    ]);
    const validated = validateGraphResult(result);
    if (validated.entity !== entityId) return unavailableGraph("retrieval-unavailable");
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const edge of validated.edges) {
      for (const end of [edge.from, edge.to]) {
        if (end === entityId || seen.has(end)) continue;
        seen.add(end);
        ids.push(end);
        if (ids.length === limit) break;
      }
      if (ids.length === limit) break;
    }
    return { ids, degraded: [], ok: true };
  } catch {
    return unavailableGraph("retrieval-unavailable");
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
