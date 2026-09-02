import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { isPlainObject } from "@kizuki/core";

export interface KizukiConfig {
  default_vault?: string;
  vaults: Record<string, string>;
}

export class ConfigError extends Error {
  override name = "ConfigError";
}

export function configPath(env: Record<string, string | undefined>): string {
  if (env.KIZUKI_CONFIG !== undefined && env.KIZUKI_CONFIG.length > 0) {
    return env.KIZUKI_CONFIG;
  }
  if (
    env.XDG_CONFIG_HOME !== undefined &&
    env.XDG_CONFIG_HOME.length > 0
  ) {
    return join(env.XDG_CONFIG_HOME, "kizuki", "config.toml");
  }
  return join(env.HOME ?? "", ".config", "kizuki", "config.toml");
}

export function readConfig(path: string): KizukiConfig {
  if (!existsSync(path)) return { vaults: {} };

  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(readFileSync(path, "utf8"));
  } catch {
    throw new ConfigError(`${path}: invalid TOML`);
  }
  if (!isPlainObject(parsed)) {
    throw new ConfigError(`${path}: config must be a table`);
  }

  for (const key of Object.keys(parsed)) {
    if (key !== "default_vault" && key !== "vaults") {
      throw new ConfigError(`${path}: unknown key ${key}`);
    }
  }

  const config: KizukiConfig = { vaults: {} };
  if ("default_vault" in parsed) {
    if (typeof parsed["default_vault"] !== "string") {
      throw new ConfigError(`${path}: default_vault must be a string`);
    }
    config.default_vault = parsed["default_vault"];
  }
  if ("vaults" in parsed) {
    const vaults = parsed["vaults"];
    if (!isPlainObject(vaults)) {
      throw new ConfigError(`${path}: vaults must be a table`);
    }
    for (const [name, value] of Object.entries(vaults)) {
      if (typeof value !== "string") {
        throw new ConfigError(`${path}: vaults.${name} must be a string`);
      }
      config.vaults[name] = value;
    }
  }
  return config;
}

export function serializeConfig(config: KizukiConfig): string {
  const lines: string[] = [];
  if (config.default_vault !== undefined) {
    lines.push(`default_vault = ${JSON.stringify(config.default_vault)}`);
    lines.push("");
  }
  lines.push("[vaults]");
  for (const key of Object.keys(config.vaults).sort()) {
    lines.push(`${key} = ${JSON.stringify(config.vaults[key])}`);
  }
  lines.push("");
  return lines.join("\n");
}

export function writeConfig(path: string, config: KizukiConfig): void {
  readConfig(path);
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  chmodSync(parent, 0o700);
  writeFileSync(path, serializeConfig(config), { mode: 0o600 });
  chmodSync(path, 0o600);
}
