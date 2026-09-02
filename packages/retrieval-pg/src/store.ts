import { existsSync, readFileSync } from "node:fs";
import { PortError, isPlainObject, isRfc3339 } from "@kizuki/core";
import type {
  RetrievalAuthority,
  RetrievalDoc,
  RetrievalDocKind,
  Sensitivity,
} from "@kizuki/core";
import { ensureDir, writeAtomic } from "./atomic";
import {
  CHECKPOINT_REL,
  DOCS_REL,
  ENGINE_REL,
  GRAPH_REL,
  SELF_WRITES_REL,
  STORE_REL,
  dataPath,
} from "./paths";
import { runStoreTransaction } from "./txn";

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

function asStringArray(value: unknown): string[] | null {
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === "string")
  ) {
    return null;
  }
  return [...(value as string[])];
}

export class EmbeddedStore {
  docs = new Map<string, StoredDoc>();
  graph: GraphState = { entities: {}, edges: [] };
  checkpoint: EmbedCheckpoint | null = null;
  selfWrites = new Map<string, string>();
  engine: EngineJson | null = null;

  constructor(private readonly dataDir: string) {
    ensureDir(dataPath(dataDir, STORE_REL));
    this.load();
  }

  persist(): void {
    runStoreTransaction(() => {
      writeAtomic(
        dataPath(this.dataDir, DOCS_REL),
        `${JSON.stringify([...this.docs.values()])}\n`,
      );
      writeAtomic(
        dataPath(this.dataDir, GRAPH_REL),
        `${JSON.stringify(this.graph)}\n`,
      );
      writeAtomic(
        dataPath(this.dataDir, CHECKPOINT_REL),
        `${JSON.stringify(this.checkpoint)}\n`,
      );
      writeAtomic(
        dataPath(this.dataDir, SELF_WRITES_REL),
        `${JSON.stringify(Object.fromEntries(this.selfWrites))}\n`,
      );
    });
  }

  writeEngine(engine: EngineJson): void {
    this.engine = engine;
    writeAtomic(
      dataPath(this.dataDir, ENGINE_REL),
      `${JSON.stringify(engine)}\n`,
    );
  }

  phantoms(): PhantomEmbedding[] {
    const found: PhantomEmbedding[] = [];
    for (const doc of this.docs.values()) {
      for (const chunk of doc.chunks) {
        if (chunk.embedded_at !== null && chunk.vector === null) {
          found.push({ doc_id: doc.doc_id, chunk_id: chunk.chunk_id });
        }
      }
    }
    return found;
  }

  pendingEmbedChunks(space: string | null): number {
    let count = 0;
    for (const doc of this.docs.values()) {
      for (const chunk of doc.chunks) {
        if (
          chunk.vector === null ||
          (space !== null && chunk.space !== space)
        ) {
          count += 1;
        }
      }
    }
    return count;
  }

  private load(): void {
    this.docs = new Map();
    const docsPath = dataPath(this.dataDir, DOCS_REL);
    if (existsSync(docsPath)) {
      const raw = JSON.parse(readFileSync(docsPath, "utf8")) as unknown;
      if (Array.isArray(raw)) {
        for (const item of raw) {
          const doc = parseStoredDoc(item);
          if (doc !== null) this.docs.set(doc.doc_id, doc);
        }
      }
    }
    const graphPath = dataPath(this.dataDir, GRAPH_REL);
    if (existsSync(graphPath)) {
      const raw = JSON.parse(readFileSync(graphPath, "utf8")) as unknown;
      this.graph = parseGraph(raw);
    }
    const checkpointPath = dataPath(this.dataDir, CHECKPOINT_REL);
    if (existsSync(checkpointPath)) {
      const raw = JSON.parse(readFileSync(checkpointPath, "utf8")) as unknown;
      this.checkpoint = parseCheckpoint(raw);
    }
    const selfPath = dataPath(this.dataDir, SELF_WRITES_REL);
    if (existsSync(selfPath)) {
      const raw = JSON.parse(readFileSync(selfPath, "utf8")) as unknown;
      if (isPlainObject(raw)) {
        this.selfWrites = new Map(
          Object.entries(raw).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        );
      }
    }
    const enginePath = dataPath(this.dataDir, ENGINE_REL);
    if (existsSync(enginePath)) {
      const raw = JSON.parse(readFileSync(enginePath, "utf8")) as unknown;
      if (
        isPlainObject(raw) &&
        typeof raw["port"] === "string" &&
        typeof raw["contract"] === "string" &&
        typeof raw["contract_minor"] === "number"
      ) {
        this.engine = raw as unknown as EngineJson;
      }
    }
  }
}

