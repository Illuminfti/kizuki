/**
 * The line diff moved into core when the correction path began reporting the
 * rewrite it performed: one implementation, two readers. The TUI caps the
 * result so a single oversized page cannot exhaust the audit screen.
 */
import { diffLines } from "@kizuki/core";
import type { DiffLine } from "@kizuki/core";

export { diffLines } from "@kizuki/core";
export type { DiffLine } from "@kizuki/core";

export const DIFF_LINE_CAP = 200;
export const DIFF_CHAR_CAP = 16_000;

export interface BoundedDiff {
  lines: DiffLine[];
  truncated: boolean;
  beforeChars: number;
  afterChars: number;
}

export function boundedDiff(before: string, after: string): BoundedDiff {
  const clippedBefore =
    before.length > DIFF_CHAR_CAP ? before.slice(0, DIFF_CHAR_CAP) : before;
  const clippedAfter = after.length > DIFF_CHAR_CAP ? after.slice(0, DIFF_CHAR_CAP) : after;
  const raw = diffLines(clippedBefore, clippedAfter);
  const truncated =
    raw.length > DIFF_LINE_CAP || before.length > DIFF_CHAR_CAP || after.length > DIFF_CHAR_CAP;
  return {
    lines: raw.slice(0, DIFF_LINE_CAP),
    truncated,
    beforeChars: before.length,
    afterChars: after.length,
  };
}
