import { PROPOSAL_KINDS } from "@kizuki/core";
import {
  STAGING_STATUSES,
  listProposals,
} from "@kizuki/core/staging";
import type { ProposalKind } from "@kizuki/core";
import type { StagingStatus } from "@kizuki/core/staging";
import { runAudit } from "@kizuki/tui";
import { UsageError, parseArguments } from "../args";
import { withVault } from "../context";
import { indexPromotedSince } from "../derived";
import { clean, jsonLine, table } from "../output";
import type { CliIo, Command } from "./index";

export const reviewCommand: Command = {
  name: "review",
  usage:
    "review [--list] [--batch] [--status pending|promoted|rejected|withdrawn] [--kind K] [--json]",
  summary: "open the audit TUI, or list leftover staged proposals",
  async run(io: CliIo, args: string[]): Promise<number> {
    const parsed = parseArguments(args, {
      options: ["--status", "--kind"],
      flags: ["--list", "--batch", "--json"],
    });
    if (parsed.positionals.length !== 0) throw new UsageError(this.usage);
    if (parsed.flags.has("--batch") && parsed.flags.has("--list")) {
      throw new UsageError(this.usage);
    }

    const rawStatus = parsed.options.get("--status") ?? "pending";
    if (!(STAGING_STATUSES as readonly string[]).includes(rawStatus)) {
      throw new UsageError(this.usage);
    }
    const rawKind = parsed.options.get("--kind");
    if (
      rawKind !== undefined &&
      !(PROPOSAL_KINDS as readonly string[]).includes(rawKind)
    ) {
      throw new UsageError(this.usage);
    }

    const interactive =
      io.stdinIsTTY && io.stdoutIsTTY && !parsed.flags.has("--list");

    return withVault(io, async (ctx) => {
      if (interactive) {
        const startedAt = new Date().toISOString();
        const summary = await runAudit({
          db: ctx.db,
          vaultPath: ctx.vaultPath,
        });
        indexPromotedSince(ctx.db, ctx.vaultPath, startedAt);
        io.out(`session undone=${summary.undone}`);
        return 0;
      }

      const rows = listProposals(ctx.db, {
        status: rawStatus as StagingStatus,
        limit: 5000,
        ...(rawKind === undefined
          ? {}
          : { kind: rawKind as ProposalKind }),
      });

      if (parsed.flags.has("--json")) {
        for (const row of rows) io.out(jsonLine(row));
        return 0;
      }

      const lines = table([
        ["id", "kind", "target", "producer", "confidence", "summary"],
        ...rows.map((row) => [
          row.proposal_id,
          row.kind,
          row.target ?? "",
          row.producer,
          String(row.confidence),
          clean(row.body).slice(0, 160),
        ]),
      ]);
      for (const line of lines) io.out(line);
      return 0;
    });
  },
};
