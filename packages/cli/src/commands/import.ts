import { resolve } from "node:path";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { applyConnectionSensitivity, runToCompletion, ESTATE_IMPORT_LIMITS, planEstateImport } from "@kizuki/core";
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
import { tryRefreshDerived } from "../derived";
import { formatRunCounts } from "../output";
import type { CliIo, Command } from "./index";

function readEstateInput(path: string, limit: number): string {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.size > limit) throw new Error();
    const buffer = Buffer.alloc(limit + 1);
    let used = 0;
    while (used < buffer.length) {
      const count = readSync(fd, buffer, used, buffer.length - used, null);
      if (count === 0) break;
      used += count;
    }
    const after = fstatSync(fd);
    if (used > limit || used !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error();
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, used));
  } catch {
    throw new UsageError("estate_input_unreadable_or_unsafe");
  } finally { if (fd !== undefined) closeSync(fd); }
}

export const importCommand: Command = {
  name: "import",
  usage: "import <connector> --source PATH | import estate-slice --source FILE --authorization FILE --dry-run [--json]",
  summary: "import a file source, or dry-run an estate slice without writing records",
  async run(io: CliIo, args: string[]): Promise<number> {
    const parsed = parseArguments(args, { options: ["--source", "--authorization"], flags: ["--dry-run", "--json"] });
    const [rawId] = requirePositional(parsed.positionals, 1);
    const source = parsed.options.get("--source");
    if (rawId === undefined || source === undefined) {
      throw new UsageError(this.usage);
    }
    if (rawId === "estate-slice") {
      const authorization = parsed.options.get("--authorization");
      if (authorization === undefined || !parsed.flags.has("--dry-run")) {
        throw new UsageError("estate-slice requires --source FILE --authorization FILE --dry-run [--json]; apply is not implemented");
      }
      const report = planEstateImport(
        readEstateInput(source, ESTATE_IMPORT_LIMITS.sourceBytes),
        readEstateInput(authorization, ESTATE_IMPORT_LIMITS.authorizationBytes),
      );
      if (parsed.flags.has("--json")) io.out(JSON.stringify(report));
      else {
        io.out(`estate-slice dry-run: ${report.status}; records=${report.records}; plan=${report.plan_sha256}`);
        for (const issue of report.issues) io.out(`${issue.disposition}: ${issue.code}; source=${issue.source ?? "all"}; record=${issue.record ?? "all"}`);
        for (const limitation of report.limitations) io.out(`limit: ${limitation}`);
      }
      return report.status === "compatible" ? 0 : 1;
    }
    if (parsed.options.has("--authorization") || parsed.flags.size > 0) {
      throw new UsageError("--authorization, --dry-run and --json are only supported for estate-slice");
    }
    const connectorId = resolveConnectorId(rawId);
    const absolute = resolve(source);

    return withVault(io, async (ctx) => {
      const hosts = listHostConnections(ctx.db, ctx.store, connectorId);
      if (hosts.some((item) => item.state === null)) {
        throw new ConnectionError("An existing connection has missing or unreadable state. Run kizuki doctor and restore its connection state before importing another source.");
      }
      let selected = hosts.find(
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
      for (const text of result.errors) io.err(`error: ${text}`);
      for (const warning of derived.degraded) io.err(`degraded: ${warning}`);
      return result.errors.length > 0 ? 1 : 0;
    });
  },
};
