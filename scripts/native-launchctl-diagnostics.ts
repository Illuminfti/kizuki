import { createHash } from "node:crypto";
import { appendFileSync, constants, lstatSync, mkdirSync, openSync, closeSync, readFileSync, readSync, fstatSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { constants as osConstants } from "node:os";
import { renderLaunchdPlist } from "../packages/core/src/serve/units";
import { loadServeConfig } from "../packages/core/src/serve/config";

const MAX_BYTES = 65_536;
const MAX_RECORDS = 128;
type NativeResult = { exit_code: number; stdout: string; stderr: string; signal: number | null };
type Identity = { dev: number; ino: number; size: number; mtime_ms: number };
export interface LaunchctlFixture {
  root: string;
  runner_temp: string;
  uid: number;
  vault_id: string;
  binary: Identity;
  startup_capture?: StartupCaptureBinding;
}
const identity = (path: string): Identity => {
  const s = lstatSync(path);
  return { dev: s.dev, ino: s.ino, size: s.size, mtime_ms: s.mtimeMs };
};
function privateRegular(path: string, uid: number, maximum: number): boolean {
  const s = lstatSync(path);
  return s.isFile() && s.nlink === 1 && s.uid === uid && (s.mode & 0o777) === 0o600 && s.size <= maximum;
}

type StartupCaptureBinding = Record<"stdout" | "stderr" | "metadata", { dev: number; ino: number }>;
const capturePath = (root: string, name: keyof StartupCaptureBinding) => join(root, "launchctl diagnostics", `startup-${name}.log`);
function heldText(fd: number): string {
  const buffer = Buffer.alloc(MAX_BYTES + 1);
  const size = readSync(fd, buffer, 0, buffer.length, 0);
  if (size > MAX_BYTES) throw new Error("synthetic startup definition exceeds bound");
  return buffer.subarray(0, size).toString();
}
function captureFile(fd: number, path: string, expected: { dev: number; ino: number }, uid: number) {
  const held = fstatSync(fd), named = lstatSync(path);
  for (const s of [held, named]) if (!s.isFile() || s.nlink !== 1 || s.uid !== uid || (s.mode & 0o777) !== 0o600 ||
    s.dev !== expected.dev || s.ino !== expected.ino) throw new Error("synthetic startup output custody refused");
  return held;
}

/** The original definition is accepted only as the exact current renderer output. */
export function startupCapturePlist(original: string, expected: string, stdout: string, stderr: string): string {
  if (original !== expected || !original.endsWith("</dict>\n</plist>\n")) throw new Error("synthetic startup definition refused");
  const xml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
  return original.replace("</dict>\n</plist>\n", `  <key>StandardOutPath</key>\n  <string>${xml(stdout)}</string>\n  <key>StandardErrorPath</key>\n  <string>${xml(stderr)}</string>\n</dict>\n</plist>\n`);
}

/** Private held output files are read before synthetic-root cleanup, never followed by name. */
export function prepareLaunchctlStartupCapture(root: string) {
  const descriptors: Partial<Record<keyof StartupCaptureBinding, number>> = {};
  const binding = {} as StartupCaptureBinding;
  try {
    for (const name of ["stdout", "stderr", "metadata"] as const) {
      const fd = openSync(capturePath(root, name), constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      descriptors[name] = fd;
      const s = fstatSync(fd); binding[name] = { dev: s.dev, ino: s.ino };
    }
  } catch (error) { for (const fd of Object.values(descriptors)) closeSync(fd); throw error; }
  let closed = false;
  return { binding, collect: () => {
    if (closed) throw new Error("synthetic startup output closed");
    const output = Object.fromEntries((["stdout", "stderr", "metadata"] as const).map(name => {
      const fd = descriptors[name]!, path = capturePath(root, name);
      const before = captureFile(fd, path, binding[name], process.getuid!());
      const buffer = Buffer.alloc(8192), size = readSync(fd, buffer, 0, buffer.length, 0);
      captureFile(fd, path, binding[name], process.getuid!());
      const bytes = buffer.subarray(0, size);
      return [name, { text: bytes.toString(), bytes_read: size, file_size: before.size, truncated: before.size > size,
        sha256: createHash("sha256").update(bytes).digest("hex") }];
    }));
    return { changed_native_configuration: true, timing_changed: true, release_eligible: false, limit_bytes_per_stream: 8192, output };
  }, close: () => { if (!closed) { closed = true; for (const fd of Object.values(descriptors)) closeSync(fd); } } };
}

/** The wrapper changes only a private clone's output paths; installed bytes remain held and exact. */
export function captureLaunchctlBootstrap(fixture: LaunchctlFixture, argv: readonly string[], run: (argv: readonly string[]) => NativeResult): NativeResult {
  if (!fixture.startup_capture || fixtureLaunchctlOperation(fixture, argv) !== "bootstrap" || !launchctlFixtureMatches(fixture)) {
    throw new Error("synthetic startup bootstrap refused");
  }
  const paths = Object.fromEntries((["stdout", "stderr", "metadata"] as const).map(name => [name, capturePath(fixture.root, name)])) as Record<keyof StartupCaptureBinding, string>;
  const held: number[] = [];
  try {
    for (const name of ["stdout", "stderr", "metadata"] as const) {
      const fd = openSync(paths[name], constants.O_RDWR | constants.O_NOFOLLOW); held.push(fd);
      captureFile(fd, paths[name], fixture.startup_capture[name], fixture.uid);
    }
    const source = argv[2]!, sourceFd = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW); held.push(sourceFd);
    const before = fstatSync(sourceFd);
    if (!before.isFile() || before.nlink !== 1 || before.uid !== fixture.uid || (before.mode & 0o777) !== 0o600 || before.size > MAX_BYTES) throw new Error("synthetic startup definition refused");
    const vault = join(fixture.root, "synthetic vault"), binary = join(fixture.root, "installed package/kizuki");
    const expected = renderLaunchdPlist({ vaultPath: vault, vaultId: fixture.vault_id,
      execStart: [binary, "serve", "--vault", vault], config: loadServeConfig(vault) });
    const original = readFileSync(sourceFd, "utf8");
    const clone = startupCapturePlist(original, expected, paths.stdout, paths.stderr);
    const clonePath = join(fixture.root, "launchctl diagnostics/startup.plist");
    const cloneFd = openSync(clonePath, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); held.push(cloneFd);
    writeFileSync(cloneFd, clone);
    const cloneStat = fstatSync(cloneFd), cloneId = { dev: cloneStat.dev, ino: cloneStat.ino };
    const verify = () => {
      captureFile(sourceFd, source, { dev: before.dev, ino: before.ino }, fixture.uid);
      captureFile(cloneFd, clonePath, cloneId, fixture.uid);
      if (heldText(sourceFd) !== original || heldText(cloneFd) !== clone) throw new Error("synthetic startup definition changed");
      for (const [index, name] of (["stdout", "stderr", "metadata"] as const).entries()) captureFile(held[index]!, paths[name], fixture.startup_capture![name], fixture.uid);
    };
    verify();
    const result = run(["/bin/launchctl", "bootstrap", argv[1]!, clonePath]);
    verify();
    writeFileSync(held[2]!, JSON.stringify({ original_sha256: createHash("sha256").update(original).digest("hex"),
      clone_sha256: createHash("sha256").update(clone).digest("hex"), original_preserved: true,
      argv_preserved: true, working_directory_preserved: true, restart_policy_preserved: true }) + "\n");
    return result;
  } finally { for (const fd of held) closeSync(fd); }
}

/** Only the exact synthetic unit is callable; domain-wide commands are refused. */
export function fixtureLaunchctlOperation(fixture: LaunchctlFixture, argv: readonly string[]): "print" | "bootout" | "bootstrap" | null {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(fixture.vault_id) || !Number.isSafeInteger(fixture.uid) || fixture.uid < 1) return null;
  const domain = `gui/${fixture.uid}`, label = `dev.kizuki.${fixture.vault_id}`;
  if (argv.length === 2 && (argv[0] === "print" || argv[0] === "bootout") && argv[1] === `${domain}/${label}`) return argv[0];
  if (argv.length === 3 && argv[0] === "bootstrap" && argv[1] === domain &&
    argv[2] === join(fixture.root, "home/Library/LaunchAgents", `${label}.plist`)) return "bootstrap";
  return null;
}

