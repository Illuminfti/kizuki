import { isPrivilegedAuthority } from "./tier";
import type { RecipeCandidate } from "./types";

/** Layer 2 Jaccard threshold from the public tip (word-set proxy). */
export const NEAR_DUPLICATE_JACCARD = 0.85;
const MAX_TYPE_RATIO = 0.6;
const MAX_PER_PAGE = 2;

function pageKey(candidate: RecipeCandidate): string {
  return candidate.id;
}

/**
 * Four-layer near-duplicate post-filter plus a privileged-authority
 * guarantee, forked from the public tip dedup pipeline.
 *
 * 1. Top 3 chunks per document
 * 2. Intra-document word-set Jaccard > 0.85 drops near-duplicates
 * 3. No document kind exceeds 60% when more than one kind is present
 * 4. Cap of 2 chunks per document
 * 5. Guarantee at least one owner_correction row per document that had one
 */
export function dedupResults(
  results: readonly RecipeCandidate[],
  opts?: {
    cosineThreshold?: number;
    maxTypeRatio?: number;
    maxPerPage?: number;
  },
): RecipeCandidate[] {
  const threshold = opts?.cosineThreshold ?? NEAR_DUPLICATE_JACCARD;
  const maxRatio = opts?.maxTypeRatio ?? MAX_TYPE_RATIO;
  const maxPerPage = opts?.maxPerPage ?? MAX_PER_PAGE;
  const preDedup = [...results];

  let deduped = dedupBySource(preDedup);
  deduped = dedupByTextSimilarity(deduped, threshold);
  deduped = enforceTypeDiversity(deduped, maxRatio);
  deduped = capPerPage(deduped, maxPerPage);
  return guaranteePrivilegedAuthority(deduped, preDedup);
}

function dedupBySource(results: readonly RecipeCandidate[]): RecipeCandidate[] {
  const byPage = new Map<string, RecipeCandidate[]>();
  for (const row of results) {
    const existing = byPage.get(pageKey(row)) ?? [];
    existing.push(row);
    byPage.set(pageKey(row), existing);
  }
  const kept: RecipeCandidate[] = [];
  for (const chunks of byPage.values()) {
    chunks.sort((left, right) => right.score - left.score);
    kept.push(...chunks.slice(0, 3));
  }
  return kept.sort((left, right) => right.score - left.score);
}

function wordSet(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/\s+/).filter((token) => token.length > 0));
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 && right.size === 0) return 1;
  let intersection = 0;
  for (const item of left) {
    if (right.has(item)) intersection += 1;
  }
  const union = left.size + right.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Intra-document only. The public tip scoped this comparison after an
 * unscoped version dropped distinct pages that shared boilerplate.
 */
function dedupByTextSimilarity(
  results: readonly RecipeCandidate[],
  threshold: number,
): RecipeCandidate[] {
  const kept: RecipeCandidate[] = [];
  const keptWordsByPage = new Map<string, Set<string>[]>();
  for (const row of results) {
    const words = wordSet(row.text);
    const key = pageKey(row);
    const samePageKept = keptWordsByPage.get(key) ?? [];
    const tooSimilar = samePageKept.some(
      (existing) => jaccard(existing, words) > threshold,
    );
    if (tooSimilar) continue;
    kept.push(row);
    samePageKept.push(words);
    keptWordsByPage.set(key, samePageKept);
  }
  return kept;
}

function enforceTypeDiversity(
  results: readonly RecipeCandidate[],
  maxRatio: number,
): RecipeCandidate[] {
  if (new Set(results.map((row) => row.kind)).size <= 1) return [...results];
  const maxPerType = Math.max(1, Math.ceil(results.length * maxRatio));
  const typeCounts = new Map<string, number>();
  const acceptedPages = new Set<string>();
  const rejectedPages = new Set<string>();
  const kept: RecipeCandidate[] = [];
  for (const row of results) {
    const key = pageKey(row);
    if (acceptedPages.has(key)) {
      // Type diversity is document-level. Extra chunks from an accepted
      // document do not consume slots that belong to distinct documents.
      kept.push(row);
      continue;
    }
    if (rejectedPages.has(key)) continue;
    const count = typeCounts.get(row.kind) ?? 0;
    if (count >= maxPerType) {
      rejectedPages.add(key);
      continue;
    }
    kept.push(row);
    acceptedPages.add(key);
    typeCounts.set(row.kind, count + 1);
  }
  return kept;
}

function capPerPage(
  results: readonly RecipeCandidate[],
  maxPerPage: number,
): RecipeCandidate[] {
  const pageCounts = new Map<string, number>();
  const kept: RecipeCandidate[] = [];
  for (const row of results) {
    const key = pageKey(row);
    const count = pageCounts.get(key) ?? 0;
    if (count >= maxPerPage) continue;
    kept.push(row);
    pageCounts.set(key, count + 1);
  }
  return kept;
}

function guaranteePrivilegedAuthority(
  results: readonly RecipeCandidate[],
  preDedup: readonly RecipeCandidate[],
): RecipeCandidate[] {
  const byPage = new Map<string, RecipeCandidate[]>();
  for (const row of results) {
    const existing = byPage.get(pageKey(row)) ?? [];
    existing.push(row);
    byPage.set(pageKey(row), existing);
  }
  const output = [...results];
  for (const [key, pageChunks] of byPage) {
    if (pageChunks.some((row) => isPrivilegedAuthority(row.authority))) {
      continue;
    }
    const candidate = preDedup
      .filter(
        (row) =>
          pageKey(row) === key && isPrivilegedAuthority(row.authority),
      )
      .sort((left, right) => right.score - left.score)[0];
    if (candidate === undefined) continue;
    const lowestIdx = output.reduce((minIdx, row, idx) => {
      if (pageKey(row) !== key) return minIdx;
      if (minIdx === -1) return idx;
      const lowest = output[minIdx];
      if (lowest === undefined) return idx;
      return row.score < lowest.score ? idx : minIdx;
    }, -1);
    if (lowestIdx !== -1) {
      output[lowestIdx] = candidate;
    }
  }
  return output;
}

export function collapseToDocuments(
  results: readonly RecipeCandidate[],
): RecipeCandidate[] {
  const best = new Map<string, RecipeCandidate>();
  for (const row of results) {
    const existing = best.get(row.id);
    if (existing === undefined || row.score > existing.score) {
      best.set(row.id, row);
    }
  }
  return [...best.values()].sort((left, right) => right.score - left.score);
}
