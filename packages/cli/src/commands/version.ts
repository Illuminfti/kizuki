import pkg from "../../package.json" with { type: "json" };
import { UsageError, parseArguments } from "../args";
import type { CliIo, Command } from "./index";

export const versionCommand: Command = {
  name: "version",
  usage: "version",
  summary: "print the CLI package version",
  async run(io: CliIo, args: string[]): Promise<number> {
    const parsed = parseArguments(args, {});
    if (parsed.positionals.length !== 0) throw new UsageError(this.usage);
    io.out(pkg.version);
    return 0;
  },
};
