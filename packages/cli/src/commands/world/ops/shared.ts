/** The default window of a command-line read. */
export const CURRENT = {
  valid: { kind: "all" },
  knownAt: { kind: "current" },
} as const;

export function coverageLine(coverage: {
  status: string;
  gaps: readonly string[];
  history?: string;
}): string {
  const gaps = coverage.gaps.length === 0 ? "" : ` (${coverage.gaps.join(", ")})`;
  return `Coverage: ${coverage.status}${gaps}${coverage.history === undefined ? "" : `; history: ${coverage.history}`}.`;
}
