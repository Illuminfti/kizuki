import {
  LLM_CAPABILITIES,
  LLM_CONTRACT,
  LLM_CONTRACT_MINOR,
  PortError,
  validatePortDescriptor,
} from "@kizuki/core";
import type {
  LlmPort,
  LlmRequest,
  LlmResponse,
  PortContext,
  PortDescriptor,
  PortHealth,
} from "@kizuki/core";

export const NONE_LLM_ID = "kizuki.llm.none" as const;

export const NONE_LLM_DESCRIPTOR: PortDescriptor = validatePortDescriptor({
  id: NONE_LLM_ID,
  kind: "llm",
  contract: LLM_CONTRACT,
  contract_minor: LLM_CONTRACT_MINOR,
  supports: LLM_CAPABILITIES,
  requires_lease: false,
  optional_package: null,
});

const UNAVAILABLE = "no model configured";

export function createNoneLlmPort(_ctx: PortContext): LlmPort {
  return {
    descriptor: NONE_LLM_DESCRIPTOR,
    model_ref: null,
    async health(): Promise<PortHealth> {
      return { status: "unavailable", reason: UNAVAILABLE };
    },
    complete(_request: LlmRequest): Promise<LlmResponse> {
      return Promise.reject(new PortError("unavailable", UNAVAILABLE, false));
    },
    async close(): Promise<void> {},
  };
}
