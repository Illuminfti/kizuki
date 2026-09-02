export { LlmError } from "./errors";
export type { LlmErrorCode } from "./errors";

export {
  LLM_CONFIG_DEFAULTS,
  LLM_CONFIG_PATH,
  UNLABELED_MODES,
  endpointHost,
  isLoopbackUrl,
  parseLlmConfig,
  readLlmConfig,
  removeLlmConfig,
  serializeLlmConfig,
  writeLlmConfig,
} from "./config";
export type { LlmConfig, UnlabeledMode } from "./config";

export { resolveApiKey } from "./secrets";

export { fetchTransport } from "./transport";
export type {
  ChatMessage,
  ChatRequest,
  ChatTransport,
  TransportFailure,
  TransportOptions,
  TransportResult,
} from "./transport";
