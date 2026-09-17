import {
  SYSTEMONE_CAPABILITIES,
  SYSTEMONE_CONTRACT,
} from "../systemone";
import type { SystemOnePort } from "../systemone";
import type {
  ConformanceFixtures,
  ConformanceReport,
} from "./harness";
import type { DrivenConformanceHarness } from "./programmable";
import { runDrivenConformance } from "./programmable";

export type SystemOneConformanceHarness<
  F extends ConformanceFixtures = ConformanceFixtures,
> = DrivenConformanceHarness<SystemOnePort, F>;

export function runSystemOneConformance<F extends ConformanceFixtures>(
  harness: SystemOneConformanceHarness<F>,
): Promise<ConformanceReport> {
  return runDrivenConformance(harness, {
    kind: "systemone",
    contract: SYSTEMONE_CONTRACT,
    capabilities: SYSTEMONE_CAPABILITIES,
  });
}
