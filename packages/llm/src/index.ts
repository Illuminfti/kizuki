import type { PortRegistry } from "@kizuki/core";
import { NONE_LLM_DESCRIPTOR, createNoneLlmPort } from "./none";
import {
  OPENAI_COMPATIBLE_LLM_DESCRIPTOR,
  createOpenAiCompatibleLlmPort,
} from "./openai-compatible";

export {
  DEFAULT_MAX_RETRIES,
  DEFAULT_TIMEOUT_MS,
  MAX_RETRIES,
  MAX_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  chatCompletionsUrl,
  endpointHost,
  isLoopbackHost,
  modelRef,
  parseOpenAiCompatibleConfig,
} from "./config";
export type { OpenAiCompatibleLlmConfig } from "./config";
export {
  NONE_LLM_DESCRIPTOR,
  NONE_LLM_ID,
  createNoneLlmPort,
} from "./none";
export {
  OPENAI_COMPATIBLE_LLM_DESCRIPTOR,
  OPENAI_COMPATIBLE_LLM_ID,
  createOpenAiCompatibleLlmPort,
} from "./openai-compatible";
export type { OpenAiCompatibleOptions } from "./openai-compatible";
export { isRetryableStatus, parseChatCompletion } from "./response";
export {
  DEFAULT_MAX_RESPONSE_BYTES,
  fetchTransport,
} from "./transport";
export type {
  ChatTransport,
  TransportFailure,
  TransportRequest,
  TransportResult,
} from "./transport";

export function registerLlmPorts(registry: PortRegistry): void {
  registry.registerPort(NONE_LLM_DESCRIPTOR, createNoneLlmPort);
  registry.registerPort(
    OPENAI_COMPATIBLE_LLM_DESCRIPTOR,
    createOpenAiCompatibleLlmPort,
  );
}
