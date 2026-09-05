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
  summary: "give your agent relevant context, with sources and a token budget",
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
    const budget = rawBudget === undefined ? undefined : parseBudget(rawBudget);
    const query = parsed.options.get("--query");

    return withVault(io, async (ctx) => {
      initAgents(ctx.db);
      const envelope = await serveContextPacket(
        { db: ctx.db, vaultPath: ctx.vaultPath, principal: OWNER, ...(ctx.retrieval === undefined ? {} : { retrieval: ctx.retrieval }) },
        {
          purpose: rawPurpose as PacketPurpose,
          ...(budget === undefined ? {} : { budget_tokens: budget }),
          ...(query === undefined ? {} : { query }),
        },
      );
      const retrievalDegraded = envelope.data?.retrieval_degraded ?? [];
      if (retrievalDegraded.length > 0) io.err(`degraded=${retrievalDegraded.join(",")}`);
      const incomplete = envelope.data === undefined || envelope.denied.some(
        (entry) => entry.reason === "error",
      );
      if (incomplete) {
        io.err("Context could not be gathered completely. Run kizuki doctor to check the vault.");
      } else if (envelope.data !== undefined && Object.values(envelope.data.sections).every((count) => count === 0)) {
        io.err("No matching context fits this packet. Try a broader --query or a larger --budget; use kizuki doctor to check your sources.");
      }
      if (parsed.flags.has("--json")) {
        io.out(jsonEnvelope("context", incomplete || retrievalDegraded.length > 0 ? "degraded" : "ok", envelope, {
          degraded: incomplete ? ["context-unavailable", ...retrievalDegraded] : retrievalDegraded,
        }));
      } else if (envelope.data !== undefined) {
        io.out(envelope.data.packet_md);
      }
      return incomplete ? 1 : 0;
    });
  },
};
