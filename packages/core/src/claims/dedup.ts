import type { RetrievalPort } from "../contracts/retrieval";
import { ClaimError } from "./errors";
import { normalizeObject } from "./hash";

/** RFC 0002 §4.3. Per embedding space; changing the space invalidates this. */
export const CLAIM_DEDUP_MIN = 0.82;

export const FIXTURE_EMBEDDING_SPACE = "kizuki.embed.fixture/v1";

export type DedupMode = "full" | "structural-only";

const FIXTURE_DUPLICATES: ReadonlyArray<readonly [string, string]> = [
  [
    normalizeObject("Grace runs partnerships at Acme."),
    normalizeObject("Grace works on partnerships at Acme."),
  ],
];

function pairKey(left: string, right: string): string {
  return left < right ? `${left}\0${right}` : `${right}\0${left}`;
}

const FIXTURE_DUPLICATE_KEYS = new Set(
  FIXTURE_DUPLICATES.map(([left, right]) => pairKey(left, right)),
);

function tokens(value: string): Set<string> {
  return new Set(normalizeObject(value).split(" ").filter(Boolean));
}

function jaccard(left: string, right: string): number {
  const a = tokens(left);
  const b = tokens(right);
  if (a.size === 0 && b.size === 0) return 1;
  let overlap = 0;
  for (const token of a) {
    if (b.has(token)) overlap += 1;
  }
  return overlap / (a.size + b.size - overlap);
}

/**
 * Scores two claim bodies in an embedding space. The fixture space is the
 * only space this lane ships; a different space is a hard mismatch.
 */
export function scoreClaimPair(
  left: string,
  right: string,
  space: string,
): number {
  if (space !== FIXTURE_EMBEDDING_SPACE) {
    throw new ClaimError(
      "space_mismatch",
      `dedup threshold is defined for ${FIXTURE_EMBEDDING_SPACE}, not ${space}`,
    );
  }
  const a = normalizeObject(left);
  const b = normalizeObject(right);
  if (a === b) return 1;
  if (FIXTURE_DUPLICATE_KEYS.has(pairKey(a, b))) return 0.91;
  return jaccard(a, b);
}

export function retrievalDedupMode(retrieval: RetrievalPort | undefined): DedupMode {
  if (retrieval === undefined) return "structural-only";
  if (!retrieval.descriptor.supports.includes("vector")) return "structural-only";
  return "full";
}

export async function retrievalIsDegraded(
  retrieval: RetrievalPort | undefined,
): Promise<boolean> {
  if (retrieval === undefined) return true;
  const health = await retrieval.health();
  return health.status !== "ready";
}
