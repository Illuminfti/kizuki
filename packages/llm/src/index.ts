export { readLlmPortConfig } from "./config";
export type { LlmPortConfig } from "./config";

export { LlmRejection, rejectionOf } from "./errors";

export { parseExtractResponse } from "./extract";
export type { ExtractOutcome } from "./extract";

export {
  OPENAI_COMPATIBLE_LLM,
  OPENAI_COMPATIBLE_LLM_ID,
  OpenAiCompatibleLlm,
  estimateTokens,
  openAiCompatibleLlm,
} from "./llm-port";
export type { Clock, LlmPortOverrides } from "./llm-port";

export {
  MODEL_PRODUCER,
  MODEL_PRODUCER_ID,
  ModelProducer,
  modelProducer,
} from "./producer";

export {
  EXTRACT_BATCH,
  EXTRACT_INPUT_CHARS,
  EXTRACT_MAX_CHUNKS,
  EXTRACT_PROMPT_OVERHEAD_CHARS,
  SYSTEM_PROMPT,
  batchEvents,
  buildExtractPrompt,
  clipText,
  escapeFence,
  leaksFence,
  quoteNonce,
} from "./prompt";
export type { ExtractPrompt, PromptContext, QuotedChunk } from "./prompt";

export { readChatAnswer } from "./response";
export type { ProviderAnswer } from "./response";

export { fetchTransport, readBoundedBody } from "./transport";
export type {
  ChatMessage,
  ChatRequest,
  ChatTransport,
  TransportFailure,
  TransportOptions,
  TransportResult,
} from "./transport";
