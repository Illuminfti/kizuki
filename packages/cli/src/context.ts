import { Database } from "bun:sqlite";
import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  ConnectionStateStore,
  assertVaultControl,
  ensureVaultId,
  initSearch,
  openLedger,
  PortError,
  readVaultId,
} from "@kizuki/core";
import type { RetrievalPort } from "@kizuki/core";
import { openConfiguredRetrieval } from "./retrieval-runtime";
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
    if (!Object.hasOwn(config.vaults, value)) {
      const known = Object.keys(config.vaults).sort();
      throw new Error(
        `unknown vault: ${value}; known: ${known.join(", ") || "(none)"}`,
      );
    }
    const named = config.vaults[value];
    if (named === undefined) {
      throw new Error(`unknown vault: ${value}`);
    }
    return resolve(named);
  }
  return resolve(value);
}

function peekLedgerIdentity(dbPath: string): void {
  const peek = new Database(dbPath, { readonly: true });
  try {
    const tables = peek
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table'",
      )
      .all()
      .map((row) => row.name);
    const names = new Set(tables);
    if (!names.has("schema_version") || !names.has("events")) {
      throw new Error(
        `vault ledger is not a Kizuki database: ${dbPath}; run: kizuki init`,
      );
    }
    const version = peek
      .query<{ version: number }, []>("SELECT version FROM schema_version LIMIT 1")
      .get();
    if (version === null || !Number.isInteger(version.version) || version.version < 1) {
      throw new Error(
        `vault ledger has no usable schema version: ${dbPath}; run: kizuki init`,
      );
    }
  } finally {
    peek.close();
  }
}

export function assertVault(path: string): string {
  const absolutePath = resolve(path);
  const control = join(absolutePath, ".kizuki");
  const archive = join(absolutePath, "archive");
  const dbPath = join(control, "kizuki.db");
  if (!existsSync(control) || !existsSync(archive)) {
    throw new Error(`vault is not initialized: ${absolutePath}; run: kizuki init ${absolutePath}`);
  }
  const identity = readVaultId(absolutePath);
  if (identity === null) {
    throw new Error(
      `vault identity missing: ${absolutePath}; run: kizuki init ${absolutePath}`,
    );
  }
  // Remint a snapshot-cloned identity once this volume lands on a new machine.
  ensureVaultId(absolutePath);
  if (!existsSync(dbPath) || !statSync(dbPath).isFile()) {
    throw new Error(
      `vault ledger missing: ${absolutePath}; run: kizuki init ${absolutePath}`,
    );
  }
  peekLedgerIdentity(dbPath);
  assertVaultControl(absolutePath);
  return absolutePath;
}

export function openVaultDb(vaultPath: string): Database {
  const db = openLedger(join(vaultPath, ".kizuki", "kizuki.db"));
  initSearch(db);
  return db;
}

export interface VaultContext {
  configPath: string;
  vaultPath: string;
  db: Database;
  store: ConnectionStateStore;
  retrieval?: RetrievalPort;
  retrievalUnavailable?: true;
}

export async function withVault<T>(
  io: CliIo,
  fn: (ctx: VaultContext) => Promise<T>,
  options: { retrieval?: "required" | "optional" | "none" } = {},
): Promise<T> {
  const path = configPath(io.env);
  const config = readConfig(path);
  const vaultPath = assertVault(
    resolveVault(io.env, config, io.vaultOverride),
  );
  const db = openVaultDb(vaultPath);
  const store = new ConnectionStateStore(join(vaultPath, ".kizuki"));
  let retrieval: RetrievalPort | undefined;
  try {
    let retrievalUnavailable: true | undefined;
    if (options.retrieval !== "none") {
      try { retrieval = await openConfiguredRetrieval(vaultPath); }
      catch (error) {
        // A live host may hold the optional engine. Reads still use the ledger floor;
        // configuration errors and required mutation/rebuild bindings remain failures.
        if (options.retrieval !== "optional" || !(error instanceof PortError) ||
            !error.retryable || !["lease_required", "timeout", "unavailable"].includes(error.code)) throw error;
        retrievalUnavailable = true;
      }
    }
    return await fn({ configPath: path, vaultPath, db, store,
      ...(retrieval === undefined ? {} : { retrieval }),
      ...(retrievalUnavailable === undefined ? {} : { retrievalUnavailable }),
    });
  } finally {
    try { await retrieval?.close(); } finally { db.close(); }
  }
}
