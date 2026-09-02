import { PortError } from "../ports";
import {
  CANON_STORE_CONTRACT,
  JOURNAL_STORE_CONTRACT,
  LEDGER_STORE_CONTRACT,
  STORAGE_CAPABILITIES,
} from "../storage";
import type { StoragePort } from "../storage";
import type {
  ConformanceFixtures,
  ConformanceReport,
} from "./harness";
import type { DrivenConformanceHarness } from "./programmable";
import { runDrivenConformance } from "./programmable";

export type StorageConformanceHarness<
  F extends ConformanceFixtures = ConformanceFixtures,
> = DrivenConformanceHarness<StoragePort, F>;

export function runStorageConformance<
  F extends ConformanceFixtures,
>(
  harness: StorageConformanceHarness<F>,
): Promise<ConformanceReport> {
  const kind = harness.descriptor.kind;
  const contract =
    kind === "ledger-store"
      ? LEDGER_STORE_CONTRACT
      : kind === "canon-store"
        ? CANON_STORE_CONTRACT
        : kind === "journal-store"
          ? JOURNAL_STORE_CONTRACT
          : null;
  if (contract === null) {
    throw new PortError(
      "contract_mismatch",
      "storage conformance requires a storage port kind",
      false,
    );
  }
  return runDrivenConformance(harness, {
    kind,
    contract,
    capabilities: STORAGE_CAPABILITIES,
  });
}
