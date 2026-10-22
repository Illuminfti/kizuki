import { PortError } from "./ports";
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
  /** Aborting ends the request at once with an `unavailable` refusal. */
  readonly signal?: AbortSignal;
}

export interface LlmResponse {
  readonly text: string;
  readonly model: string;
  readonly usage: LlmUsage;
}

export interface LlmPort extends Port {
  readonly model_ref: string | null;
  /** Host-declared conservative input allowance per call; never measured usage. Minor 0 defaults to zero. */
  readonly input_token_overhead?: number;
  complete(request: LlmRequest): Promise<LlmResponse>;
}

/** Strict configuration boundary for the host-declared per-call allowance. */
export function validateInputTokenOverhead(value: unknown = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 32_000) {
    throw new PortError("config_invalid", "input_token_overhead must be a safe integer from 0 to 32000", false);
  }
  return value;
}

/** Older implementations did not declare an allowance. Provider usage never supplies it. */
export function llmInputTokenOverhead(port: LlmPort): number {
  const overhead = validateInputTokenOverhead(port.input_token_overhead);
  if (port.descriptor.contract_minor < 1 && overhead !== 0) {
    throw new PortError("config_invalid", "input_token_overhead requires llm contract minor 1", false);
  }
  return overhead;
}
