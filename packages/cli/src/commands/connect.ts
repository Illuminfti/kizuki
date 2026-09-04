import { resolve } from "node:path";
import {
  applyConnectionSensitivity,
  getConnectorSensitivity,
  isSensitivity,
  policyFromManifest,
  SENSITIVITY_ORDER,
  stricter,
} from "@kizuki/core";
import type { Connection, Manifest, Sensitivity } from "@kizuki/core";
import type { Database } from "bun:sqlite";
import { getConnector } from "@kizuki/connectors";
import { UsageError, parseArguments, requirePositional } from "../args";
import {
  ConnectionError,
  blocksEnrollment,
  enrollHostConnection,
  encodeHostState,
  listHostConnections,
  loadConnector,
  refuseSecrets,
  resolveConnectorId,
} from "../connections";
import type { HostConnectionState } from "../connections";
import { printConnectionStatus, printConnectorCatalog } from "../connect-catalog";
import { tokenResolver, validTokenRef } from "../secrets";
import { jsonEnvelope } from "../output";
import { INVOCATION } from "../runtime";
import { withVault } from "../context";
import type { CliIo, Command } from "./index";

function parseSensitivityFlag(raw: string | undefined): Sensitivity | undefined {
  if (raw === undefined) return undefined;
  if (!isSensitivity(raw)) {
    throw new UsageError("connect <connector> --source PATH [--sensitivity public|personal|private]");
  }
  return raw;
}

function checkRequestedSensitivity(db: Database, manifest: Manifest, requested: Sensitivity | undefined, connection?: Connection): void {
  if (requested === undefined) return;
  const saved = connection === undefined ? null : getConnectorSensitivity(db, connection.connector_id, connection.source_key);
  const floor = stricter(policyFromManifest(manifest).sensitivity_floor, saved?.floor ?? "public");
  if (SENSITIVITY_ORDER[requested] < SENSITIVITY_ORDER[floor]) {
    throw new UsageError(`--sensitivity cannot be below this connection's ${floor} floor`);
  }
}

