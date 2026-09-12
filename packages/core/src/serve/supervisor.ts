import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { loadServeConfig } from "./config";
import { readServeIntent, writeServeIntent } from "./intent";
import { replaceServiceFile, serviceDirectory, serviceFile } from "./service-files";
import { tryAdvisoryFileLock } from "../util/advisory-file-lock";
import { isServeIntent, type ServeIntent } from "./types";
import {
  launchdLabel,
  launchdPlistPath,
  renderLaunchdPlist,
  renderSystemdUnit,
  systemdUnitName,
  systemdUnitPath,
  type UnitSpec,
} from "./units";
import { ensureVaultId } from "./vault-id";
import type {
  SupervisorKind,
  SupervisorState,
  SupervisorStatus,
} from "./types";

export interface SupervisorHost {
  readonly kind: SupervisorKind;
  readonly home: string;
  readonly configHome?: string;
  readonly execStart: string | readonly string[];
  query(vaultId: string): SupervisorStatus;
  /** Refresh changed definitions without enabling or starting a service. */
  reload(): { ok: boolean; detail: string };
  /** Activate the current unit bytes, including replacement of an older running definition. */
  enable(unitPath: string, unitName: string): { ok: boolean; detail: string };
  disable(unitName: string): { ok: boolean; detail: string };
  /** Clear only this stopped systemd unit's retained failure before uninstall. */
  resetFailure?(unitName: string): { ok: boolean; detail: string };
  /** Restore unit enablement without starting or restarting it. */
  enableWithoutStart?(unitName: string): { ok: boolean; detail: string };
}

export function detectSupervisorKind(
  env: Record<string, string | undefined> = process.env,
  platform = process.platform,
): SupervisorKind {
  const forced = env.KIZUKI_SUPERVISOR;
  if (forced === "systemd" || forced === "launchd" || forced === "none") {
    return forced;
  }
  if (platform === "darwin") return "launchd";
  if (platform === "linux") return "systemd";
  return "none";
}

function runCommand(argv: string[], timeout = 5_000): { ok: boolean; exitCode: number | null; stdout: string; stderr: string } {
  const result = spawnSync(argv[0] ?? "", argv.slice(1), {
    encoding: "utf8",
    timeout,
  });
  return {
    ok: result.status === 0,
    exitCode: result.status,
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
  };
}

const LAUNCHD_COMMAND_TIMEOUT_MS = 5_000;
const LAUNCHD_PRINT_LIMIT = 65_536;
const LAUNCHD_INACTIVE = new Set(["waiting", "spawn scheduled", "exited", "not running"]);
const LAUNCHD_LOADED = new Set(["running", "unloaded", "waiting", "spawn scheduled", "exited", "not running"]);

type LaunchdPrint = { ok: boolean; stdout: string; stderr: string; transport: boolean };
type LaunchdJob = { state: string; pid: number | null; disabled: boolean; lastExit: number | null };

function printLaunchd(label: string, timeout: number): LaunchdPrint {
  const result = spawnSync("launchctl", ["print", `gui/${process.getuid?.() ?? 0}/${label}`], {
    encoding: "utf8",
    timeout,
  });
  const transport = result.error != null || result.signal != null || result.status == null;
  return {
    ok: result.status === 0 && !transport,
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
    transport,
  };
}

/** Job fields share the least-indented `state =` line; nested env/config is not status. */
function parseLaunchdJob(stdout: string): LaunchdJob | null {
  if (stdout.length > LAUNCHD_PRINT_LIMIT) return null;
  const states = [...stdout.matchAll(/^([ \t]*)state = (\S+(?:[ \t]+\S+)*)[ \t]*$/gm)];
  if (states.length === 0) return null;
  const indent = Math.min(...states.map(match => match[1]!.length));
  const top = states.filter(match => match[1]!.length === indent);
  if (top.length !== 1) return null;
  const atIndent = (pattern: RegExp) => [...stdout.matchAll(pattern)].filter(match => match[1]!.length === indent);
  const pids = atIndent(/^([ \t]*)pid = ([1-9]\d*)[ \t]*$/gm);
  const pid = pids.length === 1 && Number.isSafeInteger(Number(pids[0]![2])) ? Number(pids[0]![2]) : null;
  const flags = atIndent(/^([ \t]*)disabled = (.*)$/gm);
  if (flags.length > 1 || (flags.length === 1 && !/^[01]$/.test(flags[0]![2]!.trim()))) return null;
  const disabled = flags.length === 1 && flags[0]![2]!.trim() === "1";
  const exits = stdout.split("\n").filter(line => /^[ \t]*last exit code/.test(line) && (/^[ \t]*/.exec(line)?.[0].length ?? 0) === indent);
  let lastExit: number | null = null;
  if (exits.length === 1) {
    const match = /^([ \t]*)last exit code = (0|[1-9]\d{0,2})[ \t]*$/.exec(exits[0]!);
    if (match && Number(match[2]) <= 255) lastExit = Number(match[2]);
  }
  return { state: top[0]![2]!, pid, disabled, lastExit };
}

