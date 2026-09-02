import type { Port } from "./ports";

export const LLM_CONTRACT = "kizuki.llm/v1" as const;
export const LLM_CONTRACT_MINOR = 1;
export const LLM_CAPABILITIES = ["chat"] as const;
export type LlmCapability = (typeof LLM_CAPABILITIES)[number];

export interface LlmMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

export interface LlmUsage {
  readonly input_tokens: number;
  readonly output_tokens: number;
}

export interface LlmRequest {
  readonly messages: readonly LlmMessage[];
  readonly max_output_tokens: number;
  readonly deadline_ms: number;
  /**
   * Requests this call may put on the wire, retries included. Omitted leaves
   * the implementation's own retry bound in charge, which is why a caller
   * with a spend budget states it. `contract_minor >= 1`.
   */
  readonly max_attempts?: number;
}

export interface LlmResponse {
  readonly text: string;
  readonly model: string;
  /** What the whole call spent, retries included. */
  readonly usage: LlmUsage;
  /**
   * Requests this call actually put on the wire, retries included. Optional
   * because an implementation written to minor 0 cannot report it; a caller
   * that needs it checks `descriptor.contract_minor >= 1` and otherwise
   * charges one request per call. `contract_minor >= 1`.
   */
  readonly attempts?: number;
}

/**
 * What a call had already spent when it failed. An implementation that has
 * put requests on the wire attaches this to the error it throws, so a caller
 * with a budget charges a failed call for what it really cost rather than for
 * the one request it can infer. Absent below minor 1. `contract_minor >= 1`.
 */
export interface LlmSpend {
  readonly attempts: number;
  readonly input_tokens: number;
  readonly output_tokens: number;
}

export interface LlmPort extends Port {
  readonly model_ref: string | null;
  complete(request: LlmRequest): Promise<LlmResponse>;
}
