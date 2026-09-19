import { OWNER, WorldViewError, isWorldWireToken, readWorldView } from "@kizuki/core";
import { UsageError, parseArguments } from "../args";
import { withReadVault } from "../context";
import { jsonEnvelope } from "../output";
import type { CliIo, Command, CommandHelpSchema } from "./index";

const OPERATIONS = ["situation", "concept"] as const;

export const WORLD_SCHEMA = {
  options: ["--operation", "--ref"],
  flags: ["--json"],
  bounds: {
    "--operation": "situation|concept",
    "--ref": "32-byte base64url object token",
  },
} as const satisfies CommandHelpSchema;

export const worldCommand: Command = {
  name: "world",
  usage: "world --operation situation|concept --ref TOKEN [--json]",
  summary: "read the current Concept or Situation for an exact object token",
  schema: WORLD_SCHEMA,
  async run(io: CliIo, args: string[]): Promise<number> {
    const parsed = parseArguments(args, {
      options: [...WORLD_SCHEMA.options],
      flags: [...WORLD_SCHEMA.flags],
    });
    if (parsed.positionals.length !== 0) throw new UsageError(this.usage);

    const operation = parsed.options.get("--operation");
    const ref = parsed.options.get("--ref");
    if (
      operation === undefined ||
      ref === undefined ||
      !(OPERATIONS as readonly string[]).includes(operation) ||
      !isWorldWireToken(ref)
    ) {
      throw new UsageError(this.usage);
    }

    const input =
      operation === "situation"
        ? {
            operation: "situation" as const,
            situation: { kind: "object" as const, token: ref },
            valid: { kind: "all" as const },
            knownAt: { kind: "current" as const },
          }
        : {
            operation: "concept" as const,
            concept: { kind: "object" as const, token: ref },
            valid: { kind: "all" as const },
            knownAt: { kind: "current" as const },
          };

    return withReadVault(io, async (ctx) => {
      let result;
      try {
        result = readWorldView(
          { db: ctx.db, vaultPath: ctx.vaultPath, principal: OWNER },
          input,
        );
      } catch (error) {
        if (error instanceof WorldViewError) throw new UsageError(this.usage);
        throw error;
      }
      ctx.assertCurrent();
      if (parsed.flags.has("--json")) {
        io.out(jsonEnvelope("world", "ok", result));
      } else {
        io.out("not found");
      }
      return 0;
    });
  },
};
