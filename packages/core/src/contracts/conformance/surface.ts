import {
  SURFACE_CAPABILITIES,
  SURFACE_CONTRACT,
} from "../surface";
import type { SurfacePort } from "../surface";
import type {
  ConformanceFixtures,
  ConformanceReport,
} from "./harness";
import type { DrivenConformanceHarness } from "./programmable";
import { runDrivenConformance } from "./programmable";

export type SurfaceConformanceHarness<
  F extends ConformanceFixtures = ConformanceFixtures,
> = DrivenConformanceHarness<SurfacePort, F>;

export function runSurfaceConformance<
  F extends ConformanceFixtures,
>(
  harness: SurfaceConformanceHarness<F>,
): Promise<ConformanceReport> {
  return runDrivenConformance(harness, {
    kind: "surface",
    contract: SURFACE_CONTRACT,
    capabilities: SURFACE_CAPABILITIES,
  });
}
