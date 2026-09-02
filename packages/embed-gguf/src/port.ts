import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  EMBEDDING_CAPABILITIES,
  EMBEDDING_CONTRACT,
  EMBEDDING_CONTRACT_MINOR,
  PortError,
} from "@kizuki/core";
import type {
  Chunk,
  EmbeddingPort,
  EmbeddingSpace,
  PortContext,
  PortDescriptor,
  PortHealth,
} from "@kizuki/core";
import { parseGgufEmbeddingConfig } from "./config";
import type { GgufEmbeddingConfig } from "./config";
import { loadEmbeddingTable, readGgufFile } from "./gguf";
import type { EmbeddingTable } from "./gguf";
import {
  assertExactDims,
  embedTable,
  SingleFlightQueue,
} from "./runtime";
import { formatDoc, formatQuery, spaceFromTable } from "./space";

export const GGUF_EMBEDDING_ID = "kizuki.embedding.gguf";

export const GGUF_EMBEDDING_DESCRIPTOR = {
  id: GGUF_EMBEDDING_ID,
  kind: "embedding",
  contract: EMBEDDING_CONTRACT,
  contract_minor: EMBEDDING_CONTRACT_MINOR,
  supports: EMBEDDING_CAPABILITIES,
  requires_lease: false,
  optional_package: "@kizuki/embed-gguf",
} as const satisfies PortDescriptor;

export const RSS_CEILING_BYTES = 512 * 1024 * 1024;

function closed(): never {
  throw new PortError("unavailable", "embedding port is closed", false);
}

export class GgufEmbeddingPort implements EmbeddingPort {
  readonly descriptor: PortDescriptor = GGUF_EMBEDDING_DESCRIPTOR;
  private readonly config: GgufEmbeddingConfig;
  private readonly table: EmbeddingTable;
  private readonly resolved: EmbeddingSpace;
  private readonly queue = new SingleFlightQueue();
  private closed = false;

  constructor(private readonly ctx: PortContext) {
    this.config = parseGgufEmbeddingConfig(ctx.config);
    this.table = loadEmbeddingTable(readGgufFile(this.config.model_path));
    this.resolved = spaceFromTable(this.table);
    if (
      this.config.expected_space !== null &&
      this.config.expected_space !== this.resolved.id
    ) {
      throw new PortError(
        "space_mismatch",
        `embedding space ${this.resolved.id} does not match expected ${this.config.expected_space}`,
        false,
      );
    }
    mkdirSync(ctx.data_dir, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(ctx.data_dir, "space.json"),
      `${JSON.stringify({
        space: this.resolved,
        context_size: this.config.context_size,
        batch_size: this.config.batch_size,
        model_path: this.config.model_path,
      })}\n`,
      { mode: 0o600 },
    );
  }

  space(): EmbeddingSpace {
    if (this.closed) closed();
    return this.resolved;
  }

  async embedQuery(texts: readonly string[]): Promise<Float32Array[]> {
    return this.queue.run(async () => {
      if (this.closed) closed();
      this.assertBatch(texts);
      const framed = texts.map((text) => formatQuery(text, this.resolved));
      const vectors = embedTable(this.table, framed, this.config);
      assertExactDims(vectors, this.resolved.dims);
      return vectors;
    });
  }

  async embedDocs(chunks: readonly Chunk[]): Promise<Float32Array[]> {
    return this.queue.run(async () => {
      if (this.closed) closed();
      this.assertBatch(chunks);
      const framed = chunks.map((chunk) =>
        formatDoc(chunk.doc_id, chunk.text, this.resolved),
      );
      const vectors = embedTable(this.table, framed, this.config);
      assertExactDims(vectors, this.resolved.dims);
      return vectors;
    });
  }

  async health(): Promise<PortHealth> {
    if (this.closed) {
      return { status: "unavailable", reason: "embedding port is closed" };
    }
    return {
      status: "ready",
      detail: {
        space: this.resolved.id,
        dims: this.resolved.dims,
        context_size: this.config.context_size,
        batch_size: this.config.batch_size,
        rss_ceiling_bytes: RSS_CEILING_BYTES,
      },
    };
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  private assertBatch(items: readonly unknown[]): void {
    if (items.length > this.config.batch_size) {
      throw new PortError(
        "budget_exhausted",
        `embed batch ${items.length} exceeds pinned batch_size ${this.config.batch_size}`,
        false,
      );
    }
  }
}

export function createGgufEmbeddingPort(ctx: PortContext): EmbeddingPort {
  return new GgufEmbeddingPort(ctx);
}
