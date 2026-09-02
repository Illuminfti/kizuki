import type { Port } from "../ports";
import type {
  ConformanceDriver,
  ConformanceFixtures,
  ConformanceHarness,
  ConformanceReport,
  ContractConformanceDefinition,
} from "./harness";
import { runContractConformance } from "./harness";

/**
 * Contracts whose domain operations are supplied by optional packages use a
 * driver to map those operations onto the six common conformance families.
 */
export interface DrivenConformanceHarness<
  T extends Port,
  F extends ConformanceFixtures = ConformanceFixtures,
> extends ConformanceHarness<T, F> {
  readonly driver: ConformanceDriver<T, F>;
}

export function runDrivenConformance<
  T extends Port,
  F extends ConformanceFixtures,
>(
  harness: DrivenConformanceHarness<T, F>,
  definition: ContractConformanceDefinition,
): Promise<ConformanceReport> {
  return runContractConformance(harness, definition, harness.driver);
}
