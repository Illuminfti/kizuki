import { canonCapacity, loadCanonLimits } from "../vault/canon-limits";
import { fatalCanonSkips, listCanonPagesReport } from "../vault/pages";
import { CanonWriteError } from "./errors";

/**
 * A new page is held once the vault has its configured number of live pages.
 * Every growing forward write reserves inventory resources. Creation and
 * reactivation also require a live slot. Reads and receipt reversal
 * never consult this. Archived pages do not count against the ceiling.
 */
export function requireCanonWriteCapacity(vaultPath: string, newLivePage: boolean, additionalFiles: number, additionalBytes: number): void {
  if (!newLivePage && additionalFiles <= 0 && additionalBytes <= 0) return;
  const report = listCanonPagesReport(vaultPath);
  const limits = loadCanonLimits(vaultPath);
  const capacity = canonCapacity(report.pages, report.truncated, limits);
  if (report.truncated || fatalCanonSkips(report.skipped).length > 0 ||
      report.scanned_files + additionalFiles > limits.walk_files ||
      report.scanned_bytes + Math.max(0, additionalBytes) > limits.walk_bytes) {
    throw new CanonWriteError("canon_scan_incomplete", "canon inventory is incomplete or the write exceeds its resource budget; raise max_scan_files or max_scan_bytes under [canon] in .kizuki/serve.toml; run kizuki doctor");
  }
  if (!newLivePage || capacity.state !== "full") return;
  throw new CanonWriteError(
    "canon_ceiling",
    `canon_ceiling: ${capacity.live} live pages, ceiling ${capacity.ceiling}; new pages are held and reads continue; ${capacity.next}`,
  );
}