function launchdInactiveDetail(job: LaunchdJob): string {
  if (!LAUNCHD_INACTIVE.has(job.state) || job.lastExit === null) return "loaded but not running";
  return job.lastExit === 0 ? "stopped (last exit code 0)" : `failed (last exit code ${job.lastExit})`;
}

function classifyLaunchdPrint(label: string, printed: LaunchdPrint): SupervisorStatus {
  const unknown: SupervisorStatus = {
    kind: "launchd", state: "unknown", unit: label, enabled: false,
    detail: "supervisor state could not be queried",
  };
  if (printed.transport) return unknown;
  if (!printed.ok) {
    if (printed.stdout.length === 0 && /could not find service/i.test(printed.stderr)) {
      return { kind: "launchd", state: "absent", unit: label, enabled: false, detail: "absent" };
    }
    return unknown;
  }
  const job = parseLaunchdJob(printed.stdout);
  if (job === null || !LAUNCHD_LOADED.has(job.state)) return unknown;
  if (job.state === "running" && job.pid !== null && job.pid > 1 && !job.disabled) {
    return { kind: "launchd", state: "active", unit: label, enabled: true, detail: "active" };
  }
  return { kind: "launchd", state: "disabled", unit: label, enabled: true, detail: launchdInactiveDetail(job) };
}

function queryLaunchdService(label: string): SupervisorStatus {
  return classifyLaunchdPrint(label, printLaunchd(label, LAUNCHD_COMMAND_TIMEOUT_MS));
}

function waitForLaunchdState(label: string, state: "absent" | "active"): boolean {
  // Both bootstrap and bootout acknowledge a request before the corresponding
  // job transition has necessarily completed. Observe the requested state.
  const deadline = performance.now() + LAUNCHD_COMMAND_TIMEOUT_MS;
  const signal = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    const remaining = deadline - performance.now();
    if (remaining < 1) return false;
    const printed = printLaunchd(label, Math.min(Math.floor(remaining), LAUNCHD_COMMAND_TIMEOUT_MS));
    if (performance.now() >= deadline) return false;
    if (!printed.transport) {
      const observed = classifyLaunchdPrint(label, printed);
      if (observed.state === state && observed.enabled === (state === "active")) return true;
      if (observed.state === "unknown") return false;
    }
    const delay = Math.min(50, deadline - performance.now());
    if (delay <= 0) return false;
    Atomics.wait(signal, 0, 0, delay);
  }
}

function stopLaunchdService(label: string): boolean {
  const stopped = runCommand(["launchctl", "bootout", `gui/${process.getuid?.() ?? 0}/${label}`]);
  return stopped.ok && waitForLaunchdState(label, "absent");
}

