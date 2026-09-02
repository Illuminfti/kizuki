import { LLM_CAPABILITIES, LLM_CONTRACT } from "../llm";
import type { LlmPort } from "../llm";
import type {
  ConformanceFixtures,
  ConformanceReport,
} from "./harness";
import type { DrivenConformanceHarness } from "./programmable";
import { runDrivenConformance } from "./programmable";

export type LlmConformanceHarness<
  F extends ConformanceFixtures = ConformanceFixtures,
> = DrivenConformanceHarness<LlmPort, F>;

export function runLlmConformance<F extends ConformanceFixtures>(
  harness: LlmConformanceHarness<F>,
): Promise<ConformanceReport> {
  return runDrivenConformance(harness, {
    kind: "llm",
    contract: LLM_CONTRACT,
    capabilities: LLM_CAPABILITIES,
  });
}
