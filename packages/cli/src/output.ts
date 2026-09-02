import { sanitize } from "@kizuki/tui";
import type { RunResult } from "@kizuki/core";

export function clean(text: string): string {
  return sanitize(text).replace(/\s+/g, " ").trim();
}

export function jsonLine(value: unknown): string {
  return JSON.stringify(value);
}

export function table(rows: string[][]): string[] {
  if (rows.length === 0) return [];
  const widths: number[] = [];
  for (const row of rows) {
    for (let column = 0; column < row.length; column += 1) {
      const width = row[column]?.length ?? 0;
      widths[column] = Math.max(widths[column] ?? 0, width);
    }
  }
  return rows.map((row) =>
    row
      .map((value, column) =>
        column < row.length - 1
          ? value.padEnd(widths[column] ?? value.length)
          : value,
      )
      .join("  ")
      .trimEnd(),
  );
}

export function formatRunCounts(result: RunResult): string {
  return [
    `events_stored=${result.stored}`,
    `duplicates=${result.duplicates}`,
    `proposals_created=${result.proposals_created}`,
    `withdrawn=${result.withdrawn}`,
    `retractions_filed=${result.retractions_filed}`,
    `errors=${result.errors.length}`,
  ].join(" ");
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