/** No runtime overrides: the installed wrapper can only run on the native CI fixture. */
export function launchctlFixtureMatches(fixture: LaunchctlFixture): boolean {
  try {
    if (process.platform !== "darwin" || process.env.CI !== "true" || process.env.GITHUB_ACTIONS !== "true" ||
      process.getuid?.() !== fixture.uid || !process.env.RUNNER_TEMP || realpathSync(process.env.RUNNER_TEMP) !== fixture.runner_temp ||
      realpathSync(fixture.root) !== resolve(fixture.root) || dirname(fixture.root) !== fixture.runner_temp ||
      !basename(fixture.root).startsWith("kizuki native lifecycle ")) return false;
    const root = lstatSync(fixture.root);
    if (!root.isDirectory() || root.uid !== fixture.uid || (root.mode & 0o777) !== 0o700) return false;
    const idPath = join(fixture.root, "synthetic vault/.kizuki/vault-id");
    if (!privateRegular(idPath, fixture.uid, 130) || readFileSync(idPath, "utf8").trim() !== fixture.vault_id) return false;
    const binaryPath = join(fixture.root, "installed package/kizuki"), binary = lstatSync(binaryPath);
    if (!binary.isFile() || binary.nlink !== 1 || binary.uid !== fixture.uid || realpathSync(binaryPath) !== binaryPath ||
      JSON.stringify(identity(binaryPath)) !== JSON.stringify(fixture.binary)) return false;
    return privateRegular(join(fixture.root, "launchctl diagnostics/commands.jsonl"), fixture.uid, MAX_BYTES);
  } catch { return false; }
}

