import {
  maxOntologySensitivity,
  termMatchesAllowedSubjects,
  withinOntologySensitivity,
} from "./types";
import type {
  OntologyRelation,
  OntologySensitivity,
  OntologyTerm,
} from "./types";

export interface JoinPathEdge {
  readonly relationId: string;
  readonly fromTermId: string;
  readonly toTermId: string;
  readonly relationKind: string;
  readonly direction: "forward" | "reverse";
  readonly evidenceCount: number;
  readonly confidence: number;
  readonly isDefaultJoin: boolean;
  readonly sensitivity: OntologySensitivity;
}

export interface JoinPath {
  readonly fromTermId: string;
  readonly toTermId: string;
  readonly hops: number;
  readonly edges: JoinPathEdge[];
  readonly nodeIds: string[];
  readonly pathString: string;
  readonly totalEvidence: number;
  readonly allDefaultJoins: boolean;
  readonly maxSensitivity: OntologySensitivity;
}

export interface FindJoinPathOptions {
  readonly sensitivityCeiling?: OntologySensitivity | undefined;
  readonly maxHops?: number | undefined;
  readonly termMap?: ReadonlyMap<string, OntologyTerm> | undefined;
  readonly allowedSubjects?: readonly string[] | null | undefined;
  readonly preferDefaultJoins?: boolean | undefined;
}

interface SearchState {
  readonly nodeId: string;
  readonly hops: number;
  readonly nonDefaultCount: number;
  readonly totalEvidence: number;
  readonly edges: JoinPathEdge[];
  readonly nodeIds: string[];
  readonly maxSensitivity: OntologySensitivity;
  readonly lexicalKey: string;
}

function isNodeAllowed(
  nodeId: string,
  ceiling: OntologySensitivity | undefined,
  termMap: ReadonlyMap<string, OntologyTerm> | undefined,
  allowedSubjects: readonly string[] | null | undefined,
): boolean {
  if (termMap === undefined) {
    // Without a termMap, subject restrictions cannot be proven; fail closed on empty array.
    if (allowedSubjects !== undefined && allowedSubjects !== null && allowedSubjects.length === 0) {
      return false;
    }
    return true;
  }
  const term = termMap.get(nodeId);
  if (term === undefined) return false;
  if (ceiling !== undefined && !withinOntologySensitivity(term.sensitivity, ceiling)) {
    return false;
  }
  if (!termMatchesAllowedSubjects(term, allowedSubjects)) {
    return false;
  }
  return true;
}

function compareStates(a: SearchState, b: SearchState, preferDefault: boolean): number {
  if (a.hops !== b.hops) return a.hops - b.hops;
  if (preferDefault && a.nonDefaultCount !== b.nonDefaultCount) {
    return a.nonDefaultCount - b.nonDefaultCount;
  }
  if (a.totalEvidence !== b.totalEvidence) {
    return b.totalEvidence - a.totalEvidence;
  }
  return a.lexicalKey.localeCompare(b.lexicalKey);
}

export function formatJoinPath(
  nodeIds: readonly string[],
  edges: readonly JoinPathEdge[],
  termMap?: ReadonlyMap<string, OntologyTerm>,
): string {
  const label = (id: string): string => termMap?.get(id)?.canonicalName ?? id;
  if (nodeIds.length === 0) return "";
  const first = nodeIds[0];
  if (first === undefined) return "";
  if (edges.length === 0) return label(first);

  const parts: string[] = [label(first)];
  for (const edge of edges) {
    const arrow =
      edge.direction === "forward"
        ? `--[${edge.relationKind}]-->`
        : `<--[${edge.relationKind}]--`;
    parts.push(arrow, label(edge.toTermId));
  }
  return parts.join(" ");
}

/**
 * Shortest-path BFS over ontology relations with deterministic preference for
 * `isDefaultJoin = true` and higher `evidenceCount`. Strictly enforces
 * `sensitivityCeiling` (and `allowedSubjects` when `termMap` is supplied) on
 * every traversed edge and every endpoint/intermediate node.
 */
