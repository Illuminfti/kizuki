import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PortError } from "@kizuki/core";
import type {
  Chunk,
  EmbeddingPort,
  EmbeddingSpace,
  PortContext,
  PortDescriptor,
  PortHealth,
  RetrievalConformanceFixtures,
  RetrievalDoc,
  RetrievalQuery,
} from "@kizuki/core";
import { EMBEDDED_RETRIEVAL_DESCRIPTOR } from "../src/index";

export const FIXED_NOW = "2026-09-02T12:00:00.000Z";

export const SYNTHETIC_DOCS: readonly RetrievalDoc[] = [
  {
    doc_id: "page:grace",
    kind: "page",
    title: "Grace at Acme",
    text: "Grace runs partnerships at Acme.",
    sensitivity: "personal",
    taint: "clean",
    authority: "connector_evidence",
    subjects: ["person:grace"],
    provenance: ["event:acme-note"],
    occurred_at: "2026-08-14T09:00:00.000Z",
    updated_at: FIXED_NOW,
  },
  {
    doc_id: "claim:grace-email",
    kind: "claim",
    title: "Grace contact",
    text: "Grace can be reached at grace@acme.test.",
    sensitivity: "private",
    taint: "clean",
    authority: "model_inference",
    subjects: ["person:grace"],
    provenance: ["event:acme-note"],
    occurred_at: "2026-08-14T09:00:00.000Z",
    updated_at: FIXED_NOW,
  },
  {
    doc_id: "event:unlabeled",
    kind: "event",
    title: "Unlabeled source",
    text: "Grace private unlabeled source.",
    sensitivity: null,
    taint: "quoted",
    authority: "connector_evidence",
    subjects: ["person:grace"],
    provenance: ["event:unlabeled"],
    occurred_at: "2026-08-15T09:00:00.000Z",
    updated_at: FIXED_NOW,
  },
];

export const SYNTHETIC_QUERY: RetrievalQuery = {
  text: "grace",
  mode: "lexical",
  scope: { kinds: ["page", "claim"], subjects: ["person:grace"] },
  ceiling: "private",
  limit: 10,
  deadline_ms: 1_000,
};

export const RETRIEVAL_FIXTURES: RetrievalConformanceFixtures = {
  docs: SYNTHETIC_DOCS,
  query: SYNTHETIC_QUERY,
  expected_doc_ids: ["claim:grace-email", "page:grace"],
  delete_ids: ["page:grace"],
};

export interface TemporaryPortContext {
  root: string;
  ctx: PortContext;
  cleanup(): void;
}

export function temporaryPortContext(
  descriptor: PortDescriptor = EMBEDDED_RETRIEVAL_DESCRIPTOR,
): TemporaryPortContext {
  const root = mkdtempSync(join(tmpdir(), "kizuki-retrieval-pg-"));
  const vaultPath = join(root, "vault");
  const dataDir = join(vaultPath, ".kizuki", descriptor.kind, descriptor.id);
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  return {
    root,
    ctx: {
      vault_path: vaultPath,
      data_dir: dataDir,
      config: {},
      secrets: async () => "synthetic-contract-token",
      clock: () => FIXED_NOW,
      logger: () => {},
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

export const FIXTURE_SPACE: EmbeddingSpace = {
  id: "fixture:hash@8",
  provider: "fixture",
  model: "hash",
  dims: 8,
  prompt_query: "query: {q}",
  prompt_doc: "title: {title} | text: {text}",
  tokenizer_id: "fixture-whitespace",
  chunk: { tokens: 8, overlap: 2 },
};

export function hashVector(text: string, dims = 8): Float32Array {
  const vector = new Float32Array(dims);
  const tokens = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  for (const token of tokens) {
    let hash = 0;
    for (let index = 0; index < token.length; index += 1) {
      hash = (hash * 33 + token.charCodeAt(index)) >>> 0;
    }
    vector[hash % dims] = (vector[hash % dims] ?? 0) + 1;
  }
  return vector;
}

export class FixtureEmbeddingPort implements EmbeddingPort {
  readonly descriptor: PortDescriptor = {
    id: "kizuki.embedding.fixture",
    kind: "embedding",
    contract: "kizuki.embedding/v1",
    contract_minor: 0,
    supports: ["query", "documents"],
    requires_lease: false,
    optional_package: null,
  };
  calls = 0;
  failAfter: number | null = null;
  private closed = false;

  constructor(private readonly resolved: EmbeddingSpace = FIXTURE_SPACE) {}

  space(): EmbeddingSpace {
    return this.resolved;
  }

  async embedQuery(texts: readonly string[]): Promise<Float32Array[]> {
    this.assertOpen();
    return texts.map((text) => hashVector(text, this.resolved.dims));
  }

  async embedDocs(chunks: readonly Chunk[]): Promise<Float32Array[]> {
    this.assertOpen();
    const out: Float32Array[] = [];
    for (const chunk of chunks) {
      this.calls += 1;
      if (this.failAfter !== null && this.calls > this.failAfter) {
        throw new PortError("unavailable", "embedder killed", true);
      }
      out.push(hashVector(chunk.text, this.resolved.dims));
    }
    return out;
  }

  async health(): Promise<PortHealth> {
    return { status: "ready", detail: { calls: this.calls } };
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new PortError("unavailable", "fixture embedder is closed", false);
    }
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
