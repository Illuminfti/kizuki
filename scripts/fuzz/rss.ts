import { readFileSync } from "node:fs";

/** Peak RSS of this executable's address space, rather than inherited exec history. */
export function peakRssKiB(pid = process.pid): number {
  const status = readFileSync(`/proc/${pid}/status`, "utf8");
  const match = /^VmHWM:\s+(\d+)\s+kB$/m.exec(status);
  // Exit can race the parent's sample; zombies no longer have an address space.
  if (match === null && /^State:\s+Z\b/m.test(status)) return 0;
  const peak = Number(match?.[1]);
  if (!Number.isSafeInteger(peak) || peak <= 0) throw new Error("rss-accounting-failed");
  return peak;
}
