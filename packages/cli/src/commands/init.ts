import { resolve } from "node:path";
import { initVault } from "@kizuki/core";
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
  usage: "init <path> [--default | --no-default]",
  summary: "create a vault and set default_vault when none is configured",
  async run(io: CliIo, args: string[]): Promise<number> {
    const path = configPath(io.env);
    const config = readConfig(path);
    const parsed = parseArguments(args, {
      flags: ["--default", "--no-default"],
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

    io.out(vaultPath);
    if (wrote) io.out(`default_vault set in ${path}`);
    return 0;
  },
};
