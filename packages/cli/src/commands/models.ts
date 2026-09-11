import { resolve } from "node:path";
import {
  installGgufModel,
  listInstalledGgufModels,
  removeInstalledGgufModel,
  vaultModelsDir,
} from "@kizuki/embed-gguf";
import { UsageError, parseArguments } from "../args";
import { assertVault, resolveVault } from "../context";
import { configPath, readConfig } from "../config";
import type { CliIo, Command } from "./index";

const USAGE = "models <list | pull --from PATH [--sha256 HEX] [--bytes N] | remove NAME>";

function modelsDir(io: CliIo): string {
  const path = configPath(io.env);
  const config = readConfig(path);
  return vaultModelsDir(assertVault(resolveVault(io.env, config, io.vaultOverride)));
}

export const modelsCommand: Command = {
  name: "models",
  usage: USAGE,
  summary: "list, install, or remove local GGUF files in the vault models directory",
  async run(io: CliIo, args: string[]): Promise<number> {
    const verb = args[0];
    const rest = args.slice(1);
    if (verb === "list") {
      if (rest.length > 0) throw new UsageError(this.usage);
      for (const model of listInstalledGgufModels(modelsDir(io))) {
        io.out(`filename=${model.filename}`);
        io.out(`path=${model.path}`);
        io.out(`bytes=${model.bytes}`);
        io.out(`sha256=${model.sha256}`);
      }
      return 0;
    }
    if (verb === "remove") {
      if (rest.length !== 1) throw new UsageError(this.usage);
      const removed = removeInstalledGgufModel(modelsDir(io), rest[0]!);
      io.out(`removed=${removed}`);
      return 0;
    }
    if (verb !== "pull") {
      throw new UsageError(this.usage);
    }

    const parsed = parseArguments(rest, {
      options: ["--from", "--sha256", "--bytes"],
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

    const expected = parsed.options.get("--sha256");
    const bytesOpt = parsed.options.get("--bytes");
    let expectedBytes: number | undefined;
    if (bytesOpt !== undefined) {
      if (!/^[1-9][0-9]*$/.test(bytesOpt)) {
        throw new UsageError(this.usage);
      }
      expectedBytes = Number(bytesOpt);
    }
    const installed = installGgufModel({
      source_path: resolve(from),
      dest_dir: modelsDir(io),
      ...(expected === undefined ? {} : { expected_sha256: expected }),
      ...(expectedBytes === undefined ? {} : { expected_bytes: expectedBytes }),
    });

    io.out(`path=${installed.path}`);
    io.out(`bytes=${installed.bytes}`);
    io.out(`sha256=${installed.sha256}`);
    io.out(`space=${installed.space.id}`);
    return 0;
  },
};
