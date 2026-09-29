import pkg from "../../package.json" with { type: "json" };
import { UsageError, parseArguments } from "../args";
import { describeBuild } from "../build-info";
import type { CliIo, Command, CommandHelpSchema } from "./index";

export const VERSION_SCHEMA = {
  options: [],
  flags: [],
} as const satisfies CommandHelpSchema;

export const versionCommand: Command = {
  name: "version",
  usage: "version",
  summary: "print the CLI version with its source revision and build time",
  schema: VERSION_SCHEMA,
  async run(io: CliIo, args: string[]): Promise<number> {
    const parsed = parseArguments(args, {
      options: [...VERSION_SCHEMA.options],
      flags: [...VERSION_SCHEMA.flags],
    });
    if (parsed.positionals.length !== 0) throw new UsageError(this.usage);
    io.out(describeBuild(pkg.version));
    return 0;
  },
};
