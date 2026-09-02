import { registerPort } from "@kizuki/core";
import type { EmbeddingPort, PortRegistry } from "@kizuki/core";
import {
  GGUF_EMBEDDING_DESCRIPTOR,
  createGgufEmbeddingPort,
} from "./port";

export {
  GGUF_EMBEDDING_DESCRIPTOR,
  GGUF_EMBEDDING_ID,
  RSS_CEILING_BYTES,
  GgufEmbeddingPort,
  createGgufEmbeddingPort,
} from "./port";
export {
  PINNED_BATCH_SIZE_MAX,
  PINNED_BATCH_SIZE_MIN,
  PINNED_CONTEXT_SIZE_MAX,
  PINNED_CONTEXT_SIZE_MIN,
  parseGgufEmbeddingConfig,
} from "./config";
export type { GgufEmbeddingConfig } from "./config";
export {
  RECIPE_CHUNK_OVERLAP,
  RECIPE_CHUNK_TOKENS,
  RECIPE_PROMPT_DOC,
  RECIPE_PROMPT_QUERY,
  RECIPE_TOKENIZER_ID,
  spaceFromTable,
  spaceId,
} from "./space";
export {
  GGUF_MODEL_CATALOG,
  installGgufModel,
  sha256File,
  vaultModelsDir,
} from "./models";
export type {
  GgufModelCatalogEntry,
  InstallGgufModelInput,
  InstalledGgufModel,
} from "./models";
export {
  FIXTURE_DIMS,
  FIXTURE_MODEL_NAME,
  FIXTURE_VOCAB,
  buildFixtureTable,
  fixtureSpaceId,
  writeFixtureGguf,
} from "./fixture";
export {
  TABLE_ARCHITECTURE,
  isTransformerArchitecture,
  loadEmbeddingTable,
  parseGguf,
  readGgufFile,
  writeEmbeddingTableGguf,
} from "./gguf";

export function registerGgufEmbedding(registry?: PortRegistry): void {
  if (registry === undefined) {
    registerPort<EmbeddingPort>(
      GGUF_EMBEDDING_DESCRIPTOR,
      createGgufEmbeddingPort,
    );
    return;
  }
  registry.registerPort<EmbeddingPort>(
    GGUF_EMBEDDING_DESCRIPTOR,
    createGgufEmbeddingPort,
  );
}
