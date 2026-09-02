import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { ConnectionStateStore, initSearch, openLedger } from "@kizuki/core";
import { initStaging } from "@kizuki/core/staging";
import type { CliIo } from "./commands/index";
import {
  type KizukiConfig,
  configPath,
  readConfig,
} from "./config";

export function resolveVault(
  env: Record<string, string | undefined>,
  config: KizukiConfig,
  override: string | null,
): string {
  if (override !== null && override.length > 0) {
    return resolveVaultOverride(override, config);
  }
  const fromEnv = env.KIZUKI_VAULT;
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return resolve(fromEnv);
  }
  if (config.default_vault !== undefined && config.default_vault.length > 0) {
    return resolve(config.default_vault);
  }
  throw new Error("no vault configured; run: kizuki init <path>");
}

function resolveVaultOverride(value: string, config: KizukiConfig): string {
  if (!value.includes("/")) {
    const named = config.vaults[value];
    if (named === undefined) {
      const known = Object.keys(config.vaults).sort();
      throw new Error(
        `unknown vault: ${value}; known: ${known.join(", ") || "(none)"}`,
      );
    }
    return resolve(named);
  }
  return resolve(value);
}

export function assertVault(path: string): string {
  const absolutePath = resolve(path);
  if (
    !existsSync(join(absolutePath, ".kizuki")) ||
    !existsSync(join(absolutePath, "archive"))
  ) {
    throw new Error(`vault is not initialized: ${absolutePath}`);
  }
  return absolutePath;
}

export function openVaultDb(vaultPath: string): Database {
  const db = openLedger(join(vaultPath, ".kizuki", "kizuki.db"));
  initStaging(db);
  initSearch(db);
  return db;
}

export interface VaultContext {
  configPath: string;
  vaultPath: string;
  db: Database;
  store: ConnectionStateStore;
}

export async function withVault<T>(
  io: CliIo,
  fn: (ctx: VaultContext) => Promise<T>,
): Promise<T> {
  const path = configPath(io.env);
  const config = readConfig(path);
  const vaultPath = assertVault(
    resolveVault(io.env, config, io.vaultOverride),
  );
  const db = openVaultDb(vaultPath);
  const store = new ConnectionStateStore(join(vaultPath, ".kizuki"));
  try {
    return await fn({ configPath: path, vaultPath, db, store });
  } finally {
    db.close();
  }
}