/** Closed fields only: launchctl print contains arbitrary environment and configuration. */
export function projectLaunchctlResult(operation: "print" | "bootout" | "bootstrap", result: NativeResult, durationMs: number) {
  const stdout = result.stdout.slice(0, MAX_BYTES), stderr = result.stderr.slice(0, MAX_BYTES);
  const number = (pattern: RegExp): number | null => {
    const value = Number(pattern.exec(stdout)?.[1]);
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  };
  const state = /^\s*state = (running|waiting|spawn scheduled|exited|not running)\s*$/m.exec(stdout)?.[1] ?? null;
  const category = /could not find service/i.test(stderr) ? "service_absent"
    : /input\/output error/i.test(stderr) ? "input_output_error"
    : /operation (?:not permitted|in progress)/i.test(stderr) ? "operation_refused"
    : /service (?:already loaded|already exists)/i.test(stderr) ? "already_loaded"
    : /no such (?:file|process)/i.test(stderr) ? "not_found"
    : stderr.trim() ? "unclassified" : null;
  return { operation, exit_code: result.exit_code, signal: result.signal, duration_ms: Math.max(0, Math.round(durationMs)), state,
    pid: number(/^\s*pid = ([1-9]\d*)\s*$/m), last_exit_code: number(/^\s*last exit code = (\d+)\s*$/m),
    error: category, output_truncated: result.stdout.length > MAX_BYTES || result.stderr.length > MAX_BYTES };
}

/** Executes and returns the actual result. Recording never converts failure to success. */
export function observeLaunchctl(
  operation: "print" | "bootout" | "bootstrap", argv: readonly string[],
  run: (argv: readonly string[]) => NativeResult, record: (row: ReturnType<typeof projectLaunchctlResult>) => void,
): NativeResult {
  const started = performance.now();
  const result = run(["/bin/launchctl", ...argv]);
  try { record(projectLaunchctlResult(operation, result, performance.now() - started)); } catch { /* Original native outcome is preserved. */ }
  return result;
}

export function runFixtureLaunchctl(fixture: LaunchctlFixture, argv: readonly string[]): never {
  const operation = fixtureLaunchctlOperation(fixture, argv);
  if (!operation || !launchctlFixtureMatches(fixture)) {
    process.stderr.write("synthetic launchctl diagnostic target refused\n"); process.exit(126);
  }
  const execute = (command: readonly string[]): NativeResult => {
    const native = Bun.spawnSync([...command], { stdin: "ignore", stdout: "pipe", stderr: "pipe", maxBuffer: 1_048_576 });
    return { exit_code: native.exitCode, stdout: native.stdout.toString(), stderr: native.stderr.toString(), signal: native.signalCode && Object.hasOwn(osConstants.signals, native.signalCode)
      ? osConstants.signals[native.signalCode as keyof typeof osConstants.signals] : null };
  };
  const result = observeLaunchctl(operation, argv, command => operation === "bootstrap" && fixture.startup_capture
    ? captureLaunchctlBootstrap(fixture, argv, execute) : execute(command), row => {
    const path = join(fixture.root, "launchctl diagnostics/commands.jsonl");
    const bytes = readFileSync(path);
    const line = JSON.stringify(row) + "\n";
    if (bytes.length + Buffer.byteLength(line) > MAX_BYTES || bytes.toString().split("\n").length > MAX_RECORDS) return;
    const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);
    try { appendFileSync(fd, line); } finally { closeSync(fd); }
  });
  process.stdout.write(result.stdout); process.stderr.write(result.stderr);
  if (result.signal !== null) process.kill(process.pid, result.signal);
  process.exit(result.exit_code);
}