export function findJoinPath(
  relations: readonly OntologyRelation[],
  fromTermId: string,
  toTermId: string,
  opts: FindJoinPathOptions = {},
): JoinPath | null {
  const maxHops = opts.maxHops ?? 6;
  const ceiling = opts.sensitivityCeiling;
  const termMap = opts.termMap;
  const allowedSubjects = opts.allowedSubjects;
  const preferDefault = opts.preferDefaultJoins ?? true;

  if (
    !isNodeAllowed(fromTermId, ceiling, termMap, allowedSubjects) ||
    !isNodeAllowed(toTermId, ceiling, termMap, allowedSubjects)
  ) {
    return null;
  }

  const startSens: OntologySensitivity =
    termMap?.get(fromTermId)?.sensitivity ?? "public";

  if (fromTermId === toTermId) {
    return {
      fromTermId,
      toTermId,
      hops: 0,
      edges: [],
      nodeIds: [fromTermId],
      pathString: formatJoinPath([fromTermId], [], termMap),
      totalEvidence: 0,
      allDefaultJoins: true,
      maxSensitivity: startSens,
    };
  }

  if (maxHops <= 0) return null;

  // Build undirected adjacency list with strict sensitivity & node filtering.
  const adjacency = new Map<string, JoinPathEdge[]>();
  const addAdj = (node: string, edge: JoinPathEdge): void => {
    let list = adjacency.get(node);
    if (list === undefined) {
      list = [];
      adjacency.set(node, list);
    }
    list.push(edge);
  };

  for (const rel of relations) {
    if (ceiling !== undefined && !withinOntologySensitivity(rel.sensitivity, ceiling)) {
      continue;
    }
    if (
      !isNodeAllowed(rel.sourceTermId, ceiling, termMap, allowedSubjects) ||
      !isNodeAllowed(rel.targetTermId, ceiling, termMap, allowedSubjects)
    ) {
      continue;
    }
    if (rel.sourceTermId === rel.targetTermId) continue;

    addAdj(rel.sourceTermId, {
      relationId: rel.relationId,
      fromTermId: rel.sourceTermId,
      toTermId: rel.targetTermId,
      relationKind: rel.relationKind,
      direction: "forward",
      evidenceCount: rel.evidenceCount,
      confidence: rel.confidence,
      isDefaultJoin: rel.isDefaultJoin,
      sensitivity: rel.sensitivity,
    });
    addAdj(rel.targetTermId, {
      relationId: rel.relationId,
      fromTermId: rel.targetTermId,
      toTermId: rel.sourceTermId,
      relationKind: rel.relationKind,
      direction: "reverse",
      evidenceCount: rel.evidenceCount,
      confidence: rel.confidence,
      isDefaultJoin: rel.isDefaultJoin,
      sensitivity: rel.sensitivity,
    });
  }

  // Sort adjacency lists so traversal order is deterministic.
  for (const list of adjacency.values()) {
    list.sort((a, b) => {
      if (preferDefault && a.isDefaultJoin !== b.isDefaultJoin) {
        return a.isDefaultJoin ? -1 : 1;
      }
      if (a.evidenceCount !== b.evidenceCount) {
        return b.evidenceCount - a.evidenceCount;
      }
      if (a.confidence !== b.confidence) {
        return b.confidence - a.confidence;
      }
      return a.relationId.localeCompare(b.relationId);
    });
  }

  // Layered BFS: expand level by level; within each hop depth keep the best
  // state per reached node according to compareStates.
  const bestAtDepth = new Map<string, SearchState>();
  const startState: SearchState = {
    nodeId: fromTermId,
    hops: 0,
    nonDefaultCount: 0,
    totalEvidence: 0,
    edges: [],
    nodeIds: [fromTermId],
    maxSensitivity: startSens,
    lexicalKey: fromTermId,
  };
  bestAtDepth.set(fromTermId, startState);

  let frontier: SearchState[] = [startState];
  const finalized = new Set<string>([fromTermId]);

  for (let depth = 1; depth <= maxHops && frontier.length > 0; depth += 1) {
    const nextLayer = new Map<string, SearchState>();

    for (const current of frontier) {
      const outEdges = adjacency.get(current.nodeId);
      if (outEdges === undefined) continue;

      for (const edge of outEdges) {
        const nextNode = edge.toTermId;
        if (finalized.has(nextNode)) continue;
        if (current.nodeIds.includes(nextNode)) continue;

        const nextNodeSens = termMap?.get(nextNode)?.sensitivity ?? "public";
        const nextMaxSens = maxOntologySensitivity(
          maxOntologySensitivity(current.maxSensitivity, edge.sensitivity),
          nextNodeSens,
        );
        const candidate: SearchState = {
          nodeId: nextNode,
          hops: depth,
          nonDefaultCount: current.nonDefaultCount + (edge.isDefaultJoin ? 0 : 1),
          totalEvidence: current.totalEvidence + edge.evidenceCount,
          edges: [...current.edges, edge],
          nodeIds: [...current.nodeIds, nextNode],
          maxSensitivity: nextMaxSens,
          lexicalKey: `${current.lexicalKey}|${edge.relationId}|${nextNode}`,
        };

        const existing = nextLayer.get(nextNode);
        if (
          existing === undefined ||
          compareStates(candidate, existing, preferDefault) < 0
        ) {
          nextLayer.set(nextNode, candidate);
        }
      }
    }

    const goal = nextLayer.get(toTermId);
    if (goal !== undefined) {
      return {
        fromTermId,
        toTermId,
        hops: goal.hops,
        edges: goal.edges,
        nodeIds: goal.nodeIds,
        pathString: formatJoinPath(goal.nodeIds, goal.edges, termMap),
        totalEvidence: goal.totalEvidence,
        allDefaultJoins: goal.nonDefaultCount === 0,
        maxSensitivity: goal.maxSensitivity,
      };
    }

    frontier = [...nextLayer.values()].sort((a, b) =>
      compareStates(a, b, preferDefault),
    );
    for (const state of frontier) {
      finalized.add(state.nodeId);
      bestAtDepth.set(state.nodeId, state);
    }
  }

  return null;
}