export function realSupervisorHost(
  kind: SupervisorKind,
  home: string,
  execStart: string | readonly string[],
  options: { configHome?: string } = {},
): SupervisorHost {
  return {
    kind,
    home,
    ...(options.configHome === undefined ? {} : { configHome: options.configHome }),
    execStart,
    query(vaultId: string): SupervisorStatus {
      if (kind === "none") {
        return {
          kind,
          state: "none",
          unit: null,
          enabled: false,
          detail: "supervisor: none (loop runs only while you run it)",
        };
      }
      if (kind === "systemd") {
        const unit = systemdUnitName(vaultId);
        const enabled = runCommand(["systemctl", "--user", "is-enabled", unit]);
        const active = runCommand(["systemctl", "--user", "is-active", unit]);
        let state: SupervisorState = "unknown";
        // Enablement/masking is independent of runtime activity. Neither proves a stop.
        const inactive = active.exitCode === 3 && (active.stdout === "inactive" || active.stdout === "failed");
        const absent = enabled.exitCode !== null && enabled.exitCode > 0 && enabled.stdout === "not-found";
        if (active.ok && active.stdout === "active") state = "active";
        else if (inactive) {
          if (enabled.exitCode !== null && enabled.exitCode > 0 && enabled.stdout === "masked") state = "masked";
          else if ((enabled.ok && enabled.stdout === "enabled") ||
            (enabled.exitCode !== null && enabled.exitCode > 0 && enabled.stdout === "disabled")) state = "disabled";
          else if (absent) state = "absent";
        // systemd 255 reports a missing unit as exit 4 with inactive, while
        // older managers can report unknown. Enablement must independently
        // confirm not-found; masked/disabled unknown states remain unverified.
        } else if (absent && active.exitCode === 4 &&
          (active.stdout === "unknown" || active.stdout === "inactive")) state = "absent";
        return {
          kind,
          state,
          unit,
          enabled: enabled.ok && enabled.stdout === "enabled",
          detail: active.exitCode === 3 && active.stdout === "failed" ? "failed" :
            state === "disabled" && enabled.ok && enabled.stdout === "enabled" ? "inactive (enabled)" :
            state === "unknown" ? "supervisor state could not be queried" : state,
        };
      }
      return queryLaunchdService(launchdLabel(vaultId));
    },
    reload() {
      if (kind !== "systemd") return { ok: true, detail: "no definition cache reload required" };
      const result = runCommand(["systemctl", "--user", "daemon-reload"]);
      return { ok: result.ok, detail: result.ok ? "definitions reloaded" : "service reload failed" };
    },
    enable(unitPath: string, unitName: string) {
      if (kind === "systemd") {
        const reload = runCommand(["systemctl", "--user", "daemon-reload"]);
        if (!reload.ok) return { ok: false, detail: "service reload failed" };
        const enabled = runCommand(["systemctl", "--user", "enable", unitName]);
        if (!enabled.ok) return { ok: false, detail: "service enable failed" };
        const restarted = runCommand(["systemctl", "--user", "restart", unitName]);
        return {
          ok: restarted.ok,
          detail: restarted.ok ? "activated current definition" : "service restart failed",
        };
      }
      if (kind === "launchd") {
        const before = queryLaunchdService(unitName);
        if (before.state === "unknown") return { ok: false, detail: "service replacement state unavailable" };
        if (before.state !== "absent" || before.enabled) {
          if (!stopLaunchdService(unitName)) return { ok: false, detail: "service replacement stop failed" };
        }
        const loaded = runCommand(["launchctl", "bootstrap", `gui/${process.getuid?.() ?? 0}`, unitPath]);
        const active = loaded.ok && waitForLaunchdState(unitName, "active");
        return {
          ok: active,
          detail: active ? "loaded" : loaded.ok ? "service activation was not confirmed" : "service bootstrap failed",
        };
      }
      return { ok: false, detail: "no supervisor" };
    },
    disable(unitName: string) {
      if (kind === "systemd") {
        const result = runCommand(["systemctl", "--user", "disable", "--now", unitName]);
        return { ok: result.ok, detail: result.ok ? "disabled" : "service disable failed" };
      }
      if (kind === "launchd") {
        const stopped = stopLaunchdService(unitName);
        return { ok: stopped, detail: stopped ? "unloaded" : "service unload failed" };
      }
      return { ok: true, detail: "no supervisor" };
    },
    ...(kind === "systemd"
      ? {
          resetFailure(unitName: string) {
            const result = runCommand(["systemctl", "--user", "reset-failed", unitName]);
            return { ok: result.ok, detail: result.ok ? "failure cleared" : "service failure reset failed" };
          },
          enableWithoutStart(unitName: string) {
            const result = runCommand(["systemctl", "--user", "enable", unitName]);
            return { ok: result.ok, detail: result.ok ? "enabled without start" : "service enable failed" };
          },
        }
      : {}),
  };
}

export function queryServeService(
  vaultPath: string,
  host: SupervisorHost,
): SupervisorStatus {
  return host.query(ensureVaultId(vaultPath));
}

interface ForwardRemoval {
  readonly operation: "uninstall";
  readonly previous_unit: string;
  readonly previous_intent: ServeIntent;
}

interface RecoveredChange {
  readonly previous_unit: string | null;
  readonly previous_intent: ServeIntent;
  readonly previous_enabled: boolean;
  readonly previous_active: boolean;
}

