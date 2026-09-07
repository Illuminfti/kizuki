import { closeSync, existsSync, openSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { constants } from "node:os";

const SYSCALLS = ["openat", "newfstatat", "statx", "fstat", "close", "fsync", "fdatasync", "fcntl", "memfd_create", "read", "pread64", "getdents64", "readlink", "readlinkat"] as const;
const NAMES = new Set<string>(SYSCALLS);
const MAX_TRACE_BYTES = 65_536;
const KNOWN_NAMES = new Set(["/", ".", "..", ".kizuki", "serve.pid", "serve-stop.json", "dashboards", "writer.lock"]);
const UINT32_MAX = 0xffff_ffff;
const UINT64_MAX = (1n << 64n) - 1n;
const FILE_TYPES: Readonly<Record<string, number>> = {
  S_IFIFO: 0o010000, S_IFCHR: 0o020000, S_IFDIR: 0o040000, S_IFBLK: 0o060000,
  S_IFREG: 0o100000, S_IFLNK: 0o120000, S_IFSOCK: 0o140000,
};
type StatMetadata = { uid?: number; gid?: number; mode?: number; type?: number; ino?: string; dev?: string; dev_major?: number; dev_minor?: number };

function unsigned(value: string, maximum: bigint): bigint {
  if (!/^(?:0|[1-9][0-9]{0,19}|0x[0-9a-f]{1,16})$/.test(value)) throw Error("invalid number");
  const parsed = BigInt(value);
  if (parsed > maximum) throw Error("number out of bounds");
  return parsed;
}

/** Extract only top-level numeric stat fields; quoted strings never supply them. */
function statMetadata(syscall: string, args: string): StatMetadata | null {
  if (!["statx", "newfstatat", "fstat"].includes(syscall)) return null;
  const unquoted = args.replace(/"(?:\\.|[^"\\])*"/g, '""');
  const start = unquoted.indexOf("{"), end = unquoted.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  const fields = new Map<string, string>();
  let depth = 0, offset = start + 1;
  try {
    for (let i = offset; i <= end; i++) {
      const char = unquoted[i];
      if (i === end || (char === "," && depth === 0)) {
        const field = /^([a-z_]+)=(.*)$/.exec(unquoted.slice(offset, i).trim());
        if (field) {
          if (fields.has(field[1]!)) return null;
          fields.set(field[1]!, field[2]!.trim());
        }
        offset = i + 1;
      } else if (char === "{" || char === "(") depth++;
      else if (char === "}" || char === ")") { if (--depth < 0) return null; }
    }
    if (depth !== 0) return null;
    const prefix = syscall === "statx" ? "stx_" : "st_", metadata: StatMetadata = {};
    for (const key of ["uid", "gid"] as const) {
      const value = fields.get(prefix + key);
      if (value !== undefined) metadata[key] = Number(unsigned(value, BigInt(UINT32_MAX)));
    }
    const mode = fields.get(prefix + "mode");
    if (mode !== undefined) {
      const symbolic = /^(S_IF[A-Z]+)\|(0[0-7]{3,4})$/.exec(mode);
      if (symbolic && Object.hasOwn(FILE_TYPES, symbolic[1]!)) metadata.mode = FILE_TYPES[symbolic[1]!]! | parseInt(symbolic[2]!, 8);
      else if (/^0[0-7]{3,6}$/.test(mode)) metadata.mode = parseInt(mode, 8);
      else return null;
      if (metadata.mode > 0xffff || !Object.values(FILE_TYPES).includes(metadata.mode & 0o170000)) return null;
      metadata.type = metadata.mode & 0o170000;
    }
    const ino = fields.get(prefix + "ino");
    if (ino !== undefined) metadata.ino = unsigned(ino, UINT64_MAX).toString();
    if (syscall === "statx") {
      for (const key of ["dev_major", "dev_minor"] as const) {
        const value = fields.get(prefix + key);
        if (value !== undefined) metadata[key] = Number(unsigned(value, BigInt(UINT32_MAX)));
      }
    } else {
      const dev = fields.get("st_dev");
      if (dev !== undefined) {
        const pair = /^makedev\(([^,]+),\s*([^,]+)\)$/.exec(dev);
        if (pair) {
          metadata.dev_major = Number(unsigned(pair[1]!, BigInt(UINT32_MAX)));
          metadata.dev_minor = Number(unsigned(pair[2]!, BigInt(UINT32_MAX)));
        } else metadata.dev = unsigned(dev, UINT64_MAX).toString();
      }
    }
    return Object.keys(metadata).length === 0 ? null : metadata;
  } catch { return null; }
}

/** Closed projection: never retain buffers, arbitrary paths, strings or errors. */
export function projectNativeSyscallTrace(raw: string, fixtureRoot: string) {
  type Row = { syscall: string; result: number | null; errno: string | null; path: string | null; metadata?: StatMetadata };
  const first = new Map<number, Row>(), last = new Map<number, Row>(), failures = new Map<number, Row>();
  let matched = 0;
  let discarded = 0;
  const limited = raw.slice(0, MAX_TRACE_BYTES);
  for (const line of limited.split("\n")) {
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
    const row: Row = { syscall: match[1]!, result: Number.isSafeInteger(value) ? value : null,
      errno: match[4] !== undefined && Object.hasOwn(constants.errno, match[4]) ? match[4] : null, path };
    const metadata = value === 0 && match[4] === undefined ? statMetadata(row.syscall, match[2]!) : null;
    if (metadata !== null) row.metadata = metadata;
    const index = matched++;
    if (first.size < 80) first.set(index, row);
    last.set(index, row); if (last.size > 40) last.delete(last.keys().next().value!);
    if (row.errno !== null) {
      failures.set(index, row); if (failures.size > 40) failures.delete(failures.keys().next().value!);
    }
  }
  // Keep the start, the tail, and recent errors independently; routine calls
  // cannot consume the entire diagnostic budget before the failure appears.
  const rows = [...new Map([...first, ...last, ...failures]).entries()].sort(([a], [b]) => a - b).map(([, row]) => row);
  return { rows, discarded, omitted_rows: matched - rows.length, truncated: raw.length > MAX_TRACE_BYTES || matched > rows.length };
}