/**
 * Finds concise data-confirmed connecting join paths among a set of resolved
 * term IDs. Deduplicates pairs and prefers shortest, highest-evidence paths
 * spanning all connected components.
 */
export function findConnectingPaths(
  relations: readonly OntologyRelation[],
  termIds: readonly string[],
  opts: FindJoinPathOptions = {},
): JoinPath[] {
  const uniqueIds: string[] = [];
  const seen = new Set<string>();
  for (const id of termIds) {
    if (id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    uniqueIds.push(id);
  }
  if (uniqueIds.length < 2) return [];

  const candidatePaths: JoinPath[] = [];
  for (let i = 0; i < uniqueIds.length; i += 1) {
    const left = uniqueIds[i];
    if (left === undefined) continue;
    for (let j = i + 1; j < uniqueIds.length; j += 1) {
      const right = uniqueIds[j];
      if (right === undefined) continue;
      const path = findJoinPath(relations, left, right, opts);
      if (path !== null) {
        candidatePaths.push(path);
      }
    }
  }

  // Sort shortest, all-default-join, highest-evidence first, then build a
  // spanning forest over the requested terms so we avoid redundant detours.
  candidatePaths.sort((a, b) => {
    if (a.hops !== b.hops) return a.hops - b.hops;
    if (a.allDefaultJoins !== b.allDefaultJoins) {
      return a.allDefaultJoins ? -1 : 1;
    }
    if (a.totalEvidence !== b.totalEvidence) {
      return b.totalEvidence - a.totalEvidence;
    }
    return a.pathString.localeCompare(b.pathString);
  });

  const parent = new Map<string, string>();
  for (const id of uniqueIds) parent.set(id, id);
  const find = (x: string): string => {
    let curr = x;
    while (parent.get(curr) !== curr) {
      curr = parent.get(curr) ?? curr;
    }
    return curr;
  };

  const selected: JoinPath[] = [];
  for (const path of candidatePaths) {
    const rootA = find(path.fromTermId);
    const rootB = find(path.toTermId);
    if (rootA !== rootB) {
      parent.set(rootA, rootB);
      selected.push(path);
    }
  }

  return selected;
}