const SERVICE_CHANGE_V4_KEYS = "identity_hash,kind,operation,previous_intent,previous_unit,version";
const SERVICE_CHANGE_V2_KEYS = "identity_hash,kind,previous_enabled,previous_intent,previous_unit,version";
const SERVICE_CHANGE_V3_KEYS = "identity_hash,kind,previous_active,previous_enabled,previous_intent,previous_unit,version";

function servicePaths(vaultPath: string, host: SupervisorHost) {
  const vaultId = ensureVaultId(vaultPath);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(vaultId)) throw new Error("invalid vault identity for a user service");
  const unit = host.kind === "systemd" ? systemdUnitName(vaultId) : launchdLabel(vaultId);
  const anchor = host.kind === "systemd" && host.configHome !== undefined ? host.configHome : host.home;
  if (!isAbsolute(anchor)) throw new Error("service home must be an absolute directory");
  const path = host.kind === "systemd" ? systemdUnitPath(host.home, vaultId, host.configHome) : launchdPlistPath(host.home, vaultId);
  serviceDirectory(anchor, dirname(path));
  serviceDirectory(vaultPath, join(vaultPath, ".kizuki"));
  const identityHash = createHash("sha256").update(JSON.stringify({
    vault: resolve(vaultPath), vault_id: vaultId, kind: host.kind, unit, path: resolve(path),
    home: host.home, config_home: host.configHome ?? null,
  })).digest("hex");
  return { vaultId, unit, path, identityHash, journal: join(vaultPath, ".kizuki", "service-change.json") };
}

function confirmedActive(status: SupervisorStatus): boolean { return status.state === "active" && status.enabled; }
function confirmedStopped(status: SupervisorStatus): boolean {
  return !status.enabled && (status.state === "disabled" || status.state === "absent" || status.state === "masked");
}
/** Known systemd inactive runtime that remains enabled. Not a confirmed stop. */
function confirmedInactiveEnabled(status: SupervisorStatus): boolean {
  return status.kind === "systemd" && status.state === "disabled" && status.enabled;
}
function hasEnablementOnly(host: SupervisorHost): host is SupervisorHost & { enableWithoutStart: NonNullable<SupervisorHost["enableWithoutStart"]> } {
  return typeof host.enableWithoutStart === "function";
}

function readServiceChange(raw: string, kind: SupervisorKind, identityHash: string): RecoveredChange | ForwardRemoval {
  const value = JSON.parse(raw);
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
    value.kind !== kind || value.identity_hash !== identityHash ||
    !(value.previous_unit === null || typeof value.previous_unit === "string") ||
    !isServeIntent(value.previous_intent)) throw new Error();
  const keys = Object.keys(value).sort().join(",");
  if (value.version === 4 && keys === SERVICE_CHANGE_V4_KEYS && kind === "launchd" &&
    value.operation === "uninstall" && typeof value.previous_unit === "string") {
    return { operation: "uninstall", previous_unit: value.previous_unit, previous_intent: value.previous_intent };
  }
  if (typeof value.previous_enabled !== "boolean" || (value.previous_enabled && value.previous_unit === null)) throw new Error();
  if (value.version === 2 && keys === SERVICE_CHANGE_V2_KEYS) {
    // Version 2 admitted only active+enabled or stopped+disabled snapshots.
    return {
      previous_unit: value.previous_unit, previous_intent: value.previous_intent,
      previous_enabled: value.previous_enabled, previous_active: value.previous_enabled,
    };
  }
  if (value.version === 3 && keys === SERVICE_CHANGE_V3_KEYS && typeof value.previous_active === "boolean" &&
    (!value.previous_active || (value.previous_enabled && value.previous_unit !== null)) &&
    (!value.previous_enabled || value.previous_active || kind === "systemd")) {
    return {
      previous_unit: value.previous_unit, previous_intent: value.previous_intent,
      previous_enabled: value.previous_enabled, previous_active: value.previous_active,
    };
  }
  throw new Error();
}

/** A failed loaded launchd job cannot be restored without starting it. An
 * explicit uninstall therefore records a forward-only removal decision. */
