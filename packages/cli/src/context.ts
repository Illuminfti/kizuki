import { Database } from "bun:sqlite";
import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  ConnectionStateStore,
  assertVaultControl,
  ensureVaultId,
  initSearch,
  PortError,
  readVaultId,
} from "@kizuki/core";
import type { RetrievalPort } from "@kizuki/core";
import { ledgerAccepted, openLedger, readLedgerMark, sealLedger } from "@kizuki/core/internal";
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

const LEDGER_READY_DEADLINE_MS = 3_000;
const LEDGER_READY_POLL_MS = 250;

function peekLedger(dbPath: string): { accepted: number } {
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
    const versions = peek
      .query<{ version: number }, []>("SELECT version FROM schema_version")
      .all();
    if (versions.length !== 1 || !Number.isInteger(versions[0]?.version) || (versions[0]?.version ?? 0) < 1) {
      throw new Error(
        `vault ledger has no usable schema version: ${dbPath}; run: kizuki init`,
      );
    }
    return { accepted: ledgerAccepted(peek) };
  } finally {
    peek.close();
  }
}

/**
 * Identity intact but the ledger reads short of the mark sealed at the last
 * close: the store is still coming up, or it lost rows with kizuki.db-wal.
 * Neither is a count a command may print. Each poll reopens the file so a
 * store still being restored is seen once it lands; then fail closed.
 */
function awaitLedgerMark(vaultPath: string, dbPath: string): void {
  const mark = readLedgerMark(vaultPath);
  const deadline = Date.now() + LEDGER_READY_DEADLINE_MS;
  let readable = peekLedger(dbPath).accepted;
  while (mark !== null && readable < mark) {
    if (Date.now() >= deadline) {
      throw new Error(
        `vault ledger not ready: ${readable} of ${mark} sealed events readable after ${LEDGER_READY_DEADLINE_MS}ms: ${dbPath}; the store is still restoring or lost kizuki.db-wal. Do not run kizuki init`,
      );
    }
    Bun.sleepSync(LEDGER_READY_POLL_MS);
    readable = peekLedger(dbPath).accepted;
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
  if (!existsSync(dbPath) || !statSync(dbPath).isFile()) {
    throw new Error(
      `vault ledger missing: ${absolutePath}; run: kizuki init ${absolutePath}`,
    );
  }
  awaitLedgerMark(absolutePath, dbPath);
  assertVaultControl(absolutePath);
  // Remint a snapshot-cloned identity once this volume lands on a new machine.
  ensureVaultId(absolutePath);
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
    const result = await fn({ configPath: path, vaultPath, db, store,
      ...(retrieval === undefined ? {} : { retrieval }),
      ...(retrievalUnavailable === undefined ? {} : { retrievalUnavailable }),
    });
    sealLedger(vaultPath, db);
    return result;
  } finally {
    try { await retrieval?.close(); } finally { db.close(); }
  }
}
