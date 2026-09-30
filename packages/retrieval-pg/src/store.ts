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

/** Capacity is checked while cutting, before an unbounded chunk list exists. */
export class ChunkLimitError extends PortError {
  constructor(readonly limit: number) {
    super("budget_exhausted", `document exceeds ${limit} retrieval chunks`, false);
  }
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
  maxChunks = Infinity,
): StoredChunk[] {
  const size = Math.max(1, tokens);
  const chunk = (index: number, text: string): StoredChunk => ({
    chunk_id: `${doc.doc_id}#${index}`,
    index,
    text,
    vector: null,
    embedded_at: null,
    space: null,
  });
  if (countTokens !== undefined) {
    return tokenChunks(doc.text, size, overlap, countTokens, maxChunks).map((text, index) => chunk(index, text));
  }
  const words = doc.text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [chunk(0, "")];
  const chunks: StoredChunk[] = [];
  for (let start = 0; start < words.length; ) {
    if (chunks.length >= maxChunks) throw new ChunkLimitError(maxChunks);
    const end = Math.min(words.length, start + size);
    chunks.push(chunk(chunks.length, words.slice(start, end).join(" ")));
    if (end === words.length) break;
    start = Math.max(start + 1, end - overlap);
  }
  return chunks;
}

/** Count complete spans, including separators, and cut only at Unicode boundaries. */
function tokenChunks(text: string, size: number, overlap: number, count: (text: string) => number, maxChunks: number): string[] {
  if (text.length === 0) return [""];
  const offsets = new Uint32Array(text.length + 1);
  let length = 0;
  let offset = 0;
  for (const character of text) {
    offsets[length++] = offset;
    offset += character.length;
  }
  offsets[length] = offset;
  const span = (start: number, end: number) => text.slice(offsets[start], offsets[end]);
  const chunks: string[] = [];
  for (let start = 0; start < length; ) {
    if (chunks.length >= maxChunks) throw new ChunkLimitError(maxChunks);
    let low = start;
    let high = length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (count(span(start, middle)) <= size) low = middle;
      else high = middle - 1;
    }
    let end = low;
    if (end === start) throw new PortError("budget_exhausted", "one character exceeds the embedding chunk budget", false);
    // Prefer a word boundary; long unbroken runs still make progress.
    if (end < length) {
      for (let at = end; at > start + 1; at--) {
        if (/\s/u.test(span(at - 1, at))) { end = at; break; }
      }
    }
    chunks.push(span(start, end).trim());
    if (end === length) break;
    low = start + 1;
    high = end;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (count(span(middle, end)) <= overlap) high = middle;
      else low = middle + 1;
    }
    // Start overlap at a word boundary when there is one; do not invent partial words.
    if (/\s/u.test(span(start, end))) {
      while (low < end && !/\s/u.test(span(low - 1, low))) low++;
    }
    start = low;
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
