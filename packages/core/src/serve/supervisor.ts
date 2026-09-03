import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { loadServeConfig } from "./config";
import { writeServeIntent } from "./intent";
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
  readonly execStart: string;
  query(vaultId: string): SupervisorStatus;
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

function runCommand(argv: string[]): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync(argv[0] ?? "", argv.slice(1), {
    encoding: "utf8",
    timeout: 5_000,
  });
  return {
    ok: result.status === 0,
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
  };
}

export function realSupervisorHost(
  kind: SupervisorKind,
  home: string,
  execStart: string,
): SupervisorHost {
  return {
    kind,
    home,
    execStart,
    query(vaultId: string): SupervisorStatus {
      const fixture = process.env.KIZUKI_SUPERVISOR_FIXTURE;
      if (
        fixture === "active" ||
        fixture === "disabled" ||
        fixture === "masked" ||
        fixture === "absent" ||
        fixture === "none"
      ) {
        return {
          kind,
          state: fixture,
          unit: kind === "launchd" ? launchdLabel(vaultId) : systemdUnitName(vaultId),
          enabled: fixture === "active",
          detail:
            fixture === "none"
              ? "supervisor: none (loop runs only while you run it)"
              : fixture === "disabled"
                ? "disabled by owner"
                : fixture,
        };
      }
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
        const text = `${enabled.stdout} ${enabled.stderr} ${active.stdout}`.toLowerCase();
        let state: SupervisorState = "absent";
        if (text.includes("masked")) state = "masked";
        else if (enabled.stdout === "enabled" || active.stdout === "active") {
          state = active.stdout === "active" ? "active" : "disabled";
        } else if (enabled.stdout === "disabled") state = "disabled";
        else if (existsSync(systemdUnitPath(home, vaultId))) state = "absent";
        return {
          kind,
          state,
          unit,
          enabled: enabled.stdout === "enabled",
          detail: enabled.stdout || enabled.stderr || active.stdout || "absent",
        };
      }
      const label = launchdLabel(vaultId);
      const printed = runCommand(["launchctl", "print", `gui/${process.getuid?.() ?? 0}/${label}`]);
      const text = `${printed.stdout} ${printed.stderr}`.toLowerCase();
      let state: SupervisorState = "absent";
      if (text.includes("disabled")) state = "disabled";
      else if (printed.ok) state = "active";
      else if (existsSync(launchdPlistPath(home, vaultId))) state = "absent";
      return {
        kind,
        state,
        unit: label,
        enabled: state === "active",
        detail: printed.ok ? "loaded" : printed.stderr || "absent",
      };
    },
    enable(unitPath: string, unitName: string) {
      if (kind === "systemd") {
        runCommand(["systemctl", "--user", "daemon-reload"]);
        const enabled = runCommand(["systemctl", "--user", "enable", "--now", unitName]);
        return {
          ok: enabled.ok,
          detail: enabled.ok ? "enabled" : enabled.stderr || enabled.stdout || "enable failed",
        };
      }
      if (kind === "launchd") {
        const loaded = runCommand(["launchctl", "bootstrap", `gui/${process.getuid?.() ?? 0}`, unitPath]);
        return {
          ok: loaded.ok,
          detail: loaded.ok ? "loaded" : loaded.stderr || loaded.stdout || "bootstrap failed",
        };
      }
      return { ok: false, detail: "no supervisor" };
    },
    disable(unitName: string) {
      if (kind === "systemd") {
        const result = runCommand(["systemctl", "--user", "disable", "--now", unitName]);
        return { ok: result.ok, detail: result.stderr || result.stdout || "disabled" };
      }
      if (kind === "launchd") {
        const result = runCommand([
          "launchctl",
          "bootout",
          `gui/${process.getuid?.() ?? 0}/${unitName}`,
        ]);
        return { ok: result.ok, detail: result.stderr || result.stdout || "unloaded" };
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

export function installServeService(
  vaultPath: string,
  host: SupervisorHost,
): { status: SupervisorStatus; unitPath: string | null; wrote: boolean } {
  const vaultId = ensureVaultId(vaultPath);
  if (host.kind === "none") {
    writeServeIntent(vaultPath, "none");
    return {
      status: host.query(vaultId),
      unitPath: null,
      wrote: false,
    };
  }
  const config = loadServeConfig(vaultPath);
  const spec: UnitSpec = {
    vaultPath,
    vaultId,
    execStart: host.execStart,
    config,
  };
  const unitPath =
    host.kind === "systemd"
      ? systemdUnitPath(host.home, vaultId)
      : launchdPlistPath(host.home, vaultId);
  const body =
    host.kind === "systemd" ? renderSystemdUnit(spec) : renderLaunchdPlist(spec);
  mkdirSync(dirname(unitPath), { recursive: true, mode: 0o700 });
  writeFileSync(unitPath, body, { mode: 0o600 });
  const unitName =
    host.kind === "systemd" ? systemdUnitName(vaultId) : launchdLabel(vaultId);
  host.enable(unitPath, unitName);
  writeServeIntent(vaultPath, "installed");
  return { status: host.query(vaultId), unitPath, wrote: true };
}

export function uninstallServeService(
  vaultPath: string,
  host: SupervisorHost,
): { status: SupervisorStatus; removed: boolean } {
  const vaultId = ensureVaultId(vaultPath);
  const unitName =
    host.kind === "systemd" ? systemdUnitName(vaultId) : launchdLabel(vaultId);
  const unitPath =
    host.kind === "systemd"
      ? systemdUnitPath(host.home, vaultId)
      : launchdPlistPath(host.home, vaultId);
  if (host.kind !== "none") host.disable(unitName);
  let removed = false;
  if (existsSync(unitPath)) {
    unlinkSync(unitPath);
    removed = true;
  }
  writeServeIntent(vaultPath, "opted-out");
  return { status: host.query(vaultId), removed };
}
