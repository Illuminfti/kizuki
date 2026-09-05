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

export function chunkDocument(
  doc: RetrievalDoc,
  tokens: number,
  overlap: number,
): StoredChunk[] {
  const words = `${doc.title} ${doc.text}`.split(/\s+/).filter(Boolean);
  const size = Math.max(1, tokens);
  const step = Math.max(1, size - Math.max(0, overlap));
  if (words.length === 0) {
    return [
      {
        chunk_id: `${doc.doc_id}#0`,
        index: 0,
        text: "",
        vector: null,
        embedded_at: null,
        space: null,
      },
    ];
  }
  const chunks: StoredChunk[] = [];
  for (let start = 0, index = 0; start < words.length; start += step, index += 1) {
    const slice = words.slice(start, start + size);
    chunks.push({
      chunk_id: `${doc.doc_id}#${index}`,
      index,
      text: slice.join(" "),
      vector: null,
      embedded_at: null,
      space: null,
    });
    if (start + size >= words.length) break;
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
