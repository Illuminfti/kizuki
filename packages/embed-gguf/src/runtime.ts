import { PortError } from "@kizuki/core";
import type { EmbeddingTable } from "./gguf";

const UNK = "<unk>";

export interface EmbedRequest {
  readonly texts: readonly string[];
  readonly context_size: number;
  readonly batch_size: number;
}

export class SingleFlightQueue {
  private tail: Promise<void> = Promise.resolve();

  run<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.tail.then(operation, operation);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

export function tokenize(text: string, vocab: readonly string[]): number[] {
  const index = new Map<string, number>();
  for (const [position, token] of vocab.entries()) {
    index.set(token, position);
  }
  const unk = index.get(UNK) ?? 0;
  const tokens: number[] = [];
  const parts = text
    .toLocaleLowerCase("en-US")
    .split(/[^a-z0-9]+/u)
    .filter((part) => part.length > 0);
  for (const part of parts) {
    tokens.push(index.get(part) ?? unk);
  }
  if (tokens.length === 0) tokens.push(unk);
  return tokens;
}

export function embedTable(
  table: EmbeddingTable,
  texts: readonly string[],
  pins: { context_size: number; batch_size: number },
): Float32Array[] {
  if (texts.length > pins.batch_size) {
    throw new PortError(
      "budget_exhausted",
      `embed batch ${texts.length} exceeds pinned batch_size ${pins.batch_size}`,
      false,
    );
  }

  const out: Float32Array[] = [];
  for (const text of texts) {
    const tokens = tokenize(text, table.vocab);
    if (tokens.length > pins.context_size) {
      throw new PortError(
        "budget_exhausted",
        `token count ${tokens.length} exceeds pinned context_size ${pins.context_size}`,
        false,
      );
    }
    const vector = new Float32Array(table.dims);
    for (const token of tokens) {
      const row = token * table.dims;
      for (let dim = 0; dim < table.dims; dim += 1) {
        const weight = table.weights[row + dim];
        if (weight === undefined) {
          throw new PortError(
            "unavailable",
            "GGUF embedding table row is incomplete",
            false,
          );
        }
        vector[dim] = (vector[dim] ?? 0) + weight;
      }
    }
    const scale = 1 / tokens.length;
    let norm = 0;
    for (let dim = 0; dim < table.dims; dim += 1) {
      const value = (vector[dim] ?? 0) * scale;
      vector[dim] = value;
      norm += value * value;
    }
    const denom = Math.sqrt(norm);
    if (denom > 0) {
      for (let dim = 0; dim < table.dims; dim += 1) {
        vector[dim] = (vector[dim] ?? 0) / denom;
      }
    }
    if (vector.length !== table.dims) {
      throw new PortError(
        "space_mismatch",
        "embedding produced a vector of the wrong width",
        false,
      );
    }
    out.push(vector);
  }
  return out;
}

export function assertExactDims(
  vectors: readonly Float32Array[],
  dims: number,
): void {
  for (const vector of vectors) {
    if (vector.length !== dims) {
      throw new PortError(
        "space_mismatch",
        `embedding width ${vector.length} does not match space dims ${dims}`,
        false,
      );
    }
  }
}
