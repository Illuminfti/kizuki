import { resolve } from "node:path";
import {
  detectSupervisorKind,
  ensureVaultId,
  initVault,
  installServeService,
  realSupervisorHost,
  serveExecHint,
  writeServeIntent,
} from "@kizuki/core";
import { UsageError, parseArguments, requirePositional } from "../args";
import {
  type KizukiConfig,
  configPath,
  readConfig,
  writeConfig,
} from "../config";
import type { CliIo, Command } from "./index";

export const initCommand: Command = {
  name: "init",
  usage: "init <path> [--default | --no-default] [--no-service]",
  summary: "create a vault, set default_vault, and install kizuki serve",
  async run(io: CliIo, args: string[]): Promise<number> {
    const path = configPath(io.env);
    const config = readConfig(path);
    const parsed = parseArguments(args, {
      flags: ["--default", "--no-default", "--no-service"],
    });
    const [rawPath] = requirePositional(parsed.positionals, 1);
    if (rawPath === undefined || rawPath.length === 0) {
      throw new UsageError(this.usage);
    }
    if (parsed.flags.has("--default") && parsed.flags.has("--no-default")) {
      throw new UsageError(this.usage);
    }

    const vaultPath = resolve(rawPath);
    initVault(vaultPath);

    let wrote = false;
    if (!parsed.flags.has("--no-default")) {
      if (config.default_vault === undefined || parsed.flags.has("--default")) {
        const next: KizukiConfig = {
          vaults: { ...config.vaults },
          default_vault: vaultPath,
        };
        writeConfig(path, next);
        wrote = true;
      }
    }

    ensureVaultId(vaultPath);
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
      const bun = process.execPath;
      const entry = resolve(import.meta.dir, "../main.ts");
      const host = realSupervisorHost(
        kind,
        io.env.HOME ?? io.env.XDG_CONFIG_HOME ?? "",
        `${bun} ${entry} serve --vault ${vaultPath}`,
      );
      const installed = installServeService(vaultPath, host);
      io.out(vaultPath);
      io.out(`supervisor=${installed.status.kind} state=${installed.status.state}`);
      if (installed.status.state !== "active") {
        io.out(`run: ${serveExecHint(vaultPath)}`);
      }
    }
    if (wrote) io.out(`default_vault set in ${path}`);
    return 0;
  },
};
