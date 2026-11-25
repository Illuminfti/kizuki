import {
  EMBEDDING_CAPABILITIES,
  EMBEDDING_CONTRACT,
  EMBEDDING_CONTRACT_MINOR,
  isPlainObject,
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
import {
  parseLocalHttpEmbeddingConfig,
  SPECIAL_TOKEN_ALLOWANCE,
  TITLE_TOKEN_CAP,
} from "./config";
import type { LocalHttpEmbeddingConfig } from "./config";
import { HttpFailure, LoopbackJsonClient } from "./http";
import { frameDoc, frameQuery, spaceFromConfig } from "./space";
import { estimateTokens, truncateToTokens } from "./tokens";

export const LOCAL_HTTP_EMBEDDING_ID = "kizuki.embedding.local-http";

export const LOCAL_HTTP_EMBEDDING_DESCRIPTOR = {
  id: LOCAL_HTTP_EMBEDDING_ID,
  kind: "embedding",
  contract: EMBEDDING_CONTRACT,
  contract_minor: EMBEDDING_CONTRACT_MINOR,
  supports: EMBEDDING_CAPABILITIES,
  requires_lease: false,
  optional_package: "@kizuki/embed-local-http",
} as const satisfies PortDescriptor;

/** A reply larger than this is refused: 64 inputs of 2,000 dimensions is about 3 MiB of JSON. */
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
/** Bounded client-side LRU cache for repeated framed query embeddings. */
const MAX_QUERY_CACHE_ENTRIES = 256;

type Failure = "unreachable" | "timeout" | "refused" | "unusable" | "space";

function closed(): never {
  throw new PortError("unavailable", "embedding port is closed", false);
}

function mapFailure(error: unknown): PortError {
  if (error instanceof PortError) return error;
  if (error instanceof HttpFailure) {
    switch (error.kind) {
      case "timeout":
        return new PortError(
          "timeout",
          "embedding server did not answer before the deadline",
          true,
        );
      case "network":
        return new PortError(
          "unavailable",
          "embedding server is unreachable",
          true,
        );
      case "status":
        // The reply body is not read into the message: it can echo the input.
        return new PortError(
          "unavailable",
          `embedding server refused the request (HTTP ${error.status})`,
          error.status === 429 || error.status >= 500,
        );
      default:
        return new PortError(
          "unavailable",
          "embedding server returned an unusable reply",
          false,
        );
    }
  }
  return new PortError("unavailable", "embedding request failed", true);
}

function vectorOf(value: unknown, dims: number): Float32Array {
  if (!Array.isArray(value))
    throw new PortError(
      "unavailable",
      "embedding server returned an unusable reply",
      false,
    );
  if (value.length !== dims) {
    throw new PortError(
      "space_mismatch",
      `embedding width ${value.length} does not match pinned dims ${dims}`,
      false,
    );
  }
  const vector = new Float32Array(dims);
  let nonZero = false;
  for (let at = 0; at < dims; at += 1) {
    const item = value[at];
    if (typeof item !== "number" || !Number.isFinite(item)) {
      throw new PortError(
        "space_mismatch",
        "embedding server returned a non-finite value",
        false,
      );
    }
    const f32 = Math.fround(item);
    if (!Number.isFinite(f32)) {
      throw new PortError("space_mismatch", "embedding value exceeds float32 range", false);
    }
    vector[at] = f32;
    if (f32 !== 0) nonZero = true;
  }
  if (!nonZero) {
    throw new PortError("space_mismatch", "embedding server returned a zero vector", false);
  }
  return vector;
}

/** Vectors in input order, or a refusal. Count, order and width are checked here, never repaired. */
function parseVectors(
  api: LocalHttpEmbeddingConfig["api"],
  reply: unknown,
  count: number,
  dims: number,
): Float32Array[] {
  let rows: unknown[] | undefined;
  if (isPlainObject(reply)) {
    if (api === "ollama") {
      const embeddings = reply["embeddings"];
      if (Array.isArray(embeddings)) rows = embeddings;
    } else if (Array.isArray(reply["data"])) {
      const ordered: unknown[] = new Array(reply["data"].length);
      for (const entry of reply["data"]) {
        const index = isPlainObject(entry) ? entry["index"] : undefined;
        if (
          !isPlainObject(entry) ||
          !Number.isInteger(index) ||
          (index as number) < 0 ||
          (index as number) >= ordered.length ||
          ordered[index as number] !== undefined
        ) {
          throw new PortError(
            "unavailable",
            "embedding server returned an unusable reply",
            false,
          );
        }
        ordered[index as number] = entry["embedding"];
      }
      rows = ordered;
    }
  }
  if (rows === undefined)
    throw new PortError(
      "unavailable",
      "embedding server returned an unusable reply",
      false,
    );
  if (rows.length !== count) {
    throw new PortError(
      "space_mismatch",
      `embedding server returned ${rows.length} vectors for ${count} inputs`,
      false,
    );
  }
  return Array.from(rows, (row) => vectorOf(row, dims));
}

export class LocalHttpEmbeddingPort implements EmbeddingPort {
  readonly descriptor: PortDescriptor = LOCAL_HTTP_EMBEDDING_DESCRIPTOR;
  /** Configured request batch size for callers that batch document chunks. */
  readonly batch_size: number;
  private readonly config: LocalHttpEmbeddingConfig;
  private readonly resolved: EmbeddingSpace;
  private readonly client = new LoopbackJsonClient();
  private readonly queryCache = new Map<string, Float32Array>();
  private tail: Promise<unknown> = Promise.resolve();
  private failure: Failure | null = null;
  private closed = false;
  private readonly lifetime = new AbortController();

  constructor(ctx: PortContext) {
    this.config = parseLocalHttpEmbeddingConfig(ctx.config);
    this.batch_size = this.config.batch_size;
    this.resolved = spaceFromConfig(this.config);
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
  }

  space(): EmbeddingSpace {
    if (this.closed) closed();
    return this.resolved;
  }

  countTokens(text: string): number {
    return estimateTokens(text);
  }

  embedQuery(texts: readonly string[]): Promise<Float32Array[]> {
    return this.enqueue(() => this.embedQueriesCached(texts));
  }

  embedDocs(chunks: readonly Chunk[]): Promise<Float32Array[]> {
    return this.enqueue(() =>
      this.embed(
        chunks.map((chunk) =>
          frameDoc(
            truncateToTokens(chunk.title ?? "", TITLE_TOKEN_CAP),
            chunk.text,
            this.resolved,
          ),
        ),
      ),
    );
  }

  async health(): Promise<PortHealth> {
    if (this.closed)
      return { status: "unavailable", reason: "embedding port is closed" };
    const detail = {
      space: this.resolved.id,
      dims: this.resolved.dims,
      api: this.config.api,
      max_input_tokens: this.config.max_input_tokens,
      batch_size: this.config.batch_size,
      query_cache_size: this.queryCache.size,
    };
    // Health never dials the server: a poll must not load a model. It reports
    // what the last real request saw.
    return this.failure === null
      ? { status: "ready", detail }
      : { status: "degraded", degraded: [`embedding-${this.failure}`], detail };
  }

  async close(): Promise<void> {
    this.closed = true;
    this.queryCache.clear();
    this.lifetime.abort();
    this.client.close();
    await this.tail;
    this.client.close();
  }

  /** One call at a time; callers submit bounded batches. */
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.tail.then(work, work);
    this.tail = run.catch(() => undefined);
    return run;
  }

  private getCachedQuery(framed: string): Float32Array | undefined {
    const hit = this.queryCache.get(framed);
    if (hit === undefined) return undefined;
    this.queryCache.delete(framed);
    this.queryCache.set(framed, hit);
    return hit;
  }

  private putCachedQuery(framed: string, vector: Float32Array): void {
    this.queryCache.delete(framed);
    if (this.queryCache.size >= MAX_QUERY_CACHE_ENTRIES) {
      const oldest = this.queryCache.keys().next().value;
      if (oldest !== undefined) this.queryCache.delete(oldest);
    }
    this.queryCache.set(framed, vector);
  }

  private async embedQueriesCached(
    texts: readonly string[],
  ): Promise<Float32Array[]> {
    if (this.closed) closed();
    const framed = texts.map((text) => frameQuery(text, this.resolved));
    const limit = this.config.max_input_tokens - SPECIAL_TOKEN_ALLOWANCE;
    for (const input of framed) {
      if (estimateTokens(input) > limit) {
        throw new PortError(
          "budget_exhausted",
          `embedding input exceeds ${limit} estimated tokens`,
          false,
        );
      }
    }
    const out = new Array<Float32Array>(framed.length);
    const missingOrder: string[] = [];
    const missingSlots = new Map<string, number[]>();
    for (let at = 0; at < framed.length; at += 1) {
      const key = framed[at]!;
      const cached = this.getCachedQuery(key);
      if (cached !== undefined) {
        out[at] = new Float32Array(cached);
        continue;
      }
      const slots = missingSlots.get(key);
      if (slots === undefined) {
        missingOrder.push(key);
        missingSlots.set(key, [at]);
      } else {
        slots.push(at);
      }
    }
    if (missingOrder.length > 0) {
      const computed = await this.embed(missingOrder);
      for (let at = 0; at < missingOrder.length; at += 1) {
        const key = missingOrder[at]!;
        const vector = computed[at]!;
        this.putCachedQuery(key, vector);
        for (const slot of missingSlots.get(key)!) {
          out[slot] = new Float32Array(vector);
        }
      }
    }
    return out;
  }

  private async embed(inputs: readonly string[]): Promise<Float32Array[]> {
    if (this.closed) closed();
    const limit = this.config.max_input_tokens - SPECIAL_TOKEN_ALLOWANCE;
    for (const input of inputs) {
      if (estimateTokens(input) > limit) {
        throw new PortError(
          "budget_exhausted",
          `embedding input exceeds ${limit} estimated tokens`,
          false,
        );
      }
    }
    const out: Float32Array[] = [];
    try {
      for (let at = 0; at < inputs.length; at += this.config.batch_size) {
        const batch = inputs.slice(at, at + this.config.batch_size);
        const reply = await this.client.post({
          host: this.config.host,
          port: this.config.port,
          path: this.config.path,
          body:
            this.config.api === "ollama"
              ? { model: this.config.model, input: batch, truncate: false }
              : {
                  model: this.config.model,
                  input: batch,
                  encoding_format: "float",
                },
          timeout_ms: this.config.timeout_ms,
          max_response_bytes: MAX_RESPONSE_BYTES,
          signal: this.lifetime.signal,
        });
        if (!isPlainObject(reply) || reply["model"] !== this.config.model) {
          throw new PortError("space_mismatch", "embedding server did not report the pinned model", false);
        }
        out.push(
          ...parseVectors(
            this.config.api,
            reply,
            batch.length,
            this.resolved.dims,
          ),
        );
      }
    } catch (error) {
      if (this.closed) closed();
      const mapped = mapFailure(error);
      this.failure =
        mapped.code === "space_mismatch"
          ? "space"
          : mapped.code === "timeout"
            ? "timeout"
            : error instanceof HttpFailure && error.kind === "network"
              ? "unreachable"
              : error instanceof HttpFailure && error.kind === "status"
                ? "refused"
                : "unusable";
      throw mapped;
    }
    this.failure = null;
    return out;
  }
}

export function createLocalHttpEmbeddingPort(ctx: PortContext): EmbeddingPort {
  return new LocalHttpEmbeddingPort(ctx);
}
