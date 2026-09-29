import type { Port } from "./ports";

export const EMBEDDING_CONTRACT = "kizuki.embedding/v1" as const;
export const EMBEDDING_CONTRACT_MINOR = 0;
export const EMBEDDING_CAPABILITIES = [
  "query",
  "documents",
] as const;
export type EmbeddingCapability =
  (typeof EMBEDDING_CAPABILITIES)[number];

export interface EmbeddingSpace {
  readonly id: string;
  readonly provider: string;
  readonly model: string;
  readonly dims: number;
  readonly prompt_query: string;
  readonly prompt_doc: string;
  readonly tokenizer_id: string;
  readonly chunk: {
    readonly tokens: number;
    readonly overlap: number;
  };
}

export interface Chunk {
  readonly chunk_id: string;
  readonly doc_id: string;
  readonly text: string;
  readonly index: number;
  /** Title of the document the chunk belongs to; ports frame it into the document prompt. */
  readonly title?: string;
}

export interface EmbeddingPort extends Port {
  space(): EmbeddingSpace;
  embedQuery(texts: readonly string[]): Promise<Float32Array[]>;
  embedDocs(chunks: readonly Chunk[]): Promise<Float32Array[]>;
  /**
   * Tokens `text` occupies under the port's tokenizer. Engines size chunks with
   * it. A port without it is chunked by whitespace-separated words.
   */
  countTokens?(text: string): number;
}