export const connectCommand: Command = {
  name: "connect",
  usage: "connect [--list|status] [--json]\n       kizuki connect <connector> --source PATH [--sensitivity public|personal|private]\n       kizuki connect beeper --token-ref env:VAR|file:/absolute/path [--endpoint http://127.0.0.1:23373] [--sensitivity public|personal|private] [--json]",
  summary: "choose a source, connect Beeper or local files, and check sync status",
  async run(io: CliIo, args: string[]): Promise<number> {
    const parsed = parseArguments(args, {
      options: ["--source", "--sensitivity", "--endpoint", "--token-ref"],
      flags: ["--list", "--json"],
    });
    const json = parsed.flags.has("--json");
    if (parsed.positionals.length === 0 && parsed.options.size === 0) {
      return printConnectorCatalog(io, json);
    }
    if (parsed.positionals[0] === "status" && parsed.positionals.length === 1 && parsed.options.size === 0 && !parsed.flags.has("--list")) {
      return printConnectionStatus(io, json);
    }
    if (parsed.flags.has("--list")) throw new UsageError("connect --list [--json]");
    const [rawId] = requirePositional(parsed.positionals, 1);
    if (rawId === "beeper" || rawId === "kizuki.beeper") {
      const ref = parsed.options.get("--token-ref");
      if (ref === undefined || !validTokenRef(ref) || parsed.options.has("--source")) {
        throw new UsageError("connect beeper --token-ref env:VAR|file:/absolute/path [--endpoint http://127.0.0.1:23373]");
      }
      const rawEndpoint = parsed.options.get("--endpoint") ?? "http://127.0.0.1:23373";
      const requested = parseSensitivityFlag(parsed.options.get("--sensitivity"));
      const connectorId = "kizuki.beeper";
      const connector = getConnector(connectorId, { base_url: rawEndpoint, token_secret_ref: ref });
      const endpoint = new URL(rawEndpoint).origin;
      const state: HostConnectionState = { schema: "kizuki.cli.connection-state/v1", connector_id: connectorId,
        config: { base_url: endpoint, token_secret_ref: ref } };
      return withVault(io, async (ctx) => {
        const hosts = listHostConnections(ctx.db, ctx.store, connectorId);
        if (hosts.some((item) => item.state === null)) {
          throw new ConnectionError("An existing Beeper connection has missing or unreadable state. Run kizuki doctor and restore its connection state before enrolling another source.");
        }
        const existing = hosts.find((item) => item.state?.config.base_url === endpoint);
        checkRequestedSensitivity(ctx.db, connector.manifest(), requested, existing?.connection);
        await connector.connect(tokenResolver(ref, io.env));
        const health = await connector.health();
        if (blocksEnrollment(health.state)) {
          io.err(`Beeper is ${health.state}. Open Beeper Desktop, enable its Desktop API, and check your approved connection token.`);
          return 1;
        }
        let connection;
        if (existing === undefined) {
          connection = await enrollHostConnection(ctx.db, ctx.store, connectorId, state);
        } else if (existing.state?.config.token_secret_ref !== ref) {
          connection = await ctx.store.rewrite(ctx.db, existing.connection,
            (writer) => writer.write(encodeHostState(state)));
        } else {
          connection = existing.connection;
        }
        applyConnectionSensitivity(ctx.db, connection, connector.manifest(), requested);
        if (json) io.out(jsonEnvelope("connect", "ok", { connector_id: connectorId, source_key: connection.source_key, state: "enrolled" }));
        else {
          io.out(`connected ${connectorId} source=${connection.source_key} health=${health.state}`);
          io.out("Messages stay local. Kizuki reads messages; it never sends or marks them read.");
          io.out(`next: ${INVOCATION} backfill beeper`);
          io.out(`then: ${INVOCATION} context --purpose session --query "your topic"`);
        }
        return 0;
      });
    }
    if (parsed.options.has("--endpoint") || parsed.options.has("--token-ref") || json) {
      throw new UsageError(this.usage);
    }
    const source = parsed.options.get("--source");
    if (rawId === undefined || source === undefined) {
      throw new UsageError(this.usage);
    }
    const connectorId = resolveConnectorId(rawId);
    const absolute = resolve(source);
    const requested = parseSensitivityFlag(parsed.options.get("--sensitivity"));

    return withVault(io, async (ctx) => {
      const hosts = listHostConnections(ctx.db, ctx.store, connectorId);
      if (hosts.some((item) => item.state === null)) {
        throw new ConnectionError("An existing connection has missing or unreadable state. Run kizuki doctor and restore its connection state before enrolling another source.");
      }
      const existing = hosts.find(
        (item) => item.state?.config.path === absolute,
      );
      if (existing !== undefined && existing.state !== null) {
        const connector = await loadConnector(existing);
        checkRequestedSensitivity(ctx.db, connector.manifest(), requested, existing.connection);
        const health = await connector.health();
        if (blocksEnrollment(health.state)) {
          io.err(
            `error: ${connectorId} health=${health.state}: ${health.detail ?? ""}`,
          );
          return 1;
        }
        applyConnectionSensitivity(
          ctx.db,
          existing.connection,
          connector.manifest(),
          requested,
        );
        io.out(
          `connected ${connectorId} source=${existing.connection.source_key} path=${absolute} health=${health.state}`,
        );
        return 0;
      }

      const connector = getConnector(connectorId, { path: absolute });
      checkRequestedSensitivity(ctx.db, connector.manifest(), requested);
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
      applyConnectionSensitivity(
        ctx.db,
        connection,
        connector.manifest(),
        requested,
      );
      io.out(
        `connected ${connectorId} source=${connection.source_key} path=${absolute} health=${health.state}`,
      );
      return 0;
    });
  },
};