export interface SyntheticTraceTarget {
  readonly fixtureRoot: string;
  readonly vault: string;
  readonly binary: string;
  readonly pid: number;
  readonly instanceId: string;
}

/** Bounded, closed Linux namespace ID map; no original text is retained. */
export function projectNativeIdMap(raw: string): { inside: number; outside: number; length: number }[] | null {
  if (raw.length > 16_384 || !raw.endsWith("\n")) return null;
  const lines = raw.trim().split("\n");
  if (lines.length > 340 || !lines[0]) return null;
  const rows: { inside: number; outside: number; length: number }[] = [];
  for (const line of lines) {
    const match = /^\s*([0-9]{1,10})\s+([0-9]{1,10})\s+([0-9]{1,10})\s*$/.exec(line);
    if (!match) return null;
    const inside = Number(match[1]), outside = Number(match[2]), length = Number(match[3]);
    if (length < 1 || inside + length > UINT32_MAX || outside + length > UINT32_MAX) return null;
    rows.push({ inside, outside, length });
  }
  for (const key of ["inside", "outside"] as const) {
    const ordered = [...rows].sort((a, b) => a[key] - b[key]);
    if (ordered.some((row, i) => i > 0 && row[key] < ordered[i - 1]![key] + ordered[i - 1]!.length)) return null;
  }
  return rows;
}

function readIdMap(path: string) {
  const fd = openSync(path, "r"), buffer = Buffer.alloc(16_385);
  try {
    let length = 0;
    while (length < buffer.length) {
      const n = readSync(fd, buffer, length, buffer.length - length, null);
      if (n === 0) break;
      length += n;
    }
    return projectNativeIdMap(buffer.subarray(0, length).toString("utf8"));
  } finally { closeSync(fd); }
}

/** Exact verified synthetic process only; never enter or query arbitrary namespaces. */
export function captureSyntheticServiceIdentity(target: SyntheticTraceTarget) {
  if (!syntheticTraceTargetMatches(target)) return { status: "target_unverified" };
  let uid_map: ReturnType<typeof projectNativeIdMap> = null, gid_map: ReturnType<typeof projectNativeIdMap> = null;
  let root: StatMetadata | null = null;
  try { uid_map = readIdMap(`/proc/${target.pid}/uid_map`); } catch { /* Numeric evidence unavailable. */ }
  try { gid_map = readIdMap(`/proc/${target.pid}/gid_map`); } catch { /* Numeric evidence unavailable. */ }
  try {
    const named = statSync(`/proc/${target.pid}/root`, { bigint: true });
    if (named.isDirectory()) root = {
      uid: Number(unsigned(String(named.uid), BigInt(UINT32_MAX))), gid: Number(unsigned(String(named.gid), BigInt(UINT32_MAX))),
      mode: Number(unsigned(String(named.mode), 0xffffn)), type: Number(named.mode & 0o170000n),
      dev: unsigned(String(named.dev), UINT64_MAX).toString(), ino: unsigned(String(named.ino), UINT64_MAX).toString(),
    };
  } catch { /* Named root metadata unavailable. */ }
  if (!syntheticTraceTargetMatches(target)) return { status: "target_changed" };
  return { status: uid_map !== null || gid_map !== null || root !== null ? "captured" : "metadata_unavailable", uid_map, gid_map, root };
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
      "/usr/bin/strace", "-f", "-qq", "-v", "-p", String(target.pid), "-s", "256",
      "-e", `trace=${SYSCALLS.join(",")}`, "-e", "raw=read,pread64,getdents64,readlink,readlinkat"];
    const result = Bun.spawnSync(command, { env: { PATH: "/usr/bin:/bin", LANG: "C", HOME: join(target.fixtureRoot, "home") },
      cwd: target.fixtureRoot, stdin: "ignore", stdout: "ignore", stderr: "pipe", timeout: 5000, maxBuffer: MAX_TRACE_BYTES });
    const raw = result.stderr.toString();
    const projected = projectNativeSyscallTrace(raw, target.fixtureRoot);
    const failure = /sudo:.*(?:password|not allowed)/i.test(raw) ? "sudo_denied"
      : /(?:ptrace|attach).*operation not permitted/i.test(raw) ? "attach_denied"
      : projected.rows.length === 0 ? "no_syscalls_observed" : null;
    // No raw strace output is persisted, including sudo/ptrace diagnostics.
    return { ...base, status: projected.rows.length > 0 ? "captured" : "trace_unavailable", exit_code: result.exitCode,
      target_still_matches: syntheticTraceTargetMatches(target), identity: captureSyntheticServiceIdentity(target), failure, ...projected,
      truncated: projected.truncated || result.stderr.byteLength >= MAX_TRACE_BYTES };
  } catch { return { ...base, status: "trace_failed" }; }
}
