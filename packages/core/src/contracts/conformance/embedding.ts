import {
  EMBEDDING_CAPABILITIES,
  EMBEDDING_CONTRACT,
} from "../embedding";
import type { EmbeddingPort } from "../embedding";
import type {
  ConformanceFixtures,
  ConformanceReport,
} from "./harness";
import type { DrivenConformanceHarness } from "./programmable";
import { runDrivenConformance } from "./programmable";

export type EmbeddingConformanceHarness<
  F extends ConformanceFixtures = ConformanceFixtures,
> = DrivenConformanceHarness<EmbeddingPort, F>;

export function runEmbeddingConformance<
  F extends ConformanceFixtures,
>(
  harness: EmbeddingConformanceHarness<F>,
): Promise<ConformanceReport> {
  return runDrivenConformance(harness, {
    kind: "embedding",
    contract: EMBEDDING_CONTRACT,
    capabilities: EMBEDDING_CAPABILITIES,
  });
}
