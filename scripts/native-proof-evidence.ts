/** Bounded local evidence reads. Requires exclusive operator custody, not a hostile host. */
import { createHash } from "node:crypto";
import { closeSync, constants, copyFileSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { parseBuildInfoValue } from "./stranger-proof";
export const PACKAGE_FILES = ["kizuki", "kizuki-mcp", "README.txt", "BUILD.json", "SHA256SUMS"] as const;
export const SUPPORTED_BUN_VERSION = readFileSync(resolve(import.meta.dir, "../.bun-version"), "utf8").trim();
export const hash = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
export class EvidenceError extends Error { constructor(readonly reason: string) { super(reason); } }
export function reject(reason: string): never { throw new EvidenceError(reason); }
export function exact(value: unknown, keys: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== keys.split(",").sort().join()) reject("invalid-schema");
  return value as Record<string, unknown>;
}
export function text(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) reject("invalid-string");
  return value;
}
export function digest(value: unknown, length = 64): string {
  if (typeof value !== "string" || value.length !== length || !/^[a-f0-9]+$/.test(value)) reject("invalid-digest");
  return value;
}
export function absolute(value: unknown): string {
  const path = text(value);
  if (!isAbsolute(path) || resolve(path) !== path) reject("noncanonical-path");
  return path;
}
/** Structural JSON equality; object property order carries no authority. */
export function equalJson(left: unknown, right: unknown, depth = 0): boolean {
  if (depth > 32) return false;
  if (left === right) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => equalJson(value, right[index], depth + 1));
  const a = Object.keys(left).sort(), b = Object.keys(right).sort();
  return a.length === b.length && a.every((key, index) => key === b[index] && equalJson((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key], depth + 1));
}
/** JSON.parse alone silently accepts contradictory duplicate object keys. */
export function json(bytes: Buffer): unknown {
  const raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const stack: (Set<string> | null)[] = [];
  for (const token of raw.matchAll(/"(?:[^"\\]|\\.)*"|[{}\[\]]/g)) {
    const value = token[0];
    if (value === "{" || value === "[") { stack.push(value === "{" ? new Set() : null); if (stack.length > 32) reject("json-depth-limit"); }
    else if (value === "}" || value === "]") stack.pop();
    else {
      let after = token.index + value.length;
      while (after < raw.length && /\s/.test(raw[after]!)) after++;
      if (raw[after] === ":") {
        const keys = stack.at(-1), key = JSON.parse(value) as string;
        if (keys?.has(key)) reject("duplicate-json-key"); keys?.add(key);
      }
    }
  }
  return JSON.parse(raw) as unknown;
}

/** Reject static symlinks and detect identity changes during the read. The local
 * operator must retain exclusive custody; this is not hostile-host attestation. */
export function parents(path: string) {
  const rows: { path: string; dev: bigint; ino: bigint }[] = [];
  let current = parse(path).root;
  for (const part of dirname(path).slice(current.length).split("/").filter(Boolean)) {
    current = join(current, part); const stat = lstatSync(current, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) reject("unsafe-path");
    rows.push({ path: current, dev: stat.dev, ino: stat.ino });
  }
  return () => { for (const row of rows) { const stat = lstatSync(row.path, { bigint: true }); if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== row.dev || stat.ino !== row.ino) reject("path-changed"); } };
}
export function read(path: string, limit: number, retain = true) {
  absolute(path); const checkParents = parents(path);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(limit)) reject("unsafe-file-or-size");
    const size = Number(before.size), buffer = Buffer.alloc(Math.min(size + 1, 65536));
    const chunks: Buffer[] = [], state = createHash("sha256"); let offset = 0;
    while (offset < size) {
      const count = readSync(fd, buffer, 0, Math.min(buffer.length, size - offset), offset);
      if (!count) reject("file-changed");
      const chunk = buffer.subarray(0, count); state.update(chunk); if (retain) chunks.push(Buffer.from(chunk)); offset += count;
    }
    if (readSync(fd, buffer, 0, 1, offset) !== 0) reject("file-changed");
    const after = fstatSync(fd, { bigint: true }), named = lstatSync(path, { bigint: true });
    if (after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs || after.nlink !== 1n || named.isSymbolicLink() || named.dev !== after.dev || named.ino !== after.ino) reject("file-changed");
    const unchanged = () => {
      checkParents(); const stat = lstatSync(path, { bigint: true });
      if (!stat.isFile() || stat.isSymbolicLink() || stat.dev !== before.dev || stat.ino !== before.ino || stat.size !== before.size || stat.mtimeNs !== before.mtimeNs || stat.ctimeNs !== before.ctimeNs || stat.nlink !== 1n) reject("file-changed");
    };
    unchanged(); return { sha256: state.digest("hex"), bytes: retain ? Buffer.concat(chunks) : Buffer.alloc(0), unchanged };
  } finally { closeSync(fd); }
}

export function verifyPackage(directory: string, candidate: string, target?: string) {
  const files = Object.fromEntries(PACKAGE_FILES.map(name => [name, read(join(directory, name), name === "kizuki" || name === "kizuki-mcp" ? 268435456 : 65536, name === "BUILD.json" || name === "SHA256SUMS")]));
  const build = parseBuildInfoValue(json(files["BUILD.json"]!.bytes));
  if (build.source_sha !== candidate || (target !== undefined && build.target !== target)) reject("build-identity-mismatch");
  if (build.bun_version !== SUPPORTED_BUN_VERSION) reject("unsupported-package-bun-version");
  const checksums = PACKAGE_FILES.slice(0, -1).map(name => `${files[name]!.sha256}  ${name}`).join("\n") + "\n";
  if (files["SHA256SUMS"]!.bytes.toString("utf8") !== checksums) reject("package-checksum-mismatch");
  const unchanged = () => { for (const file of Object.values(files)) file.unchanged(); };
  unchanged();
  return { build, package_sha256: Object.fromEntries(PACKAGE_FILES.map(name => [name, files[name]!.sha256])), checksum_manifest: checksums, unchanged };
}

export function publishEvidence(path: string, report: unknown): void {
  absolute(path); const checkParents = parents(path);
  const bytes = JSON.stringify(report, null, 2) + "\n";
  const temporary = mkdtempSync(join(dirname(path), ".kizuki-evidence-publish-"));
  const pending = join(temporary, "report.json");
  let cleanupFailed = false;
  try {
    const fd = openSync(pending, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
    checkParents();
    // Hard-link publication is atomic and refuses an existing destination.
    // The final name cannot expose bytes before their write and fsync complete.
    linkSync(pending, path);
  } finally {
    // Preserve a write/publication error, and attempt both cleanup operations.
    try { rmSync(pending, { force: true }); } catch { cleanupFailed = true; }
    try { rmdirSync(temporary); } catch { cleanupFailed = true; }
  }
  try {
    // Once published, cleanup failure must not prevent the durability attempt.
    const directory = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } catch { reject("published-report-durability-unconfirmed"); }
  if (cleanupFailed) reject("published-report-cleanup-failed");
}

/** Copy exactly the registered five files; unrelated package entries are never traversed. */
export function copyPackage(source: string, destination: string): void {
  absolute(source); absolute(destination); mkdirSync(destination, { mode: 0o700 });
  for (const file of PACKAGE_FILES) copyFileSync(join(source, file), join(destination, file), constants.COPYFILE_EXCL);
}
