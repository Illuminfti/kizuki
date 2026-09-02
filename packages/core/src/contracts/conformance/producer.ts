import {
  PRODUCER_CAPABILITIES,
  PRODUCER_CONTRACT,
} from "../producer";
import type { ProducerPort } from "../producer";
import type {
  ConformanceFixtures,
  ConformanceReport,
} from "./harness";
import type { DrivenConformanceHarness } from "./programmable";
import { runDrivenConformance } from "./programmable";

export type ProducerConformanceHarness<
  F extends ConformanceFixtures = ConformanceFixtures,
> = DrivenConformanceHarness<ProducerPort, F>;

export function runProducerConformance<
  F extends ConformanceFixtures,
>(
  harness: ProducerConformanceHarness<F>,
): Promise<ConformanceReport> {
  return runDrivenConformance(harness, {
    kind: "producer",
    contract: PRODUCER_CONTRACT,
    capabilities: PRODUCER_CAPABILITIES,
  });
}
