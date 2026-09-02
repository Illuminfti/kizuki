import { runSync } from "@kizuki/core";
import { UsageError, parseArguments } from "../args";
import {
  listHostConnections,
  loadConnector,
  resolveConnectorId,
  selectConnection,
} from "../connections";
import { withVault } from "../context";
import { indexEventsSince } from "../derived";
import { formatRunCounts } from "../output";
import type { CliIo, Command } from "./index";

export const syncCommand: Command = {
  name: "sync",
  usage: "sync [connector] [--source PATH|KEY]",
  summary: "run an incremental sweep for one, some, or every active connection",
  async run(io: CliIo, args: string[]): Promise<number> {
    const parsed = parseArguments(args, { options: ["--source"] });
    if (parsed.positionals.length > 1) throw new UsageError(this.usage);
    const rawId = parsed.positionals[0];
    const source = parsed.options.get("--source");

    return withVault(io, async (ctx) => {
      const connectorId =
        rawId === undefined ? undefined : resolveConnectorId(rawId);
      const targets =
        connectorId !== undefined && source !== undefined
          ? [selectConnection(ctx.db, ctx.store, connectorId, source)]
          : listHostConnections(ctx.db, ctx.store, connectorId);

      let failed = false;
      for (const selected of targets) {
        if (selected.state === null) {
          io.err(
            `${selected.connection.connector_id} source=${selected.connection.source_key} skipped: ${selected.problem ?? "state missing"}`,
          );
          failed = true;
          continue;
        }
        const connector = await loadConnector(selected);
        const since = { accepted_at: new Date().toISOString(), event_id: "" };
        const result = await runSync(
          ctx.db,
          connector,
          selected.connection.connector_id,
          selected.connection.source_key,
        );
        indexEventsSince(ctx.db, since);
        io.out(
          `${selected.connection.connector_id} source=${selected.connection.source_key} ${formatRunCounts(result)}`,
        );
        for (const text of result.errors) {
          io.err(`error: ${text}`);
          failed = true;
        }
      }
      return failed ? 1 : 0;
    });
  },
};
