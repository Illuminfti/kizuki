import { OWNER, ServeError, serveWorldView } from "@kizuki/core";
import { WorldViewError } from "@kizuki/core/world";
import { UsageError, parseArguments } from "../args";
import { withVault } from "../context";
import { jsonEnvelope } from "../output";
import type { CliIo, Command, CommandHelpSchema } from "./index";
import { WORLD_CLI_OPS } from "./world/ops";
import type { WorldCliEntry } from "./world/ops";

/** `kizuki world`, generated from the entries: usage, options and bounds all follow the operations that have a command-line form. */
export function createWorldCommand(entries: readonly WorldCliEntry[]): Command {
  const ops = entries.flatMap((entry) => (entry.cli === null ? [] : [{ name: entry.name, cli: entry.cli }]));
  const schema: CommandHelpSchema = {
    options: ["--operation", ...new Set(ops.flatMap((op) => op.cli.options))],
    flags: ["--json"],
    bounds: {
      ...ops.reduce((all, op) => ({ ...all, ...op.cli.bounds }), {}),
      "--operation": ops.map((op) => op.name).join("|"),
    },
  };
  const usage = ops
    .map((op) => ["world --operation", op.name, op.cli.usage, "[--json]"].filter((part) => part !== "").join(" "))
    .join(" | ");
  return {
    name: "world",
    usage,
    summary: "discover and read admitted Concepts and Situations in your current scope",
    schema,
    async run(io: CliIo, args: string[]): Promise<number> {
      const parsed = parseArguments(args, { options: [...schema.options], flags: [...schema.flags] });
      if (parsed.positionals.length !== 0) throw new UsageError(usage);
      const name = parsed.options.get("--operation");
      const op = ops.find((candidate) => candidate.name === name);
      if (op === undefined) throw new UsageError(usage);
      for (const option of parsed.options.keys())
        if (option !== "--operation" && !op.cli.options.includes(option)) throw new UsageError(usage);
      const built = op.cli.buildInput(parsed.options);
      if (built === null) throw new UsageError(usage);
      const input = { operation: op.name, ...built };
      // Reference issuance is durable bookkeeping and needs the normal bound ledger writer.
      return withVault(
        io,
        async (ctx) => {
          try {
            const envelope = serveWorldView({ db: ctx.db, vaultPath: ctx.vaultPath, principal: OWNER }, input);
            const data = envelope.data;
            if (parsed.flags.has("--json")) io.out(jsonEnvelope("world", "ok", envelope));
            else if ("status" in data) io.out("not found");
            else if (data.result.status === "unavailable") io.out(`World view unavailable: ${data.result.reason}.`);
            else for (const line of op.cli.render(data.result.data)) io.out(line);
            if (!("status" in data) && data.result.status !== "unavailable") {
              const notice = op.cli.notice?.(data.result.data);
              if (notice) io.err(notice);
            }
          } catch (error) {
            if (error instanceof WorldViewError || (error instanceof ServeError && error.code === "invalid_arguments"))
              throw new UsageError(usage);
            throw error;
          }
          return 0;
        },
        { retrieval: "none" },
      );
    },
  };
}

export const worldCommand: Command = createWorldCommand(WORLD_CLI_OPS);
