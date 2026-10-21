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
import { HttpFailure, postJson } from "./http";
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
  for (let at = 0; at < dims; at += 1) {
    const item = value[at];
    if (typeof item !== "number" || !Number.isFinite(item)) {
      throw new PortError(
        "space_mismatch",
        "embedding server returned a non-finite value",
        false,
      );
    }
    vector[at] = item;
    if (!Number.isFinite(vector[at])) {
      throw new PortError("space_mismatch", "embedding value exceeds float32 range", false);
    }
  }
  if (!vector.some((value) => value !== 0)) {
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
  private readonly config: LocalHttpEmbeddingConfig;
  private readonly resolved: EmbeddingSpace;
  private tail: Promise<unknown> = Promise.resolve();
  private failure: Failure | null = null;
  private closed = false;
  private readonly lifetime = new AbortController();

  constructor(ctx: PortContext) {
    this.config = parseLocalHttpEmbeddingConfig(ctx.config);
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
    return this.enqueue(() =>
      this.embed(texts.map((text) => frameQuery(text, this.resolved))),
    );
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
    };
    // Health never dials the server: a poll must not load a model. It reports
    // what the last real request saw.
    return this.failure === null
      ? { status: "ready", detail }
      : { status: "degraded", degraded: [`embedding-${this.failure}`], detail };
  }

  async close(): Promise<void> {
    this.closed = true;
    this.lifetime.abort();
    await this.tail;
  }

  /** One call at a time; the retrieval rail submits a bounded pass one chunk at a time. */
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.tail.then(work, work);
    this.tail = run.catch(() => undefined);
    return run;
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
        const reply = await postJson({
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
