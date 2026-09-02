import {
  NOTIFIER_CAPABILITIES,
  NOTIFIER_CONTRACT,
} from "../notifier";
import type { NotifierPort } from "../notifier";
import type {
  ConformanceFixtures,
  ConformanceReport,
} from "./harness";
import type { DrivenConformanceHarness } from "./programmable";
import { runDrivenConformance } from "./programmable";

export type NotifierConformanceHarness<
  F extends ConformanceFixtures = ConformanceFixtures,
> = DrivenConformanceHarness<NotifierPort, F>;

export function runNotifierConformance<
  F extends ConformanceFixtures,
>(
  harness: NotifierConformanceHarness<F>,
): Promise<ConformanceReport> {
  return runDrivenConformance(harness, {
    kind: "notifier",
    contract: NOTIFIER_CONTRACT,
    capabilities: NOTIFIER_CAPABILITIES,
  });
}
