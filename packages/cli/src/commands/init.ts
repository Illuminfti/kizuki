import { join, resolve } from "node:path";
import {
  type InitInventory,
  VaultInitError,
  detectSupervisorKind,
  ensureVaultId,
  hardenLedgerFile,
  initVault,
  installServeService,
  openLedger,
  serveExecHint,
  writeServeIntent,
} from "@kizuki/core";
import { UsageError, parseArguments, requirePositional } from "../args";
import {
  type KizukiConfig,
  cloneVaults,
  configPath,
  readConfig,
  writeConfig,
} from "../config";
import type { CliIo, Command } from "./index";
import { serveSupervisorHost } from "../service-host";

export const initCommand: Command = {
  name: "init",
  usage: "init <path> [--default | --no-default] [--no-service] [--adopt] [--dry-run]",
  summary: "create a vault and install the local serve loop",
  async run(io: CliIo, args: string[]): Promise<number> {
    const path = configPath(io.env);
    const config = readConfig(path);
    const parsed = parseArguments(args, {
      flags: ["--default", "--no-default", "--no-service", "--adopt", "--dry-run"],
    });
    const [rawPath] = requirePositional(parsed.positionals, 1);
    if (rawPath === undefined || rawPath.length === 0) {
      throw new UsageError(this.usage);
    }
    if (parsed.flags.has("--default") && parsed.flags.has("--no-default")) {
      throw new UsageError(this.usage);
    }

    const vaultPath = resolve(rawPath);
    let result;
    try {
      result = initVault(vaultPath, {
        adopt: parsed.flags.has("--adopt"),
        dryRun: parsed.flags.has("--dry-run"),
      });
    } catch (error) {
      if (error instanceof VaultInitError && error.inventory !== undefined) {
        io.err(
          `adopt entries=${error.inventory.entry_count} markdown=${error.inventory.markdown_count} git=${error.inventory.has_git ? "yes" : "no"}`,
        );
        for (const name of error.inventory.names) io.err(`entry ${name}`);
      }
      throw error;
    }
    if (result.dry_run) {
      printInventory(io, vaultPath, result.inventory, true);
      return 0;
    }
    ensureVaultId(vaultPath);
    const ledgerPath = join(vaultPath, ".kizuki", "kizuki.db");
    const ledger = openLedger(ledgerPath);
    ledger.close();
    hardenLedgerFile(ledgerPath);

    let wrote = false;
    if (!parsed.flags.has("--no-default")) {
      if (config.default_vault === undefined || parsed.flags.has("--default")) {
        const next: KizukiConfig = {
          schema: config.schema,
          vaults: cloneVaults(config.vaults),
          default_vault: vaultPath,
        };
        writeConfig(path, next);
        wrote = true;
      }
    }

    const kind = detectSupervisorKind(io.env);
    if (parsed.flags.has("--no-service")) {
      writeServeIntent(vaultPath, "opted-out");
      io.out(vaultPath);
      io.out("service: opted out (--no-service)");
    } else if (kind === "none") {
      writeServeIntent(vaultPath, "none");
      io.out(vaultPath);
      io.out("supervisor: none (loop runs only while you run it)");
      io.out(`run: ${serveExecHint(vaultPath)}`);
    } else {
      const host = serveSupervisorHost(io.env, vaultPath);
      const installed = installServeService(vaultPath, host);
      io.out(vaultPath);
      io.out(`supervisor=${installed.status.kind} state=${installed.status.state}`);
      if (installed.status.state !== "active") {
        io.out(`run: ${serveExecHint(vaultPath)}`);
      }
    }
    if (wrote) io.out(`default_vault set in ${path}`);
    if (result.inventory !== null) {
      printInventory(io, vaultPath, result.inventory, false);
    }
    io.out("next: import a file source, then query and doctor");
    return 0;
  },
};

function printInventory(
  io: CliIo,
  vaultPath: string,
  inventory: InitInventory | null,
  dryRun: boolean,
): void {
  if (dryRun) io.out(`dry-run ${vaultPath}`);
  if (inventory === null) {
    if (dryRun) io.out("entries=0");
    return;
  }
  io.out(
    `adopt entries=${inventory.entry_count} markdown=${inventory.markdown_count} git=${inventory.has_git ? "yes" : "no"} symlinks=${inventory.symlink_count}`,
  );
  if (dryRun) {
    for (const name of inventory.names) io.out(`entry ${name}`);
    for (const name of inventory.reserved_conflicts) io.out(`reserved_conflict ${name}`);
  }
}
