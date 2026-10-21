import { readFileSync } from "node:fs";

/** Peak RSS of this executable's address space, rather than inherited exec history. */
export function peakRssKiB(pid = process.pid): number {
  const status = readFileSync(`/proc/${pid}/status`, "utf8");
  let flags = 0;
  if (!/^VmHWM:/m.test(status)) {
    // exit_mm can release the address space before the task becomes a zombie.
    // PF_EXITING distinguishes that transition from failed live accounting.
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    flags = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[6]);
  }
  return rssFromStatus(status, flags);
}

export function rssFromStatus(status: string, flags = 0): number {
  const match = /^VmHWM:\s+(\d+)\s+kB$/m.exec(status);
  if (match === null && (/^State:\s+Z\b/m.test(status) || Number.isSafeInteger(flags) && (flags & 4) !== 0)) return 0;
  const peak = Number(match?.[1]);
  if (!Number.isSafeInteger(peak) || peak <= 0) throw new Error("rss-accounting-failed");
  return peak;
}
