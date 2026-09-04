import type {
  RetrievalHit,
  RetrievalDoc,
} from "@kizuki/core";
import {
  AUTHORITY_RANK,
  RRF_K,
  applyAdjacencyBoost,
  collapseToDocuments,
  cosineReScore,
  dedupResults,
  rrfFusion,
} from "../vendor/recipe";
import type { RecipeCandidate, RecipeEdge } from "../vendor/recipe";

export {
  AUTHORITY_WEIGHT,
  MAX_WALK_DEPTH,
  NEAR_DUPLICATE_JACCARD,
  RRF_K,
  cosineSimilarity,
  pushDegraded,
  walkNeighbors,
} from "../vendor/recipe";
export type { RecipeCandidate, RecipeEdge } from "../vendor/recipe";

export function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

export function lexicalScore(query: string, doc: RetrievalDoc): number {
  const terms = tokenize(query);
  if (terms.length === 0) return 0;
  const title = tokenize(doc.title);
  const body = tokenize(doc.text);
  let score = 0;
  for (const term of terms) {
    if (title.includes(term)) score += 4;
    if (body.includes(term)) score += 1;
  }
  return score;
}

export function snippetFor(query: string, text: string): string {
  const terms = tokenize(query);
  if (terms.length === 0) {
    return text.length <= 160 ? text : `${text.slice(0, 160)}…`;
  }
  const lower = text.toLowerCase();
  let index = -1;
  for (const term of terms) {
    index = lower.indexOf(term);
    if (index >= 0) break;
  }
  if (index < 0) {
    return text.length <= 160 ? text : `${text.slice(0, 160)}…`;
  }
  const start = Math.max(0, index - 40);
  const end = Math.min(text.length, index + 80);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return `${prefix}${text.slice(start, end)}${suffix}`;
}

export function compareHits(left: RetrievalHit, right: RetrievalHit): number {
  if (right.score !== left.score) return right.score - left.score;
  const authority =
    AUTHORITY_RANK[left.authority] - AUTHORITY_RANK[right.authority];
  if (authority !== 0) return authority;
  return left.doc_id.localeCompare(right.doc_id);
}

export function candidateFromDoc(
  doc: RetrievalDoc,
  score: number,
  opts: {
    chunk_id?: number;
    keyword_hit?: boolean;
    text?: string;
    vector?: Float32Array | null;
  } = {},
): RecipeCandidate {
  return {
    id: doc.doc_id,
    title: doc.title,
    text: opts.text ?? doc.text,
    kind: doc.kind,
    authority: doc.authority,
    chunk_id: opts.chunk_id ?? 0,
    keyword_hit: opts.keyword_hit ?? false,
    score,
    vector: opts.vector ?? null,
  };
}

export function finalizeRecipe(opts: {
  lexical: readonly RecipeCandidate[];
  vector: readonly RecipeCandidate[] | null;
  queryVector: Float32Array | null;
  edges: readonly RecipeEdge[];
  visible: (id: string) => boolean;
}): RecipeCandidate[] {
  const lists =
    opts.vector !== null && opts.vector.length > 0
      ? [opts.lexical, opts.vector]
      : [opts.lexical];
  let fused = rrfFusion(lists, RRF_K, true);
  if (opts.queryVector !== null) {
    fused = cosineReScore(fused, opts.queryVector);
  }
  const boosted = applyAdjacencyBoost(fused, opts.edges, opts.visible);
  boosted.sort((left, right) => right.score - left.score);
  return collapseToDocuments(dedupResults(boosted));
}

export function hitsFromCandidates(
  candidates: readonly RecipeCandidate[],
  docs: ReadonlyMap<string, RetrievalDoc>,
  query: string,
  limit: number,
): RetrievalHit[] {
  const hits: RetrievalHit[] = [];
  for (const candidate of candidates) {
    const doc = docs.get(candidate.id);
    if (doc === undefined || doc.sensitivity === null) continue;
    hits.push({
      doc_id: candidate.id,
      score: candidate.score,
      snippet: snippetFor(query, doc.text),
      kind: doc.kind,
      sensitivity: doc.sensitivity,
      taint: doc.taint,
      authority: doc.authority,
    });
  }
  hits.sort(compareHits);
  return hits.slice(0, limit);
}
