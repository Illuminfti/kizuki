import { runBackfill } from "@kizuki/core";
import { UsageError, parseArguments, requirePositional } from "../args";
import { loadConnector, resolveConnectorId, selectConnection } from "../connections";
import { withVault } from "../context";
import { indexEventsSince } from "../derived";
import { formatRunCounts } from "../output";
import type { CliIo, Command } from "./index";

export const backfillCommand: Command = {
  name: "backfill",
  usage: "backfill <connector> [--source PATH|KEY]",
  summary: "run a historical sweep for one selected connection",
  async run(io: CliIo, args: string[]): Promise<number> {
    const parsed = parseArguments(args, { options: ["--source"] });
    const [rawId] = requirePositional(parsed.positionals, 1);
    if (rawId === undefined) throw new UsageError(this.usage);
    const connectorId = resolveConnectorId(rawId);

    return withVault(io, async (ctx) => {
      const selected = selectConnection(
        ctx.db,
        ctx.store,
        connectorId,
        parsed.options.get("--source"),
      );
      const connector = await loadConnector(selected);
      // Same-process clock: a wall-clock step backwards is recovered by the
      // later rebuild verb. Index only rows accepted at or after this instant.
      const since = { accepted_at: new Date().toISOString(), event_id: "" };
      const result = await runBackfill(
        ctx.db,
        connector,
        selected.connection.connector_id,
        selected.connection.source_key,
      );
      indexEventsSince(ctx.db, since);
      io.out(formatRunCounts(result));
      for (const text of result.errors) io.err(`error: ${text}`);
      return result.errors.length > 0 ? 1 : 0;
    });
  },
};