function parseStoredDoc(value: unknown): StoredDoc | null {
  if (
    !isPlainObject(value) ||
    typeof value["doc_id"] !== "string" ||
    typeof value["kind"] !== "string" ||
    typeof value["title"] !== "string" ||
    typeof value["text"] !== "string"
  ) {
    return null;
  }
  const subjects = asStringArray(value["subjects"]);
  const provenance = asStringArray(value["provenance"]);
  if (subjects === null || provenance === null) return null;
  if (
    value["taint"] !== "clean" &&
    value["taint"] !== "quoted"
  ) {
    return null;
  }
  const authority = value["authority"];
  if (
    authority !== "owner_correction" &&
    authority !== "owner_authored" &&
    authority !== "connector_evidence" &&
    authority !== "model_inference"
  ) {
    return null;
  }
  if (
    value["sensitivity"] !== null &&
    value["sensitivity"] !== "public" &&
    value["sensitivity"] !== "personal" &&
    value["sensitivity"] !== "private"
  ) {
    return null;
  }
  if (
    value["occurred_at"] !== null &&
    !isRfc3339(value["occurred_at"])
  ) {
    return null;
  }
  if (!isRfc3339(value["updated_at"])) return null;
  const chunks = Array.isArray(value["chunks"])
    ? value["chunks"].flatMap((chunk) => {
        const parsed = parseChunk(chunk);
        return parsed === null ? [] : [parsed];
      })
    : [];
  return {
    doc_id: value["doc_id"],
    kind: value["kind"] as RetrievalDocKind,
    title: value["title"],
    text: value["text"],
    sensitivity: value["sensitivity"] as Sensitivity | null,
    taint: value["taint"],
    authority: authority as RetrievalAuthority,
    subjects,
    provenance,
    occurred_at: value["occurred_at"],
    updated_at: value["updated_at"],
    chunks,
  };
}

function parseChunk(value: unknown): StoredChunk | null {
  if (
    !isPlainObject(value) ||
    typeof value["chunk_id"] !== "string" ||
    typeof value["index"] !== "number" ||
    typeof value["text"] !== "string"
  ) {
    return null;
  }
  if (
    value["vector"] !== null &&
    (!Array.isArray(value["vector"]) ||
      !value["vector"].every((item) => typeof item === "number"))
  ) {
    return null;
  }
  if (value["embedded_at"] !== null && !isRfc3339(value["embedded_at"])) {
    return null;
  }
  if (value["space"] !== null && typeof value["space"] !== "string") {
    return null;
  }
  return {
    chunk_id: value["chunk_id"],
    index: value["index"],
    text: value["text"],
    vector: value["vector"] === null ? null : [...(value["vector"] as number[])],
    embedded_at: value["embedded_at"],
    space: value["space"],
  };
}

function parseGraph(value: unknown): GraphState {
  if (!isPlainObject(value)) return { entities: {}, edges: [] };
  const entities: Record<string, StoredEntity> = {};
  if (isPlainObject(value["entities"])) {
    for (const [id, raw] of Object.entries(value["entities"])) {
      if (!isPlainObject(raw) || typeof raw["entity_id"] !== "string") continue;
      const aliases = asStringArray(raw["aliases"]) ?? [];
      const claims = asStringArray(raw["source_claims"]) ?? [];
      entities[id] = {
        entity_id: raw["entity_id"],
        kind: typeof raw["kind"] === "string" ? raw["kind"] : "unknown",
        canonical_name:
          typeof raw["canonical_name"] === "string"
            ? raw["canonical_name"]
            : id,
        aliases,
        confidence:
          typeof raw["confidence"] === "number" ? raw["confidence"] : 0,
        source_claims: claims,
        sensitivity:
          raw["sensitivity"] === "public" ||
          raw["sensitivity"] === "personal" ||
          raw["sensitivity"] === "private"
            ? raw["sensitivity"]
            : null,
      };
    }
  }
  const edges: StoredEdge[] = [];
  if (Array.isArray(value["edges"])) {
    for (const raw of value["edges"]) {
      if (
        !isPlainObject(raw) ||
        typeof raw["from"] !== "string" ||
        typeof raw["to"] !== "string" ||
        typeof raw["type"] !== "string"
      ) {
        continue;
      }
      const provenance = asStringArray(raw["provenance"]) ?? [];
      edges.push({
        from: raw["from"],
        to: raw["to"],
        type: raw["type"],
        weight: typeof raw["weight"] === "number" ? raw["weight"] : 1,
        valid_from:
          typeof raw["valid_from"] === "string" ? raw["valid_from"] : null,
        valid_to: typeof raw["valid_to"] === "string" ? raw["valid_to"] : null,
        provenance,
      });
    }
  }
  return { entities, edges };
}

function parseCheckpoint(value: unknown): EmbedCheckpoint | null {
  if (value === null) return null;
  if (
    !isPlainObject(value) ||
    typeof value["doc_id"] !== "string" ||
    typeof value["chunk_index"] !== "number" ||
    typeof value["space"] !== "string"
  ) {
    return null;
  }
  return {
    doc_id: value["doc_id"],
    chunk_index: value["chunk_index"],
    space: value["space"],
  };
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
    existing.contract_minor !== expected.contract_minor
  ) {
    throw new PortError(
      "config_invalid",
      "retrieval engine.json does not match this port",
      false,
    );
  }
}
