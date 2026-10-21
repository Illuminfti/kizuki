import { parseWorldKnownAt, parseWorldValid } from "@kizuki/core/world";
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

export const KNOWN_OPTIONS = ["--known-at", "--snapshot", "--valid-at"] as const;
export const KNOWN_BOUNDS = { "--known-at": "RFC3339 recorded-time cutoff", "--snapshot": "32-byte base64url snapshot token", "--valid-at": "RFC3339 effective time" };
export function temporalInput(options: ReadonlyMap<string, string>) {
  if (options.has("--known-at") && options.has("--snapshot")) return null;
  const knownAt = parseWorldKnownAt(options.has("--snapshot")
    ? { kind: "snapshot", ref: { kind: "snapshot", token: options.get("--snapshot") } }
    : options.has("--known-at") ? { kind: "time", at: options.get("--known-at") } : CURRENT.knownAt);
  const valid = parseWorldValid(options.has("--valid-at") ? { kind: "at", at: options.get("--valid-at") } : CURRENT.valid);
  return knownAt === null || valid === null ? null : { knownAt, valid };
}