function confirmedFailedLaunchd(status: SupervisorStatus): boolean {
  const match = /^failed \(last exit code ([1-9]\d{0,2})\)$/.exec(status.detail);
  return status.kind === "launchd" && status.state === "disabled" && status.enabled && match !== null && Number(match[1]) <= 255;
}
function completeForwardRemoval(vaultPath: string, host: SupervisorHost, paths: ReturnType<typeof servicePaths>, entry: ForwardRemoval) {
  const absent = (status: SupervisorStatus) => status.kind === "launchd" && status.state === "absent" && !status.enabled;
  const unchanged = () => {
    const current = serviceFile(paths.path);
    if (current !== null && current !== entry.previous_unit) throw new Error("unrelated service definition replaced the pending removal");
    return current !== null;
  };
  try {
    const removed = unchanged();
    const before = host.query(paths.vaultId);
    if (!absent(before)) {
      if ((!confirmedActive(before) && !confirmedFailedLaunchd(before)) || !host.disable(paths.unit).ok || !absent(host.query(paths.vaultId))) {
        throw new Error("failed service stop remains unverified");
      }
    }
    unchanged();
    replaceServiceFile(paths.path, null);
    if (!host.reload().ok) throw new Error("service removal remains unverified");
    const status = host.query(paths.vaultId);
    if (!absent(status)) throw new Error("service removal remains unverified");
    // A new definition appearing during native observation belongs to nobody's
    // pending removal decision and must survive for explicit recovery.
    if (serviceFile(paths.path) !== null) throw new Error("service definition appeared during removal");
    writeServeIntent(vaultPath, "opted-out");
    replaceServiceFile(paths.journal, null);
    return { status, removed };
  } catch { throw new Error("service uninstall is pending; retry with the same service home"); }
}

function recoverChange(vaultPath: string, host: SupervisorHost, paths: ReturnType<typeof servicePaths>): void {
  const raw = serviceFile(paths.journal);
  if (raw === null) return;
  let entry: RecoveredChange | ForwardRemoval;
  try { entry = readServiceChange(raw, host.kind, paths.identityHash); }
  catch { throw new Error("service recovery snapshot is invalid or belongs to another vault or service location"); }
  if ("operation" in entry) { completeForwardRemoval(vaultPath, host, paths, entry); return; }
  if (entry.previous_enabled && !entry.previous_active && !hasEnablementOnly(host)) {
    throw new Error("service recovery cannot restore enablement; previous configuration retained");
  }
  const current = host.query(paths.vaultId);
  if (!confirmedStopped(current)) {
    if (!host.disable(paths.unit).ok || !confirmedStopped(host.query(paths.vaultId))) throw new Error("service recovery could not confirm stop; previous configuration retained");
  }
  replaceServiceFile(paths.path, entry.previous_unit);
  if (!host.reload().ok) throw new Error("previous service definition reload remains unverified");
  if (entry.previous_active) {
    if (entry.previous_unit === null || !host.enable(paths.path, paths.unit).ok || !confirmedActive(host.query(paths.vaultId))) {
      throw new Error("previous service configuration restored but activation remains unverified");
    }
  } else if (entry.previous_enabled) {
    if (!hasEnablementOnly(host) || !host.enableWithoutStart(paths.unit).ok || !confirmedInactiveEnabled(host.query(paths.vaultId))) {
      throw new Error("previous service configuration restored but enablement remains unverified");
    }
  } else if (!confirmedStopped(host.query(paths.vaultId))) {
    throw new Error("previous service definition restored but stopped state remains unverified");
  }
  writeServeIntent(vaultPath, entry.previous_intent);
  replaceServiceFile(paths.journal, null);
}

