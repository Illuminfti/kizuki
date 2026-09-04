import { authorityBoost } from "./tier";
import type { RecipeCandidate } from "./types";

/** Reciprocal rank fusion constant from the public tip hybrid search. */
export const RRF_K = 60;

/**
 * Cosine blend used after RRF: 0.7 fused + 0.3 query-chunk cosine.
 * Forked from cosineReScore in the public tip hybrid search.
 */
export const COSINE_BLEND_RRF = 0.7;
export const COSINE_BLEND_VECTOR = 0.3;

function recipeKey(candidate: RecipeCandidate): string {
  return `${candidate.id}:${candidate.chunk_id}`;
}

/**
 * Reciprocal Rank Fusion: merge ranked lists.
 * Each result gets score = sum(1 / (K + rank)) across lists it appears in.
 * After accumulation: normalize to 0-1, then apply authority boost.
 */
export function rrfFusion(
  lists: readonly (readonly RecipeCandidate[])[],
  k: number = RRF_K,
  applyBoost = true,
): RecipeCandidate[] {
  const scores = new Map<
    string,
    { result: RecipeCandidate; score: number; keywordHit: boolean }
  >();

  for (const list of lists) {
    list.forEach((candidate, rank) => {
      const key = recipeKey(candidate);
      const existing = scores.get(key);
      const rrfScore = 1 / (k + rank);
      if (existing !== undefined) {
        existing.score += rrfScore;
        if (candidate.keyword_hit) existing.keywordHit = true;
        // Lexical recall can contribute a document-shaped row before vector
        // recall contributes the same chunk key. Keep the vector-bearing
        // chunk text and vector while preserving authoritative document data.
        if (existing.result.vector === null && candidate.vector !== null) {
          existing.result = {
            ...existing.result,
            text: candidate.text,
            vector: candidate.vector,
          };
        }
        return;
      }
      scores.set(key, {
        result: candidate,
        score: rrfScore,
        keywordHit: candidate.keyword_hit,
      });
    });
  }

  const entries = [...scores.values()];
  if (entries.length === 0) return [];

  const maxScore = Math.max(...entries.map((entry) => entry.score));
  if (maxScore > 0) {
    for (const entry of entries) {
      entry.score = entry.score / maxScore;
      const boost = applyBoost ? authorityBoost(entry.result.authority) : 1.0;
      entry.score *= boost;
    }
  }

  return entries
    .sort((left, right) => right.score - left.score)
    .map(({ result, score, keywordHit }) => ({
      ...result,
      score,
      keyword_hit: keywordHit || result.keyword_hit,
    }));
}

export function cosineSimilarity(
  left: Float32Array,
  right: Float32Array,
): number {
  if (left.length !== right.length || left.length === 0) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  const denom = Math.sqrt(leftNorm) * Math.sqrt(rightNorm);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Blend RRF scores with query-chunk cosine. A row with no vector is
 * routed through the same blend with cosine=0 so it cannot keep a raw
 * post-RRF score on a wider scale.
 */
export function cosineReScore(
  results: readonly RecipeCandidate[],
  queryVector: Float32Array,
): RecipeCandidate[] {
  if (results.length === 0) return [];
  const maxRrf = Math.max(...results.map((row) => row.score));
  return results
    .map((row) => {
      const cosine =
        row.vector === null ? 0 : cosineSimilarity(queryVector, row.vector);
      const normRrf = maxRrf > 0 ? row.score / maxRrf : 0;
      return {
        ...row,
        score: COSINE_BLEND_RRF * normRrf + COSINE_BLEND_VECTOR * cosine,
      };
    })
    .sort((left, right) => right.score - left.score);
}
