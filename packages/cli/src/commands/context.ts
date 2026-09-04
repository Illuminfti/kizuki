import {
  OWNER,
  PACKET_PURPOSES,
  initAgents,
  serveContextPacket,
} from "@kizuki/core";
import type { PacketPurpose } from "@kizuki/core";
import { UsageError, parseArguments } from "../args";
import { withVault } from "../context";
import { jsonEnvelope } from "../output";
import type { CliIo, Command } from "./index";

function parseBudget(raw: string): number {
  if (!/^[0-9]+$/.test(raw)) throw new UsageError("invalid --budget");
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 50 || value > 2_000) {
    throw new UsageError("invalid --budget");
  }
  return value;
}

export const contextCommand: Command = {
  name: "context",
  usage:
    "context [--purpose session|recall|correction|audit] [--budget N] [--query TEXT] [--json]",
  summary: "compile a purpose-scoped context packet with provenance stamps",
  async run(io: CliIo, args: string[]): Promise<number> {
    const parsed = parseArguments(args, {
      options: ["--purpose", "--budget", "--query"],
      flags: ["--json"],
    });
    if (parsed.positionals.length !== 0) throw new UsageError(this.usage);

    const rawPurpose = parsed.options.get("--purpose") ?? "session";
    if (!(PACKET_PURPOSES as readonly string[]).includes(rawPurpose)) {
      throw new UsageError(this.usage);
    }
    const rawBudget = parsed.options.get("--budget");
    const query = parsed.options.get("--query");

    return withVault(io, async (ctx) => {
      initAgents(ctx.db);
      const envelope = serveContextPacket(
        { db: ctx.db, vaultPath: ctx.vaultPath, principal: OWNER },
        {
          purpose: rawPurpose as PacketPurpose,
          ...(rawBudget === undefined ? {} : { budget_tokens: parseBudget(rawBudget) }),
          ...(query === undefined ? {} : { query }),
        },
      );
      if (parsed.flags.has("--json")) {
        io.out(jsonEnvelope("context", "ok", envelope));
        return 0;
      }
      io.out(envelope.data?.packet_md ?? "KIZUKI CONTEXT v1");
      return 0;
    });
  },
};
