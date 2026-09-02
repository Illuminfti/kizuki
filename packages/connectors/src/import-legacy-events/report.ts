import { sanitizeLine } from "../legacy/coerce";
import type { SourceFormat } from "./mapping";
import type { RowSkip } from "./rows";

/**
 * A run record for an event import. It carries positions, column names and
 * counts — never a cell value, because a row's text is the owner's private
 * correspondence and the report may sit outside the vault.
 */

export const LEGACY_EVENTS_REPORT_SCHEMA =
  "kizuki.legacy-events-report/v1" as const;

export const MAX_REPORTED_SKIPS = 1000;

export interface LegacyEventsReport {
  schema: typeof LEGACY_EVENTS_REPORT_SCHEMA;
  generated_at: string;
  mapping_hash: string;
  format: SourceFormat;
  /** Where the whole run started, not just the page that wrote the file. */
  run: {
    from_position: string;
    to_position: string;
    done: boolean;
    restarted: "mapping_changed" | "source_shrank" | null;
  };
  counts: {
    rows: number;
    events: number;
    tombstones: number;
    skipped: number;
    blobs_dropped: number;
    kinds: Record<string, number>;
  };
  /** The first MAX_REPORTED_SKIPS skips, by position only. */
  skipped: RowSkip[];
  columns: {
    consumed: string[];
    metadata: string[] | "rest";
    unknown_in_mapping: string[];
  };
}

function cell(value: string): string {
  return sanitizeLine(value, 200).replace(/\|/g, "\\|");
}

export function renderLegacyEventsReport(report: LegacyEventsReport): string {
  const lines = [
    "# Legacy events import report",
    "",
    `- generated at: ${cell(report.generated_at)}`,
    `- mapping hash: ${cell(report.mapping_hash)}`,
    `- format: ${cell(report.format)}`,
    `- positions: ${report.run.from_position} to ${report.run.to_position}`,
    `- done: ${report.run.done}`,
    `- restarted: ${report.run.restarted ?? "no"}`,
    "",
    "| measure | count |",
    "| --- | --- |",
    `| rows | ${report.counts.rows} |`,
    `| events | ${report.counts.events} |`,
    `| tombstones | ${report.counts.tombstones} |`,
    `| skipped | ${report.counts.skipped} |`,
    `| blobs dropped | ${report.counts.blobs_dropped} |`,
    ...Object.entries(report.counts.kinds).map(
      ([kind, count]) => `| kind ${cell(kind)} | ${count} |`,
    ),
    "",
    "## Columns",
    "",
    `- consumed: ${report.columns.consumed.map(cell).join(", ")}`,
    `- metadata: ${
      report.columns.metadata === "rest"
        ? "rest"
        : report.columns.metadata.map(cell).join(", ")
    }`,
    `- named in the mapping but absent from the source: ${
      report.columns.unknown_in_mapping.length === 0
        ? "none"
        : report.columns.unknown_in_mapping.map(cell).join(", ")
    }`,
    "",
  ];
  if (report.skipped.length > 0) {
    lines.push(
      "## Skipped rows",
      "",
      "| position | reason |",
      "| --- | --- |",
      ...report.skipped.map(
        (skip) => `| ${skip.position} | ${cell(skip.reason)} |`,
      ),
      "",
    );
  }
  return `${lines.join("\n")}\n`;
}
