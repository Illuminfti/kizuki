import type { SourceCoverageReport } from "@kizuki/core/world";
import { clean } from "./output";

export function sourceCoverageLines(coverage: SourceCoverageReport): string[] {
  const value = (count: number | null) => count === null ? "unknown" : String(count);
  return [
    `coverage source=${coverage.source_key} scanned=${value(coverage.scanned)} ingested=${coverage.ingested} excluded=${coverage.excluded.reduce((n, rule) => n + rule.count, 0)} pending=${value(coverage.pending)} failed=${value(coverage.failed)} first_occurred_at=${coverage.first_occurred_at ?? "-"} last_occurred_at=${coverage.last_occurred_at ?? "-"} backfill_complete=${coverage.backfill_complete ? "yes" : "no"} backfill_state=${coverage.backfill_state} last_successful_pass_at=${coverage.last_successful_pass_at ?? "never"} last_error_class=${coverage.last_error_class ?? "-"}`,
    ...coverage.blind_spots.map(gap => `blind spot source=${coverage.source_key} ${gap.reason}: ${clean(gap.detail)} Next: ${clean(gap.next_step)}`),
  ];
}
