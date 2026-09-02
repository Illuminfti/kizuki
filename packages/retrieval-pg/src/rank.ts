import type {
  RetrievalAuthority,
  RetrievalDoc,
  RetrievalHit,
} from "@kizuki/core";

export const RRF_K = 60;
export const NEAR_DUPLICATE_JACCARD = 0.86;

export const AUTHORITY_WEIGHT: Readonly<Record<RetrievalAuthority, number>> = {
  owner_correction: 1.4,
  owner_authored: 1.2,
  connector_evidence: 1.0,
  model_inference: 0.8,
};

export const AUTHORITY_RANK: Readonly<Record<RetrievalAuthority, number>> = {
  owner_correction: 0,
  owner_authored: 1,
  connector_evidence: 2,
  model_inference: 3,
};

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

export function cosine(left: Float32Array, right: Float32Array): number {
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
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

export function characterTrigrams(text: string): Set<string> {
  const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();
  const grams = new Set<string>();
  if (normalized.length < 3) {
    if (normalized.length > 0) grams.add(normalized);
    return grams;
  }
  for (let index = 0; index <= normalized.length - 3; index += 1) {
    grams.add(normalized.slice(index, index + 3));
  }
  return grams;
}

export function jaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 && right.size === 0) return 1;
  let intersection = 0;
  for (const item of left) {
    if (right.has(item)) intersection += 1;
  }
  const union = left.size + right.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export function reciprocalRankFusion(
  rankedLists: readonly (readonly string[])[],
  k: number = RRF_K,
): Map<string, number> {
  const scores = new Map<string, number>();
  for (const list of rankedLists) {
    list.forEach((id, index) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + index + 1));
    });
  }
  return scores;
}

export function applyTierWeight(
  fused: number,
  authority: RetrievalAuthority,
): number {
  return fused * AUTHORITY_WEIGHT[authority];
}

export function filterNearDuplicates(
  ranked: readonly RetrievalHit[],
  docs: ReadonlyMap<string, RetrievalDoc>,
): RetrievalHit[] {
  const kept: RetrievalHit[] = [];
  const keptGrams: Set<string>[] = [];
  for (const hit of ranked) {
    const doc = docs.get(hit.doc_id);
    if (doc === undefined) continue;
    const grams = characterTrigrams(`${doc.title} ${doc.text}`);
    const duplicate = keptGrams.some(
      (existing) => jaccard(existing, grams) >= NEAR_DUPLICATE_JACCARD,
    );
    if (duplicate) continue;
    kept.push(hit);
    keptGrams.push(grams);
  }
  return kept;
}

export function compareHits(left: RetrievalHit, right: RetrievalHit): number {
  if (right.score !== left.score) return right.score - left.score;
  const authority =
    AUTHORITY_RANK[left.authority] - AUTHORITY_RANK[right.authority];
  if (authority !== 0) return authority;
  return left.doc_id.localeCompare(right.doc_id);
}
