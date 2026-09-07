import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { release } from "node:os";

const SQLITE = "/usr/bin/sqlite3", CODESIGN = "/usr/bin/codesign";
const OUTPUT_LIMIT = 16 * 1024;
export interface VendorIdentity { sqlite_version: string; sqlite_source_id: string; }
export interface VendorCommand { status: number | null; stdout: string; stderr: string; error?: "timeout" | "output-limit" | "spawn-failed"; }
export interface VendorIO {
  run(command: readonly string[]): VendorCommand;
  read(path: string, limit: number): Buffer;
  runtime(): VendorIdentity;
  kernel(): string;
}
export class SqliteVendorError extends Error {
  constructor(readonly code: string, readonly diagnostic?: { system_cli_sha256: string; verification: VendorCommand; display: VendorCommand }) { super(code); }
}
function refuse(code: string): never { throw new SqliteVendorError(code); }
function oneLine(value: string, pattern: RegExp): string {
  const line = value.replace(/\n$/, "");
  if (line.length > 512 || !pattern.test(line)) refuse("vendor-invalid-output");
  return line;
}
export function parseVendorIdentity(value: string): VendorIdentity {
  const line = oneLine(value, /^[0-9]+\.[0-9]+\.[0-9]+\t[\x20-\x7e]{1,256}$/);
  const [sqlite_version, sqlite_source_id] = line.split("\t");
  return { sqlite_version: sqlite_version!, sqlite_source_id: sqlite_source_id! };
}
export function parseVendorHeader(value: string): VendorIdentity {
  const field = (name: string): string => {
    const matches = [...value.matchAll(new RegExp(`^#\\s*define\\s+${name}\\s+"([^"\\r\\n]+)"[ \\t]*$`, "gm"))];
    if (matches.length !== 1) refuse("vendor-invalid-header");
    return matches[0]![1]!;
  };
  return parseVendorIdentity(`${field("SQLITE_VERSION")}\t${field("SQLITE_SOURCE_ID")}`);
}
function checked(result: VendorCommand, code: string): VendorCommand {
  if (Buffer.byteLength(result.stdout) > OUTPUT_LIMIT || Buffer.byteLength(result.stderr) > OUTPUT_LIMIT || result.error === "output-limit") refuse("vendor-output-limit");
  if (result.error === "timeout") refuse("vendor-command-timeout");
  if (result.status !== 0 || result.error !== undefined) refuse(code);
  return result;
}
const hash = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

