import { resolve } from "node:path";
import { getConnector } from "@kizuki/connectors";
import { UsageError, parseArguments, requirePositional } from "../args";
import {
  ConnectionError,
  enrollHostConnection,
  listHostConnections,
  loadConnector,
  refuseSecrets,
  resolveConnectorId,
} from "../connections";
import { withVault } from "../context";
import type { CliIo, Command } from "./index";

export const connectCommand: Command = {
  name: "connect",
  usage: "connect <connector> --source PATH",
  summary: "enroll a none-mode source as an opaque host-authored connection",
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
      const existing = listHostConnections(ctx.db, ctx.store, connectorId).find(
        (item) => item.state?.config.path === absolute,
      );
      if (existing !== undefined && existing.state !== null) {
        const connector = await loadConnector(existing);
        const health = await connector.health();
        if (health.state !== "ok") {
          io.err(
            `error: ${connectorId} health=${health.state}: ${health.detail ?? ""}`,
          );
          return 1;
        }
        io.out(
          `connected ${connectorId} source=${existing.connection.source_key} path=${absolute} health=ok`,
        );
        return 0;
      }

      const connector = getConnector(connectorId, { path: absolute });
      if (!connector.manifest().auth_modes.includes("none")) {
        throw new ConnectionError(
          `sign-in for ${connectorId} is not wired yet`,
        );
      }
      await connector.connect(refuseSecrets);
      const health = await connector.health();
      if (health.state !== "ok") {
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
      io.out(
        `connected ${connectorId} source=${connection.source_key} path=${absolute} health=ok`,
      );
      return 0;
    });
  },
};
