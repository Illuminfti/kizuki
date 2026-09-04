import type {
  RetrievalAuthority,
  RetrievalDocKind,
} from "@kizuki/core";

/**
 * Internal fusion row. One row is one chunk (or the whole document when
 * the store has not chunked it). Final hits collapse to `id`.
 */
export interface RecipeCandidate {
  readonly id: string;
  readonly title: string;
  readonly text: string;
  readonly kind: RetrievalDocKind;
  readonly authority: RetrievalAuthority;
  readonly chunk_id: number;
  readonly keyword_hit: boolean;
  score: number;
  vector: Float32Array | null;
}

export interface RecipeEdge {
  readonly from: string;
  readonly to: string;
  readonly type: string;
  readonly weight: number;
  readonly provenance: readonly string[];
}

export interface RecipeGraphWalk {
  readonly edges: RecipeEdge[];
  readonly truncated: boolean;
}
