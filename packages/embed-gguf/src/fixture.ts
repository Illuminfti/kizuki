import { writeEmbeddingTableGguf, TABLE_ARCHITECTURE } from "./gguf";
import type { EmbeddingTable } from "./gguf";

export const FIXTURE_MODEL_NAME = "kizuki-fixture-embed";
export const FIXTURE_DIMS = 8;
export const FIXTURE_VOCAB = Object.freeze([
  "<unk>",
  "task",
  "search",
  "result",
  "query",
  "title",
  "text",
  "grace",
  "acme",
  "partnerships",
  "contact",
  "email",
  "library",
  "kernel",
  "patch",
]);

export function fixtureSpaceId(): string {
  return `gguf:${FIXTURE_MODEL_NAME}@${FIXTURE_DIMS}`;
}

export function buildFixtureTable(
  overrides: { name?: string; dims?: number } = {},
): EmbeddingTable {
  const dims = overrides.dims ?? FIXTURE_DIMS;
  const name = overrides.name ?? FIXTURE_MODEL_NAME;
  const weights = new Float32Array(FIXTURE_VOCAB.length * dims);
  for (let token = 0; token < FIXTURE_VOCAB.length; token += 1) {
    for (let dim = 0; dim < dims; dim += 1) {
      const angle = ((token + 1) * (dim + 3)) / 7;
      weights[token * dims + dim] = Math.sin(angle);
    }
  }
  return {
    architecture: TABLE_ARCHITECTURE,
    name,
    dims,
    vocab: FIXTURE_VOCAB,
    weights,
  };
}

export function writeFixtureGguf(
  overrides: { name?: string; dims?: number } = {},
): Uint8Array {
  return writeEmbeddingTableGguf(buildFixtureTable(overrides));
}
