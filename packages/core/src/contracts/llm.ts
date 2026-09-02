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
  readonly usage: LlmUsage;
  /** Requests this call actually put on the wire. `contract_minor >= 1`. */
  readonly attempts: number;
}

export interface LlmPort extends Port {
  readonly model_ref: string | null;
  complete(request: LlmRequest): Promise<LlmResponse>;
}
