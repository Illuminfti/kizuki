import { canonCapacity, loadCanonLimits } from "../vault/canon-limits";
import { fatalCanonSkips, listCanonPagesReport } from "../vault/pages";
import { CanonWriteError } from "./errors";

/**
 * A new page is held once the vault has its configured number of live pages.
 * Creation and reactivation require a live slot. Reads and receipt reversal
 * never consult this. Archived pages do not count against the ceiling.
 */
export function requireRoomForNewPage(vaultPath: string): void {
  const report = listCanonPagesReport(vaultPath);
  const capacity = canonCapacity(report.pages, report.truncated, loadCanonLimits(vaultPath));
  if (report.truncated || fatalCanonSkips(report.skipped).length > 0) {
    throw new CanonWriteError("canon_scan_incomplete", `canon capacity cannot be established; run kizuki doctor${capacity.next === null ? "" : `; ${capacity.next}`}`);
  }
  if (capacity.state !== "full") return;
  throw new CanonWriteError(
    "canon_ceiling",
    `canon_ceiling: ${capacity.live} live pages, ceiling ${capacity.ceiling}; new pages are held and reads continue; ${capacity.next}`,
  );
}
