import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { isPlainObject } from "@kizuki/core";
import { withExclusiveLock, writeAtomicFile } from "./atomic-file";

export const CONFIG_SCHEMA = "kizuki.cli.config/v1" as const;
export const ALIAS_GRAMMAR = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const RESERVED_ALIAS = new Set(["constructor", "prototype", "__proto__"]);

export interface KizukiConfig {
  schema: typeof CONFIG_SCHEMA;
  default_vault?: string;
  vaults: Record<string, string>;
}

export class ConfigError extends Error {
  override name = "ConfigError";
}

export function emptyVaults(): Record<string, string> {
  return Object.create(null) as Record<string, string>;
}

export function cloneVaults(vaults: Record<string, string>): Record<string, string> {
  const next = emptyVaults();
  for (const key of Reflect.ownKeys(vaults)) {
    if (typeof key !== "string") continue;
    const value = vaults[key];
    if (typeof value === "string") next[key] = value;
  }
  return next;
}

function requireAbsolute(value: string, name: string): string {
  if (!isAbsolute(value)) {
    throw new ConfigError(`${name} must be an absolute path`);
  }
  return value;
}

export function configPath(env: Record<string, string | undefined>): string {
  if (env.KIZUKI_CONFIG !== undefined && env.KIZUKI_CONFIG.length > 0) {
    return requireAbsolute(env.KIZUKI_CONFIG, "KIZUKI_CONFIG");
  }
  if (env.XDG_CONFIG_HOME !== undefined && env.XDG_CONFIG_HOME.length > 0) {
    return join(
      requireAbsolute(env.XDG_CONFIG_HOME, "XDG_CONFIG_HOME"),
      "kizuki",
      "config.toml",
    );
  }
  if (env.HOME !== undefined && env.HOME.length > 0) {
    return join(requireAbsolute(env.HOME, "HOME"), ".config", "kizuki", "config.toml");
  }
  throw new ConfigError(
    "no user config directory; set HOME, XDG_CONFIG_HOME, or KIZUKI_CONFIG",
  );
}

export function assertAliasName(name: string): string {
  if (RESERVED_ALIAS.has(name) || !ALIAS_GRAMMAR.test(name)) {
    throw new ConfigError(
      `invalid vault alias ${JSON.stringify(name)}; use [A-Za-z][A-Za-z0-9_-]{0,63}`,
    );
  }
  return name;
}

function quoteTomlKey(key: string): string {
  return ALIAS_GRAMMAR.test(key) ? key : JSON.stringify(key);
}

export function readConfig(path: string): KizukiConfig {
  if (!existsSync(path)) {
    return { schema: CONFIG_SCHEMA, vaults: emptyVaults() };
  }

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
    if (key !== "schema" && key !== "default_vault" && key !== "vaults") {
      throw new ConfigError(`${path}: unknown key ${key}`);
    }
  }

  if ("schema" in parsed && parsed["schema"] !== CONFIG_SCHEMA) {
    throw new ConfigError(`${path}: unsupported schema ${String(parsed["schema"])}`);
  }

  const config: KizukiConfig = { schema: CONFIG_SCHEMA, vaults: emptyVaults() };
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
      config.vaults[assertAliasName(name)] = value;
    }
  }
  return config;
}

export function serializeConfig(config: KizukiConfig): string {
  const lines: string[] = [`schema = ${JSON.stringify(CONFIG_SCHEMA)}`, ""];
  if (config.default_vault !== undefined) {
    lines.push(`default_vault = ${JSON.stringify(config.default_vault)}`);
    lines.push("");
  }
  lines.push("[vaults]");
  for (const key of Object.keys(config.vaults).sort()) {
    lines.push(`${quoteTomlKey(key)} = ${JSON.stringify(config.vaults[key])}`);
  }
  lines.push("");
  return lines.join("\n");
}

export function writeConfig(path: string, config: KizukiConfig): void {
  withExclusiveLock(`${path}.lock`, () => {
    if (existsSync(path)) readConfig(path);
    writeAtomicFile(path, serializeConfig(config), 0o600);
  });
}
