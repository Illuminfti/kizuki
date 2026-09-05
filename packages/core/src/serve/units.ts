import type { ServeConfig } from "./types";

export interface UnitSpec {
  readonly vaultPath: string;
  readonly vaultId: string;
  readonly execStart: string | readonly string[];
  readonly config: ServeConfig;
}

export function systemdUnitName(vaultId: string): string {
  return `kizuki@${vaultId}.service`;
}

export function launchdLabel(vaultId: string): string {
  return `dev.kizuki.${vaultId}`;
}

export function systemdUnitPath(home: string, vaultId: string, configHome = `${home}/.config`): string {
  return `${configHome}/systemd/user/${systemdUnitName(vaultId)}`;
}

export function launchdPlistPath(home: string, vaultId: string): string {
  return `${home}/Library/LaunchAgents/${launchdLabel(vaultId)}.plist`;
}

/**
 * RFC 0002 §11.1: no secret in Environment=; vault is the only writable
 * path; network address filtering is deliberately not applied.
 */
export function renderSystemdUnit(spec: UnitSpec): string {
  validateSpec(spec);
  const exec = typeof spec.execStart === "string"
    ? spec.execStart
    : spec.execStart.map((arg) => systemdValue(arg, true)).join(" ");
  return [
    "[Unit]",
    `Description=kizuki serve (${spec.vaultId})`,
    "# Egress is bounded in-process by the CI network allowlist and by connector manifests.",
    "# Network address filtering is deliberately not applied because connectors need egress.",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${exec}`,
    `WorkingDirectory=${systemdValue(spec.vaultPath)}`,
    "Restart=on-failure",
    "NoNewPrivileges=true",
    "PrivateTmp=true",
    "ProtectSystem=strict",
    "ProtectHome=read-only",
    `ReadWritePaths=${systemdValue(spec.vaultPath)}`,
    "RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6",
    "UMask=0077",
    `MemoryMax=${spec.config.memory_max}`,
    `CPUQuota=${spec.config.cpu_quota}`,
    `Nice=${spec.config.nice}`,
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

export function renderLaunchdPlist(spec: UnitSpec): string {
  validateSpec(spec);
  const argv = typeof spec.execStart === "string"
    ? spec.execStart.split(/\s+/).filter((part) => part.length > 0)
    : spec.execStart;
  const args = argv
    .map((part) => `    <string>${escapeXml(part)}</string>`)
    .join("\n");
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<plist version="1.0">`,
    `<dict>`,
    `  <key>Label</key>`,
    `  <string>${escapeXml(launchdLabel(spec.vaultId))}</string>`,
    `  <key>ProgramArguments</key>`,
    `  <array>`,
    args,
    `  </array>`,
    `  <key>WorkingDirectory</key>`,
    `  <string>${escapeXml(spec.vaultPath)}</string>`,
    `  <key>RunAtLoad</key>`,
    `  <true/>`,
    `  <key>KeepAlive</key>`,
    `  <true/>`,
    `  <key>Umask</key>`,
    `  <integer>63</integer>`,
    `  <key>Nice</key>`,
    `  <integer>${spec.config.nice}</integer>`,
    `</dict>`,
    `</plist>`,
    "",
  ].join("\n");
}

/** Supervisor commands are argument vectors; paths are never shell code. */
function validateSpec(spec: UnitSpec): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(spec.vaultId)) {
    throw new Error("invalid vault identity for a user service");
  }
  const argv = typeof spec.execStart === "string" ? [spec.execStart] : spec.execStart;
  if (argv.length === 0 || argv[0]?.length === 0) {
    throw new Error("user service requires an executable");
  }
  for (const value of [spec.vaultPath, ...argv]) {
    if (/[\x00-\x1f\x7f]/.test(value)) {
      throw new Error("user service paths and arguments must not contain control characters");
    }
  }
}

function systemdValue(value: string, command = false): string {
  if (/^[a-zA-Z0-9_./:-]+$/.test(value)) return value;
  const escaped = value.replaceAll("%", "%%");
  return JSON.stringify(command ? escaped.replaceAll("$", () => "$$") : escaped);
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