function changeService<T>(vaultPath: string, host: SupervisorHost, operation: (paths: ReturnType<typeof servicePaths>) => T,
  forwardRemoval?: (paths: ReturnType<typeof servicePaths>, entry: ForwardRemoval) => T): T {
  const paths = servicePaths(vaultPath, host);
  const lock = tryAdvisoryFileLock(join(vaultPath, ".kizuki", "service-change.lock"));
  if (lock === null) throw new Error("another service change is in progress");
  try {
    recoverChange(vaultPath, host, paths);
    const previous = host.query(paths.vaultId);
    if (forwardRemoval && host.kind === "launchd" && confirmedFailedLaunchd(previous)) {
      const previous_unit = serviceFile(paths.path);
      if (previous_unit === null) throw new Error("refusing to remove a failed service without its owned definition");
      const entry: ForwardRemoval = { operation: "uninstall", previous_unit, previous_intent: readServeIntent(vaultPath) };
      replaceServiceFile(paths.journal, JSON.stringify({ version: 4, kind: host.kind, identity_hash: paths.identityHash, ...entry }));
      return forwardRemoval(paths, entry);
    }
    if (!confirmedActive(previous) && !confirmedStopped(previous) && !confirmedInactiveEnabled(previous)) {
      throw new Error("service state is unknown or inconsistent; no service change made");
    }
    if (confirmedInactiveEnabled(previous) && !hasEnablementOnly(host)) {
      throw new Error("service enablement-only restoration is unsupported; no service change made");
    }
    const previous_unit = serviceFile(paths.path);
    const previous_enabled = previous.enabled;
    const previous_active = confirmedActive(previous);
    if ((previous_enabled || previous_active) && previous_unit === null) throw new Error("refusing to replace a service without its owned definition");
    replaceServiceFile(paths.journal, JSON.stringify({
      version: 3, kind: host.kind, identity_hash: paths.identityHash,
      previous_unit, previous_intent: readServeIntent(vaultPath), previous_enabled, previous_active,
    }));
    try {
      const result = operation(paths);
      replaceServiceFile(paths.journal, null);
      return result;
    } catch {
      try { recoverChange(vaultPath, host, paths); }
      catch { throw new Error("service change failed; recovery is pending; retry with the same service home"); }
      throw new Error("service change failed; previous configuration restored");
    }
  } finally { lock.release(); }
}

export function installServeService(
  vaultPath: string,
  host: SupervisorHost,
): { status: SupervisorStatus; unitPath: string | null; wrote: boolean } {
  if (host.kind === "none") {
    if (readServeIntent(vaultPath) === "installed") throw new Error("cannot verify an installed service without its supervisor");
    writeServeIntent(vaultPath, "none");
    return { status: host.query(ensureVaultId(vaultPath)), unitPath: null, wrote: false };
  }
  return changeService(vaultPath, host, paths => {
    const spec: UnitSpec = { vaultPath, vaultId: paths.vaultId, execStart: host.execStart, config: loadServeConfig(vaultPath) };
    const body = host.kind === "systemd" ? renderSystemdUnit(spec) : renderLaunchdPlist(spec);
    replaceServiceFile(paths.path, body);
    if (!host.enable(paths.path, paths.unit).ok) throw new Error("service activation failed");
    const status = host.query(paths.vaultId);
    if (!confirmedActive(status)) throw new Error("service activation was not confirmed");
    writeServeIntent(vaultPath, "installed");
    return { status, unitPath: paths.path, wrote: true };
  });
}

export function uninstallServeService(
  vaultPath: string,
  host: SupervisorHost,
): { status: SupervisorStatus; removed: boolean } {
  if (host.kind === "none") {
    if (readServeIntent(vaultPath) === "installed") throw new Error("cannot confirm removal without the installed supervisor");
    writeServeIntent(vaultPath, "opted-out");
    return { status: host.query(ensureVaultId(vaultPath)), removed: false };
  }
  return changeService(vaultPath, host, paths => {
    const before = host.query(paths.vaultId);
    if (!confirmedStopped(before) && !host.disable(paths.unit).ok) throw new Error("service stop failed");
    const status = host.query(paths.vaultId);
    if (!confirmedStopped(status)) throw new Error("service stop was not confirmed");
    const removed = serviceFile(paths.path) !== null;
    // systemd retains failed jobs after definition removal; is-active then emits
    // failed with exit 4 (not-found), which is intentionally not a verified stop.
    // Clear only the stopped owned job while its definition is still available.
    if (host.kind === "systemd" && status.detail === "failed") {
      if (!removed || !host.resetFailure?.(paths.unit).ok) throw new Error("service failure reset failed");
      const cleared = host.query(paths.vaultId);
      if (!confirmedStopped(cleared) || cleared.detail === "failed") throw new Error("service failure reset was not confirmed");
    }
    replaceServiceFile(paths.path, null);
    if (!host.reload().ok) throw new Error("service removal definition reload failed");
    const refreshed = host.query(paths.vaultId);
    if (!confirmedStopped(refreshed)) throw new Error("service removal stopped state remains unverified");
    writeServeIntent(vaultPath, "opted-out");
    return { status: refreshed, removed };
  }, (paths, entry) => completeForwardRemoval(vaultPath, host, paths, entry));
}
