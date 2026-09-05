import { consentHint } from "../source-consent";
import { runToCompletion } from "@kizuki/core";
import { UsageError, parseArguments, requirePositional } from "../args";
import { loadConnector, resolveConnectorId, selectConnection } from "../connections";
import { withVault } from "../context";
import { tryRefreshDerived } from "../derived";
import { formatRunCounts } from "../output";
import type { CliIo, Command } from "./index";

export const backfillCommand: Command = {
  name: "backfill",
  usage: "backfill <connector> [--source PATH|KEY]",
  summary: "drain a historical sweep until the selected connection is exhausted",
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
      const connector = await loadConnector(selected, ctx.store);
      const result = await runToCompletion(
        ctx.db,
        connector,
        selected.connection.connector_id,
        selected.connection.source_key,
        "backfill",
      );
      const derived = tryRefreshDerived(ctx.db, ctx.vaultPath);
      io.out(formatRunCounts(result));
      if (result.errors.includes("source_capture_denied")) io.err(consentHint(ctx.db, selected.connection.source_key));
      for (const text of result.errors) io.err(`error: ${text}`);
      for (const warning of derived.degraded) io.err(`degraded: ${warning}`);
      return result.errors.length > 0 ? 1 : 0;
    });
  },
};