/** Test harness only. This observes an Apple-signed CLI; it does not attest Bun's loaded library. */
export function collectSqliteVendor(io: VendorIO) {
  const before = hash(io.read(SQLITE, 32 * 1024 * 1024));
  const verification = io.run([CODESIGN, "--verify", "--strict", "-R", "anchor apple", SQLITE]);
  const displayed = io.run([CODESIGN, "--display", "--verbose=2", SQLITE]);
  try { checked(verification, "vendor-signature-refused"); }
  catch (error) {
    // These two fixed read-only commands inspect only the public system CLI.
    // Keep bounded failure evidence without ever continuing into SQLite.
    const bounded = (value: VendorCommand): VendorCommand => ({ status: value.status,
      stdout: Buffer.byteLength(value.stdout) <= OUTPUT_LIMIT ? value.stdout : "[output limit exceeded]",
      stderr: Buffer.byteLength(value.stderr) <= OUTPUT_LIMIT ? value.stderr : "[output limit exceeded]",
      ...(value.error === undefined ? {} : { error: value.error }) });
    throw new SqliteVendorError(error instanceof SqliteVendorError ? error.code : "vendor-signature-refused",
      { system_cli_sha256: before, verification: bounded(verification), display: bounded(displayed) });
  }
  const display = checked(displayed, "vendor-signature-display-failed");
  if (!(display.stdout + display.stderr).trim()) refuse("vendor-signature-display-invalid");
  const system = parseVendorIdentity(checked(io.run([SQLITE, "-batch", "-noheader", "-init", "/dev/null", ":memory:",
    "SELECT sqlite_version() || char(9) || sqlite_source_id();"]), "vendor-system-query-failed").stdout);
  const runtime = io.runtime();
  // Validate both independently before their equality can carry any meaning.
  const bun = parseVendorIdentity(`${runtime.sqlite_version}\t${runtime.sqlite_source_id}`);
  if (JSON.stringify(system) !== JSON.stringify(bun)) refuse("vendor-runtime-mismatch");
  const product = oneLine(checked(io.run(["/usr/bin/sw_vers", "-productVersion"]), "vendor-os-version-failed").stdout, /^[0-9]+(?:\.[0-9]+){1,2}$/);
  const build = oneLine(checked(io.run(["/usr/bin/sw_vers", "-buildVersion"]), "vendor-os-build-failed").stdout, /^[A-Za-z0-9.]+$/);
  const kernel = oneLine(io.kernel(), /^[0-9]+(?:\.[0-9]+){1,2}$/);
  let sdk: { status: "available"; path: string; version: string; header_sha256: string; header_identity: VendorIdentity } |
    { status: "unavailable"; reason: string };
  try {
    const path = oneLine(checked(io.run(["/usr/bin/xcrun", "--no-cache", "--sdk", "macosx", "--show-sdk-path"]), "vendor-sdk-path-unavailable").stdout,
      /^\/(?:Applications|Library\/Developer)\/[A-Za-z0-9_ .+\/-]+\.sdk$/);
    if (path.slice(1).split("/").some(part => part === "." || part === ".." || part === "")) refuse("vendor-invalid-sdk-path");
    const version = oneLine(checked(io.run(["/usr/bin/xcrun", "--no-cache", "--sdk", "macosx", "--show-sdk-version"]), "vendor-sdk-version-unavailable").stdout,
      /^[0-9]+(?:\.[0-9]+){1,2}$/);
    const bytes = io.read(`${path}/usr/include/sqlite3.h`, 4 * 1024 * 1024);
    sdk = { status: "available", path, version, header_sha256: hash(bytes), header_identity: parseVendorHeader(bytes.toString("utf8")) };
  } catch (error) {
    sdk = { status: "unavailable", reason: error instanceof SqliteVendorError ? error.code : "vendor-sdk-header-unavailable" };
  }
  if (hash(io.read(SQLITE, 32 * 1024 * 1024)) !== before) refuse("vendor-system-cli-changed");
  return { schema: "kizuki.sqlite-vendor-observation/v1" as const, status: "PASS" as const,
    scope: "apple-signed-system-cli-identity-not-loaded-library" as const,
    system_cli: { path: SQLITE, sha256: before, apple_anchor_verified: true, runtime: system,
      codesign_display: { stdout: display.stdout, stderr: display.stderr } },
    bun_runtime: { bun_version: Bun.version, ...bun }, os: { product_version: product, build_version: build, kernel_release: kernel }, sdk };
}

export function captureNativeSqliteVendor() {
  if (process.platform !== "darwin" || process.arch !== "arm64") refuse("vendor-native-host-required");
  const deadline = performance.now() + 30_000;
  return collectSqliteVendor({
    run(command) {
      const remaining = Math.floor(deadline - performance.now());
      if (remaining <= 0) refuse("vendor-command-timeout");
      const result = spawnSync(command[0]!, command.slice(1), { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
        timeout: Math.min(5000, remaining), killSignal: "SIGKILL", maxBuffer: OUTPUT_LIMIT,
        env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", LC_ALL: "C" } });
      const code = (result.error as NodeJS.ErrnoException | undefined)?.code;
      return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "",
        ...(result.error ? { error: code === "ETIMEDOUT" ? "timeout" as const : code === "ENOBUFS" ? "output-limit" as const : "spawn-failed" as const } : {}) };
    },
    read(path, limit) {
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const before = fstatSync(fd, { bigint: true });
        if (!before.isFile() || before.size > BigInt(limit)) refuse("vendor-file-refused");
        const bytes = Buffer.alloc(Number(before.size) + 1); let used = 0;
        while (used < bytes.length) {
          const count = readSync(fd, bytes, used, bytes.length - used, used);
          if (count === 0) break;
          used += count;
        }
        const after = fstatSync(fd, { bigint: true });
        if (BigInt(used) !== before.size || (["dev", "ino", "size", "mtimeNs", "ctimeNs"] as const).some(key =>
          before[key] !== after[key])) refuse("vendor-file-changed");
        return bytes.subarray(0, used);
      } finally { closeSync(fd); }
    },
    runtime() {
      const db = new Database(":memory:");
      try { return db.query("SELECT sqlite_version() sqlite_version, sqlite_source_id() sqlite_source_id").get() as VendorIdentity; }
      finally { db.close(true); }
    },
    kernel: release,
  });
}
