import { runToCompletion } from "@kizuki/core";
import { UsageError, parseArguments } from "../args";
import {
  ConnectionError,
  listHostConnections,
  loadConnector,
  resolveConnectorId,
  selectConnection,
} from "../connections";
import { withVault } from "../context";
import { tryRefreshDerived } from "../derived";
import { formatRunCounts } from "../output";
import type { CliIo, Command } from "./index";

export const syncCommand: Command = {
  name: "sync",
  usage: "sync [connector] [--source PATH|KEY]",
  summary: "refresh selected sources until each connector reports exhaustion",
  async run(io: CliIo, args: string[]): Promise<number> {
    const parsed = parseArguments(args, { options: ["--source"] });
    if (parsed.positionals.length > 1) throw new UsageError(this.usage);
    const rawId = parsed.positionals[0];
    const source = parsed.options.get("--source");
    if (source !== undefined && rawId === undefined) {
      throw new UsageError("--source requires an explicit connector");
    }

    return withVault(io, async (ctx) => {
      const connectorId =
        rawId === undefined ? undefined : resolveConnectorId(rawId);
      const targets =
        connectorId !== undefined && source !== undefined
          ? [selectConnection(ctx.db, ctx.store, connectorId, source)]
          : listHostConnections(ctx.db, ctx.store, connectorId);

      if (targets.length === 0) {
        throw new ConnectionError(
          connectorId === undefined
            ? "no_connections: no active connections; run: kizuki connect <connector> --source PATH"
            : `no_connections: no active connections for ${connectorId}; run: kizuki connect ${connectorId} --source PATH`,
        );
      }

      let failed = false;
      for (const selected of targets) {
        try {
          if (selected.state === null) {
            io.err(
              `${selected.connection.connector_id} source=${selected.connection.source_key} skipped: ${selected.problem ?? "state missing"}`,
            );
            failed = true;
            continue;
          }
          const connector = await loadConnector(selected);
          const result = await runToCompletion(
            ctx.db,
            connector,
            selected.connection.connector_id,
            selected.connection.source_key,
            "sync",
          );
          const derived = tryRefreshDerived(ctx.db, ctx.vaultPath);
          io.out(
            `${selected.connection.connector_id} source=${selected.connection.source_key} ${formatRunCounts(result)}`,
          );
          for (const text of result.errors) {
            io.err(`error: ${text}`);
            failed = true;
          }
          for (const warning of derived.degraded) io.err(`degraded: ${warning}`);
        } catch (error) {
          failed = true;
          io.err(
            `error: ${selected.connection.connector_id} source=${selected.connection.source_key}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      return failed ? 1 : 0;
    });
  },
};
