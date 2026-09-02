import { resolve } from "node:path";
import { installGgufModel, vaultModelsDir } from "@kizuki/embed-gguf";
import { UsageError, parseArguments } from "../args";
import { assertVault, resolveVault } from "../context";
import { configPath, readConfig } from "../config";
import type { CliIo, Command } from "./index";

export const modelsCommand: Command = {
  name: "models",
  usage: "models pull --from PATH [--sha256 HEX]",
  summary: "install a local GGUF into the vault models directory",
  async run(io: CliIo, args: string[]): Promise<number> {
    const verb = args[0];
    const rest = args.slice(1);
    if (verb !== "pull") {
      throw new UsageError(this.usage);
    }

    const parsed = parseArguments(rest, {
      options: ["--from", "--sha256"],
    });
    const from = parsed.options.get("--from");
    if (from === undefined || from.length === 0) {
      io.err(
        "error: models pull requires --from PATH; this command does not download weights",
      );
      throw new UsageError(this.usage);
    }
    if (parsed.positionals.length > 0) {
      throw new UsageError(this.usage);
    }

    const path = configPath(io.env);
    const config = readConfig(path);
    const vaultPath = assertVault(
      resolveVault(io.env, config, io.vaultOverride),
    );
    const expected = parsed.options.get("--sha256");
    const installed = installGgufModel({
      source_path: resolve(from),
      dest_dir: vaultModelsDir(vaultPath),
      ...(expected === undefined ? {} : { expected_sha256: expected }),
    });

    io.out(`path=${installed.path}`);
    io.out(`bytes=${installed.bytes}`);
    io.out(`sha256=${installed.sha256}`);
    io.out(`space=${installed.space.id}`);
    return 0;
  },
};
