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
  /** Activate the current unit bytes, including replacement of an older running definition. */
  enable(unitPath: string, unitName: string): { ok: boolean; detail: string };
  disable(unitName: string): { ok: boolean; detail: string };
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

function runCommand(argv: string[]): { ok: boolean; exitCode: number | null; stdout: string; stderr: string } {
  const result = spawnSync(argv[0] ?? "", argv.slice(1), {
    encoding: "utf8",
    timeout: 5_000,
  });
  return {
    ok: result.status === 0,
    exitCode: result.status,
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
  };
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
        } else if (absent && active.exitCode === 4 && active.stdout === "unknown") state = "absent";
        return {
          kind,
          state,
          unit,
          enabled: enabled.ok && enabled.stdout === "enabled",
          detail: state === "unknown" ? "supervisor state could not be queried" : state,
        };
      }
      const label = launchdLabel(vaultId);
      const printed = runCommand(["launchctl", "print", `gui/${process.getuid?.() ?? 0}/${label}`]);
      const text = `${printed.stdout} ${printed.stderr}`.toLowerCase();
      let state: SupervisorState = "unknown";
      if (text.includes("disabled")) state = "disabled";
      else if (printed.ok) state = /^\s*state = running\s*$/m.test(printed.stdout) && /^\s*pid = [1-9]\d*\s*$/m.test(printed.stdout) ? "active" : "disabled";
      else if (text.includes("could not find service")) state = "absent";
      return {
        kind,
        state,
        unit: label,
        enabled: printed.ok,
        detail: state === "unknown" ? "supervisor state could not be queried" : state,
      };
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
        const domain = `gui/${process.getuid?.() ?? 0}`;
        if (runCommand(["launchctl", "print", `${domain}/${unitName}`]).ok) {
          const stopped = runCommand(["launchctl", "bootout", `${domain}/${unitName}`]);
          if (!stopped.ok) return { ok: false, detail: "service replacement stop failed" };
        }
        const loaded = runCommand(["launchctl", "bootstrap", `gui/${process.getuid?.() ?? 0}`, unitPath]);
        return {
          ok: loaded.ok,
          detail: loaded.ok ? "loaded" : "service bootstrap failed",
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
        const result = runCommand([
          "launchctl",
          "bootout",
          `gui/${process.getuid?.() ?? 0}/${unitName}`,
        ]);
        return { ok: result.ok, detail: result.ok ? "unloaded" : "service unload failed" };
      }
      return { ok: true, detail: "no supervisor" };
    },
  };
}

export function queryServeService(
  vaultPath: string,
  host: SupervisorHost,
): SupervisorStatus {
  return host.query(ensureVaultId(vaultPath));
}

interface ServiceChange {
  readonly version: 2;
  readonly kind: SupervisorKind;
  readonly identity_hash: string;
  readonly previous_unit: string | null;
  readonly previous_intent: ServeIntent;
  readonly previous_enabled: boolean;
}

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

function recoverChange(vaultPath: string, host: SupervisorHost, paths: ReturnType<typeof servicePaths>): void {
  const raw = serviceFile(paths.journal);
  if (raw === null) return;
  let entry: ServiceChange;
  try {
    const value = JSON.parse(raw);
    if (value === null || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join(",") !== "identity_hash,kind,previous_enabled,previous_intent,previous_unit,version" ||
      value.version !== 2 || value.kind !== host.kind || value.identity_hash !== paths.identityHash ||
      !(value.previous_unit === null || typeof value.previous_unit === "string") ||
      typeof value.previous_enabled !== "boolean" || (value.previous_enabled && value.previous_unit === null) ||
      !isServeIntent(value.previous_intent)) throw new Error();
    entry = value;
  } catch { throw new Error("service recovery snapshot is invalid or belongs to another vault or service location"); }
  const current = host.query(paths.vaultId);
  if (!confirmedStopped(current)) {
    if (!host.disable(paths.unit).ok || !confirmedStopped(host.query(paths.vaultId))) throw new Error("service recovery could not confirm stop; previous configuration retained");
  }
  replaceServiceFile(paths.path, entry.previous_unit);
  if (entry.previous_enabled) {
    if (entry.previous_unit === null || !host.enable(paths.path, paths.unit).ok || !confirmedActive(host.query(paths.vaultId))) {
      throw new Error("previous service configuration restored but activation remains unverified");
    }
  }
  writeServeIntent(vaultPath, entry.previous_intent);
  replaceServiceFile(paths.journal, null);
}

function changeService<T>(vaultPath: string, host: SupervisorHost, operation: (paths: ReturnType<typeof servicePaths>) => T): T {
  const paths = servicePaths(vaultPath, host);
  const lock = tryAdvisoryFileLock(join(vaultPath, ".kizuki", "service-change.lock"));
  if (lock === null) throw new Error("another service change is in progress");
  try {
    recoverChange(vaultPath, host, paths);
    const previous = host.query(paths.vaultId);
    if (!confirmedActive(previous) && !confirmedStopped(previous)) throw new Error("service state is unknown or inconsistent; no service change made");
    const entry: ServiceChange = {
      version: 2, kind: host.kind, identity_hash: paths.identityHash,
      previous_unit: serviceFile(paths.path), previous_intent: readServeIntent(vaultPath),
      previous_enabled: previous.enabled || previous.state === "active",
    };
    if (entry.previous_enabled && entry.previous_unit === null) throw new Error("refusing to replace a service without its owned definition");
    replaceServiceFile(paths.journal, JSON.stringify(entry));
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
    replaceServiceFile(paths.path, null);
    writeServeIntent(vaultPath, "opted-out");
    return { status, removed };
  });
}
