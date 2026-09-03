import type { ServeConfig } from "./types";

export interface UnitSpec {
  readonly vaultPath: string;
  readonly vaultId: string;
  readonly execStart: string;
  readonly config: ServeConfig;
}

export function systemdUnitName(vaultId: string): string {
  return `kizuki@${vaultId}.service`;
}

export function launchdLabel(vaultId: string): string {
  return `dev.kizuki.${vaultId}`;
}

export function systemdUnitPath(home: string, vaultId: string): string {
  return `${home}/.config/systemd/user/${systemdUnitName(vaultId)}`;
}

export function launchdPlistPath(home: string, vaultId: string): string {
  return `${home}/Library/LaunchAgents/${launchdLabel(vaultId)}.plist`;
}

/**
 * RFC 0002 §11.1: no secret in Environment=; vault is the only writable
 * path; network address filtering is deliberately not applied.
 */
export function renderSystemdUnit(spec: UnitSpec): string {
  return [
    "[Unit]",
    `Description=kizuki serve (${spec.vaultId})`,
    "# Egress is bounded in-process by the CI network allowlist and by connector manifests.",
    "# Network address filtering is deliberately not applied because connectors need egress.",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${spec.execStart}`,
    `WorkingDirectory=${spec.vaultPath}`,
    "Restart=on-failure",
    "NoNewPrivileges=true",
    "PrivateTmp=true",
    "ProtectSystem=strict",
    "ProtectHome=read-only",
    `ReadWritePaths=${spec.vaultPath}`,
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
  const args = spec.execStart
    .split(/\s+/)
    .filter((part) => part.length > 0)
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

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