/** Init creates its own identity; bind it only after its private file exists. */
export function bindInitializedLaunchctlFixture(pending: Omit<LaunchctlFixture, "vault_id">): LaunchctlFixture {
  const path = join(pending.root, "synthetic vault/.kizuki/vault-id");
  if (!privateRegular(path, pending.uid, 130)) throw new Error("synthetic launchctl identity refused");
  const fixture = { ...pending, vault_id: readFileSync(path, "utf8").trim() };
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(fixture.vault_id) || !launchctlFixtureMatches(fixture)) {
    throw new Error("synthetic launchctl diagnostic fixture refused");
  }
  return fixture;
}

/** The wrapper is only placed in one CLI child's PATH. The daemon and parent env are unchanged. */
export function prepareLaunchctlDiagnostics(root: string, vaultId?: string, captureStartup = false) {
  const folder = join(root, "launchctl diagnostics"), wrapper = join(folder, "launchctl"), trace = join(folder, "commands.jsonl");
  mkdirSync(folder, { mode: 0o700 });
  writeFileSync(trace, "", { mode: 0o600, flag: "wx" });
  if (captureStartup && vaultId === undefined) throw new Error("startup capture requires initialized synthetic vault");
  const capture = captureStartup ? prepareLaunchctlStartupCapture(root) : null;
  try {
  const pending = { ...(capture ? { startup_capture: capture.binding } : {}), root, runner_temp: realpathSync(process.env.RUNNER_TEMP!), uid: process.getuid!(),
    binary: identity(join(root, "installed package/kizuki")) };
  const fixture = vaultId === undefined ? null : { ...pending, vault_id: vaultId };
  const binding = fixture === null ? `bindInitializedLaunchctlFixture(${JSON.stringify(pending)})` : JSON.stringify(fixture);
  const source = `#!${process.execPath}\nimport { runFixtureLaunchctl, bindInitializedLaunchctlFixture } from ${JSON.stringify(import.meta.path)};\nrunFixtureLaunchctl(${binding}, process.argv.slice(2));\n`;
  writeFileSync(wrapper, source, { mode: 0o700, flag: "wx" });
  if (fixture !== null && !launchctlFixtureMatches(fixture)) throw new Error("synthetic launchctl diagnostic fixture refused");
  return { path: folder, fixture, startup_capture: capture, wrapper_sha256: createHash("sha256").update(source).digest("hex"),
    collect: () => {
      const bytes = readFileSync(trace);
      if (bytes.length > MAX_BYTES) throw new Error("launchctl diagnostic bound exceeded");
      const rows = bytes.toString().trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
      return { instrumented: true, timing_changed: true, limit_records: MAX_RECORDS, limit_bytes: MAX_BYTES,
        wrapper_sha256: createHash("sha256").update(readFileSync(wrapper)).digest("hex"),
        truncated: rows.length >= MAX_RECORDS, rows };
    } };
  } catch (error) { capture?.close(); throw error; }
}

/** Metadata only; the journal body contains previous unit configuration and is never read. */
export function syntheticServiceFileMetadata(root: string, vaultId: string) {
  const paths = { journal: join(root, "synthetic vault/.kizuki/service-change.json"),
    marker: join(root, "synthetic vault/.kizuki/serve.pid"),
    unit: join(root, "home/Library/LaunchAgents", `dev.kizuki.${vaultId}.plist`) };
  return Object.fromEntries(Object.entries(paths).map(([name, path]) => {
    try {
      const s = lstatSync(path);
      return [name, { exists: true, regular: s.isFile(), symlink: s.isSymbolicLink(), mode: s.mode & 0o777, uid: s.uid,
        nlink: s.nlink, dev: s.dev, ino: s.ino, size: s.size, mtime_ms: s.mtimeMs }];
    } catch (error) {
      return [name, error && typeof error === "object" && "code" in error && error.code === "ENOENT"
        ? { exists: false } : { exists: null, error: "metadata_unavailable" }];
    }
  }));
}
