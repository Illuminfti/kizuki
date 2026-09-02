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
export type { LlmConfig, LlmConfigDefaults, UnlabeledMode } from "./config";

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

export { ChatClient } from "./client";
export type {
  ChatClientOptions,
  ChatOutcome,
  ChatUsage,
  ClientCounters,
  Clock,
} from "./client";

export { PRODUCERS, PROMPT_VERSION, systemPrompt, wrapEvent } from "./prompt";
export type { ProducerName, WrappedEvent, WrappedInput } from "./prompt";

export {
  ENTITY_TYPES,
  OUTPUT_LIMITS,
  parseModelJson,
  sanitizeBlock,
  sanitizeLine,
  validateClaims,
  validateEntities,
  validateSummary,
} from "./output";
export type {
  ClaimAtom,
  ClaimsOutput,
  EntitiesOutput,
  EntityCandidate,
  EntityType,
  OutputResult,
  SummaryOutput,
} from "./output";

export {
  CONFIDENCE_CAPS,
  claimsDraft,
  entityDrafts,
  entityTarget,
  slugify,
  summaryDraft,
  targetRelPath,
} from "./drafts";
export type { DraftContext } from "./drafts";

export { initLlm, lastRun, listRuns } from "./schema";
export type {
  EnrichmentOutcome,
  EnrichmentRecord,
  LlmRun,
  StopReason,
} from "./schema";

export { runEnrichment } from "./run";
export type {
  EnrichCounts,
  EnrichOptions,
  EnrichReceipt,
  RequestError,
} from "./run";
