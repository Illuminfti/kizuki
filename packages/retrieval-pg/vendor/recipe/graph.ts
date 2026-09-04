import type { RecipeEdge, RecipeGraphWalk } from "./types";

/** In-set adjacency multiplier from the public tip graph-signals stage. */
export const ADJACENCY_BOOST = 1.05;
export const ADJACENCY_MIN_HITS = 2;
export const DEFAULT_TOP_K = 20;
const MAX_WALK_DEPTH = 2;
const NEIGHBOR_CAP_PER_HOP = 50;

export interface AdjacencyTarget {
  readonly id: string;
  score: number;
}

/**
 * Apply the in-set adjacency hub boost. A node linked from at least
 * ADJACENCY_MIN_HITS other nodes in the current top-K is a query hub.
 * Floor-gated: rows below floorThreshold are not boosted.
 *
 * Kizuki modification: unlabeled / invisible nodes are excluded by the
 * caller-supplied visible predicate. There is no fail-open path.
 */
export function applyAdjacencyBoost<T extends AdjacencyTarget>(
  results: readonly T[],
  edges: readonly RecipeEdge[],
  visible: (id: string) => boolean,
  opts?: { topK?: number; floorThreshold?: number },
): T[] {
  if (results.length === 0) return [];
  const topK = opts?.topK ?? DEFAULT_TOP_K;
  const floor = opts?.floorThreshold;
  const window = results.slice(0, topK);
  const ids = window.map((row) => row.id);
  const adjacency = new Map<string, Set<string>>();
  const link = (from: string, to: string): void => {
    if (from === to || !visible(from) || !visible(to)) return;
    const neighbors = adjacency.get(from) ?? new Set<string>();
    neighbors.add(to);
    adjacency.set(from, neighbors);
  };
  for (const edge of edges) {
    link(edge.from, edge.to);
    link(edge.to, edge.from);
  }

  const inbound = new Map<string, number>();
  for (const id of ids) {
    const neighbors = adjacency.get(id) ?? new Set<string>();
    let hits = 0;
    for (const other of ids) {
      if (other === id) continue;
      if (neighbors.has(other)) {
        hits += 1;
        continue;
      }
      const otherNeighbors = adjacency.get(other) ?? new Set<string>();
      for (const shared of neighbors) {
        if (otherNeighbors.has(shared)) {
          hits += 1;
          break;
        }
      }
    }
    inbound.set(id, hits);
  }

  return results.map((row) => {
    if (floor !== undefined && row.score < floor) return { ...row };
    const hits = inbound.get(row.id) ?? 0;
    if (hits < ADJACENCY_MIN_HITS) return { ...row };
    return { ...row, score: row.score * ADJACENCY_BOOST };
  });
}

/**
 * Hop-limited neighbor walk. Depth is capped at 2. Invisible nodes are
 * skipped (fail closed). Truncates when the collected edge count reaches
 * the caller limit.
 */
export function walkNeighbors(
  start: string,
  edges: readonly RecipeEdge[],
  opts: {
    hops: number;
    limit: number;
    visible: (id: string) => boolean;
  },
): RecipeGraphWalk {
  const depth = Math.min(Math.max(opts.hops, 0), MAX_WALK_DEPTH);
  if (depth < 1 || opts.limit < 1 || !opts.visible(start)) {
    return { edges: [], truncated: false };
  }

  const collected: RecipeEdge[] = [];
  const seen = new Set<string>([start]);
  let frontier = [start];

  for (let hop = 0; hop < depth; hop += 1) {
    const next: string[] = [];
    let hopCount = 0;
    for (const node of frontier) {
      for (const edge of edges) {
        if (edge.from !== node && edge.to !== node) continue;
        const other = edge.from === node ? edge.to : edge.from;
        if (!opts.visible(other)) continue;
        collected.push(edge);
        if (collected.length >= opts.limit) {
          return { edges: collected.slice(0, opts.limit), truncated: true };
        }
        if (!seen.has(other) && hopCount < NEIGHBOR_CAP_PER_HOP) {
          seen.add(other);
          next.push(other);
          hopCount += 1;
        }
      }
    }
    if (next.length === 0) break;
    frontier = next;
  }

  return { edges: collected, truncated: false };
}
