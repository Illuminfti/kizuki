import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { constants } from "node:os";

const SYSCALLS = ["openat", "newfstatat", "statx", "fstat", "close", "fsync", "fdatasync", "fcntl", "memfd_create", "read", "pread64"] as const;
const NAMES = new Set<string>(SYSCALLS);
const MAX_TRACE_BYTES = 65_536;
const MAX_ROWS = 160;
const KNOWN_NAMES = new Set(["/", ".", "..", ".kizuki", "serve.pid", "serve-stop.json", "dashboards", "writer.lock"]);

/** Closed projection: never retain buffers, arbitrary paths, strings or errors. */
export function projectNativeSyscallTrace(raw: string, fixtureRoot: string) {
  const rows: { syscall: string; result: number | null; errno: string | null; path: string | null }[] = [];
  let discarded = 0;
  const limited = raw.slice(0, MAX_TRACE_BYTES);
  for (const line of limited.split("\n")) {
    if (rows.length === MAX_ROWS) break;
    const match = /\b([a-z0-9_]+)\((.*)\)\s+=\s+(-?\d+|0x[0-9a-f]+|\?)\s*(E[A-Z0-9_]+)?(?:\s|$)/.exec(line);
    if (!match || !NAMES.has(match[1]!)) { if (line) discarded++; continue; }
    const firstString = /"([^"\\]*)"/.exec(match[2]!)?.[1];
    // Names from outside the unique fixture and unknown relative names are
    // reduced to categories, including any libc/runtime metadata paths.
    const path = firstString === undefined ? null : KNOWN_NAMES.has(firstString) ? firstString
      : firstString.startsWith(`${fixtureRoot}/`) ? "<fixture-path>"
      : firstString.startsWith("/proc/") ? "<proc-path>"
      : firstString.startsWith("/") ? "<external-path>" : "<relative-path>";
    const value = Number(match[3]);
    rows.push({ syscall: match[1]!, result: Number.isSafeInteger(value) ? value : null,
      errno: match[4] !== undefined && Object.hasOwn(constants.errno, match[4]) ? match[4] : null, path });
  }
  return { rows, discarded, truncated: raw.length > MAX_TRACE_BYTES || rows.length === MAX_ROWS };
}

export interface SyntheticTraceTarget {
  readonly fixtureRoot: string;
  readonly vault: string;
  readonly binary: string;
  readonly pid: number;
  readonly instanceId: string;
}

/** Internal harness gate. It is intentionally unusable outside ephemeral CI. */
export function syntheticTraceTargetMatches(target: SyntheticTraceTarget): boolean {
  try {
    if (process.platform !== "linux" || process.env.GITHUB_ACTIONS !== "true" || process.env.CI !== "true" ||
      !Number.isSafeInteger(target.pid) || target.pid < 1 || !target.instanceId) return false;
    const fixture = realpathSync(target.fixtureRoot);
    const runnerTemp = process.env.RUNNER_TEMP;
    if (!runnerTemp || !fixture.startsWith(`${realpathSync(runnerTemp)}/kizuki native lifecycle `) ||
      fixture !== resolve(target.fixtureRoot) || target.vault !== join(fixture, "synthetic vault") ||
      target.binary !== join(fixture, "installed package", "kizuki")) return false;
    if (realpathSync(`/proc/${target.pid}/exe`) !== realpathSync(target.binary) ||
      realpathSync(`/proc/${target.pid}/cwd`) !== realpathSync(target.vault)) return false;
    const argv = readFileSync(`/proc/${target.pid}/cmdline`);
    if (argv.length > 8192 || argv.toString("utf8") !== [target.binary, "serve", "--vault", target.vault, ""].join("\0")) return false;
    const bytes = readFileSync(join(target.vault, ".kizuki/serve.pid"));
    if (bytes.length > 4096) return false;
    const marker: unknown = JSON.parse(bytes.toString("utf8"));
    if (!marker || typeof marker !== "object" || Array.isArray(marker)) return false;
    const value = marker as Record<string, unknown>;
    return value.pid === target.pid && value.instance_id === target.instanceId;
  } catch { return false; }
}

/** Trace the exact owned synthetic service for three seconds, without buffers. */
export function captureSyntheticServiceTrace(target: SyntheticTraceTarget) {
  const available = { strace: existsSync("/usr/bin/strace"), timeout: existsSync("/usr/bin/timeout"), sudo: existsSync("/usr/bin/sudo") };
  const base = { available, synthetic_only: true, duration_ms: 3000, output_limit_bytes: MAX_TRACE_BYTES };
  if (!available.strace || !available.timeout || !available.sudo) return { ...base, status: "tool_unavailable" };
  if (!syntheticTraceTargetMatches(target)) return { ...base, status: "target_unverified" };
  try {
    const command = ["/usr/bin/sudo", "-n", "--", "/usr/bin/timeout", "--signal=INT", "--kill-after=1s", "3s",
      "/usr/bin/strace", "-f", "-qq", "-p", String(target.pid), "-s", "256",
      "-e", `trace=${SYSCALLS.join(",")}`, "-e", "raw=read,pread64"];
    const result = Bun.spawnSync(command, { env: { PATH: "/usr/bin:/bin", LANG: "C", HOME: join(target.fixtureRoot, "home") },
      cwd: target.fixtureRoot, stdin: "ignore", stdout: "ignore", stderr: "pipe", timeout: 5000, maxBuffer: MAX_TRACE_BYTES });
    const raw = result.stderr.toString();
    const projected = projectNativeSyscallTrace(raw, target.fixtureRoot);
    const failure = /sudo:.*(?:password|not allowed)/i.test(raw) ? "sudo_denied"
      : /(?:ptrace|attach).*operation not permitted/i.test(raw) ? "attach_denied"
      : projected.rows.length === 0 ? "no_syscalls_observed" : null;
    // No raw strace output is persisted, including sudo/ptrace diagnostics.
    return { ...base, status: projected.rows.length > 0 ? "captured" : "trace_unavailable", exit_code: result.exitCode,
      target_still_matches: syntheticTraceTargetMatches(target), failure, ...projected,
      truncated: projected.truncated || result.stderr.byteLength >= MAX_TRACE_BYTES };
  } catch { return { ...base, status: "trace_failed" }; }
}
