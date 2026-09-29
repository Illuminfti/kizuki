import { PortError, isRfc3339 } from "@kizuki/core";
import type { RetrievalDoc, Sensitivity } from "@kizuki/core";
export interface StoredChunk {
  readonly chunk_id: string;
  readonly index: number;
  readonly text: string;
  readonly vector: number[] | null;
  readonly embedded_at: string | null;
  readonly space: string | null;
}

export interface StoredDoc extends RetrievalDoc {
  readonly chunks: StoredChunk[];
}

export interface StoredEntity {
  readonly entity_id: string;
  readonly kind: string;
  readonly canonical_name: string;
  readonly aliases: readonly string[];
  readonly confidence: number;
  readonly source_claims: readonly string[];
  readonly sensitivity: Sensitivity | null;
}

export interface StoredEdge {
  readonly from: string;
  readonly to: string;
  readonly type: string;
  readonly weight: number;
  readonly valid_from: string | null;
  readonly valid_to: string | null;
  readonly provenance: readonly string[];
}

export interface GraphState {
  entities: Record<string, StoredEntity>;
  edges: StoredEdge[];
}

export interface EmbedCheckpoint {
  readonly doc_id: string;
  readonly chunk_index: number;
  readonly space: string;
}

export interface EngineJson {
  readonly port: string;
  readonly contract: string;
  readonly contract_minor: number;
  readonly space: string | null;
  readonly created_at: string;
  readonly rebuilt_at: string | null;
}

export interface PhantomEmbedding {
  readonly doc_id: string;
  readonly chunk_id: string;
}

export function storedFromDoc(doc: RetrievalDoc): StoredDoc {
  return {
    ...doc,
    chunks: [
      {
        chunk_id: `${doc.doc_id}#0`,
        index: 0,
        text: `${doc.title}\n${doc.text}`,
        vector: null,
        embedded_at: null,
        space: null,
      },
    ],
  };
}

/**
 * Splits the document body into overlapping chunks. Sizes are counted with the
 * embedding port's own tokenizer when it has one and in whitespace-separated
 * words otherwise. The title is not part of the chunk: the port frames it into
 * every chunk's document prompt instead.
 */
export function chunkDocument(
  doc: RetrievalDoc,
  tokens: number,
  overlap: number,
  countTokens?: (text: string) => number,
): StoredChunk[] {
  const size = Math.max(1, tokens);
  const words = doc.text.split(/\s+/).filter(Boolean).flatMap((word) => {
    if (countTokens === undefined || countTokens(word) <= size) return [word];
    // A run with no whitespace, such as a URL or an encoded blob, is cut so
    // that no piece can exceed the window. A character costs at most one token.
    const characters = [...word];
    const pieces: string[] = [];
    for (let at = 0; at < characters.length; at += size) pieces.push(characters.slice(at, at + size).join(""));
    return pieces;
  });
  const weights = words.map((word) => (countTokens === undefined ? 1 : Math.max(1, countTokens(word))));
  const chunk = (index: number, text: string): StoredChunk => ({
    chunk_id: `${doc.doc_id}#${index}`,
    index,
    text,
    vector: null,
    embedded_at: null,
    space: null,
  });
  if (words.length === 0) return [chunk(0, "")];
  const chunks: StoredChunk[] = [];
  for (let start = 0; start < words.length; ) {
    let end = start;
    let used = 0;
    while (end < words.length && (end === start || used + weights[end]! <= size)) {
      used += weights[end]!;
      end += 1;
    }
    chunks.push(chunk(chunks.length, words.slice(start, end).join(" ")));
    if (end >= words.length) break;
    // The next chunk re-reads the last `overlap` tokens but always moves forward.
    let next = end;
    let carried = 0;
    while (next > start + 1 && carried + weights[next - 1]! <= Math.max(0, overlap)) {
      carried += weights[next - 1]!;
      next -= 1;
    }
    start = next;
  }
  return chunks;
}

export function engineMismatch(
  existing: EngineJson | null,
  expected: EngineJson,
): void {
  if (existing === null) return;
  if (
    existing.port !== expected.port ||
    existing.contract !== expected.contract ||
    existing.contract_minor !== expected.contract_minor ||
    !isRfc3339(existing.created_at) ||
    (existing.rebuilt_at !== null && !isRfc3339(existing.rebuilt_at)) ||
    (existing.space !== null && (typeof existing.space !== "string" || existing.space.length === 0))
  ) {
    throw new PortError(
      "config_invalid",
      "retrieval engine.json does not match this port",
      false,
    );
  }
}
