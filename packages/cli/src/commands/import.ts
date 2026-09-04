import { resolve } from "node:path";
import { applyConnectionSensitivity, runToCompletion } from "@kizuki/core";
import { getConnector } from "@kizuki/connectors";
import { UsageError, parseArguments, requirePositional } from "../args";
import {
  ConnectionError,
  blocksEnrollment,
  enrollHostConnection,
  listHostConnections,
  loadConnector,
  refuseSecrets,
  resolveConnectorId,
} from "../connections";
import { withVault } from "../context";
import { indexEventsSince } from "../derived";
import { formatRunCounts } from "../output";
import type { CliIo, Command } from "./index";

export const importCommand: Command = {
  name: "import",
  usage: "import <connector> --source PATH",
  summary: "enroll a file source and backfill it in one step",
  async run(io: CliIo, args: string[]): Promise<number> {
    const parsed = parseArguments(args, { options: ["--source"] });
    const [rawId] = requirePositional(parsed.positionals, 1);
    const source = parsed.options.get("--source");
    if (rawId === undefined || source === undefined) {
      throw new UsageError(this.usage);
    }
    const connectorId = resolveConnectorId(rawId);
    const absolute = resolve(source);

    return withVault(io, async (ctx) => {
      let selected = listHostConnections(ctx.db, ctx.store, connectorId).find(
        (item) => item.state?.config.path === absolute,
      );
      if (selected === undefined || selected.state === null) {
        const connector = getConnector(connectorId, { path: absolute });
        if (!connector.manifest().auth_modes.includes("none")) {
          throw new ConnectionError(
            `sign-in for ${connectorId} is not wired yet`,
          );
        }
        await connector.connect(refuseSecrets);
        const health = await connector.health();
        if (blocksEnrollment(health.state)) {
          io.err(
            `error: ${connectorId} health=${health.state}: ${health.detail ?? ""}`,
          );
          return 1;
        }
        const connection = await enrollHostConnection(
          ctx.db,
          ctx.store,
          connectorId,
          {
            schema: "kizuki.cli.connection-state/v1",
            connector_id: connectorId,
            config: { path: absolute },
          },
        );
        applyConnectionSensitivity(ctx.db, connection, connector.manifest());
        selected = {
          connection,
          state: {
            schema: "kizuki.cli.connection-state/v1",
            connector_id: connectorId,
            config: { path: absolute },
          },
          problem: null,
        };
      }

      const connector = await loadConnector(selected);
      const since = { accepted_at: new Date().toISOString(), event_id: "" };
      const result = await runToCompletion(
        ctx.db,
        connector,
        selected.connection.connector_id,
        selected.connection.source_key,
        "backfill",
      );
      indexEventsSince(ctx.db, since);
      io.out(formatRunCounts(result));
      for (const text of result.errors) io.err(`error: ${text}`);
      return result.errors.length > 0 ? 1 : 0;
    });
  },
};
