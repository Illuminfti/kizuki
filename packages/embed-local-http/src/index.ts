import { registerPort } from "@kizuki/core";
import type { EmbeddingPort, PortRegistry } from "@kizuki/core";
import {
  LOCAL_HTTP_EMBEDDING_DESCRIPTOR,
  createLocalHttpEmbeddingPort,
} from "./port";

export {
  LOCAL_HTTP_EMBEDDING_DESCRIPTOR,
  LOCAL_HTTP_EMBEDDING_ID,
  LocalHttpEmbeddingPort,
  createLocalHttpEmbeddingPort,
} from "./port";
export {
  DEFAULT_BATCH_SIZE,
  DEFAULT_PROMPT_DOC,
  DEFAULT_PROMPT_QUERY,
  DEFAULT_TIMEOUT_MS,
  EMBEDDING_APIS,
  parseLocalHttpEmbeddingConfig,
  parseLoopbackEndpoint,
} from "./config";
export type { EmbeddingApi, LocalHttpEmbeddingConfig } from "./config";
export {
  LOCAL_HTTP_PROVIDER,
  frameDoc,
  frameQuery,
  spaceFromConfig,
} from "./space";
export { TOKENIZER_ID, estimateTokens, truncateToTokens } from "./tokens";

export function registerLocalHttpEmbedding(registry?: PortRegistry): void {
  if (registry === undefined) {
    registerPort<EmbeddingPort>(
      LOCAL_HTTP_EMBEDDING_DESCRIPTOR,
      createLocalHttpEmbeddingPort,
    );
    return;
  }
  registry.registerPort<EmbeddingPort>(
    LOCAL_HTTP_EMBEDDING_DESCRIPTOR,
    createLocalHttpEmbeddingPort,
  );
}
