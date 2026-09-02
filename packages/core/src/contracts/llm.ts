import type { Port } from "./ports";

export const LLM_CONTRACT = "kizuki.llm/v1" as const;
export const LLM_CONTRACT_MINOR = 0;
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
}

export interface LlmResponse {
  readonly text: string;
  readonly model: string;
  readonly usage: LlmUsage;
}

export interface LlmPort extends Port {
  readonly model_ref: string | null;
  complete(request: LlmRequest): Promise<LlmResponse>;
}
