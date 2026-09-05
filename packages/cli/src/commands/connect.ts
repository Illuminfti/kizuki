import { resolve } from "node:path";
import {
  applyConnectionSensitivity,
  DeadlineError,
  getConnectorSensitivity,
  isSensitivity,
  LedgerError,
  policyFromManifest,
  SENSITIVITY_ORDER,
  stricter,
} from "@kizuki/core";
import type { Connection, Manifest, Sensitivity } from "@kizuki/core";
import type { Database } from "bun:sqlite";
import { getConnector } from "@kizuki/connectors";
import {
  assertSameImapIdentity,
  ImapSignInInputError,
} from "@kizuki/connector-imap";
import { UsageError, parseArguments, requirePositional } from "../args";
import {
  ConnectionError,
  blocksEnrollment,
  enrollSignedInConnection,
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
import { clean, jsonEnvelope } from "../output";
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

export function sanitizedSignInIo(io: CliIo) {
  const secrets: string[] = [];
  const displaySpellings = (secret: string): string[] =>
    [...new Set([secret, secret.normalize("NFC"), secret.normalize("NFD")])];
  const redact = (text: string): string => {
    let result = text;
    for (const secret of secrets.flatMap(displaySpellings).sort((a, b) => b.length - a.length)) {
      if (secret.length === 0) continue;
      const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      result = result.replace(new RegExp(escaped, "gi"), "[redacted]");
    }
    return result;
  };
  return {
    async prompt(question: string, opts?: { secret?: boolean }) {
      const answer = await io.prompt(question, opts);
      if (opts?.secret === true) secrets.push(answer);
      return answer;
    },
    notify: (text: string) => {
      const safe = clean(redact(text)).slice(0, 512);
      if (safe.length > 0) io.err(safe);
    },
    openUrl: async () => { throw new ConnectionError("IMAP sign-in does not open a browser"); },
  };
}

export function isSafeImapSignInError(error: unknown): boolean {
  return error instanceof UsageError ||
    error instanceof ConnectionError ||
    error instanceof DeadlineError ||
    error instanceof LedgerError ||
    error instanceof ImapSignInInputError;
}

export function safeImapSignInFailure(error: unknown): Error {
  if (isSafeImapSignInError(error)) {
    return error as Error;
  }
  return new ConnectionError(
    "IMAP sign-in failed. Check the server, username, app password, and selected folders.",
  );
}

export function imapSignInNotice(vaultPath: string): string {
  return `IMAP will receive read-only access to the mailbox you enter. Protected local connection state is stored under ${clean(vaultPath)}. Press Ctrl-C to cancel before any connection is changed.`;
}

export const connectCommand: Command = {
  name: "connect",
  usage: "connect [--list|status] [--json]\n       kizuki connect <connector> --source PATH [--sensitivity public|personal|private]\n       kizuki connect beeper --token-ref env:VAR|file:/absolute/path [--endpoint http://127.0.0.1:23373] [--sensitivity public|personal|private] [--json]\n       kizuki connect imap [--source KEY] [--sensitivity public|personal|private]",
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
    if (rawId === "imap" || rawId === "kizuki.imap") {
      if (parsed.options.has("--endpoint") || parsed.options.has("--token-ref") || !io.stdinIsTTY || !io.stderrIsTTY) {
        throw new UsageError("connect imap [--source KEY] [--sensitivity public|personal|private] (interactive terminal required)");
      }
      const requested = parseSensitivityFlag(parsed.options.get("--sensitivity"));
      const sourceKey = parsed.options.get("--source");
      const connectorId = "kizuki.imap";
      const connector = getConnector(connectorId, {});
      return withVault(io, async (ctx) => {
        const existing = listHostConnections(ctx.db, ctx.store, connectorId, { includeDisconnected: true });
        if (existing.some((item) => item.state === null)) {
          throw new ConnectionError("An existing IMAP connection has missing or unreadable state. Run kizuki doctor and restore its connection state before re-signing in.");
        }
        const selected = sourceKey === undefined
          ? existing.length === 1 ? existing[0] : undefined
          : existing.find((item) => item.connection.source_key === sourceKey);
        if (sourceKey !== undefined && selected === undefined) {
          throw new ConnectionError(`no connection for ${connectorId} source=${sourceKey}`);
        }
        if (sourceKey === undefined && existing.length > 1) {
          throw new ConnectionError("Several IMAP connections exist. Re-sign in with: kizuki connect imap --source KEY");
        }
        checkRequestedSensitivity(ctx.db, connector.manifest(), requested, selected?.connection);
        io.err(imapSignInNotice(ctx.vaultPath));
        let connection: Connection;
        try {
          connection = await enrollSignedInConnection(
            ctx.db,
            ctx.store,
            connector,
            sanitizedSignInIo(io),
            sourceKey,
            assertSameImapIdentity,
          );
        } catch (error) {
          // Authentication and transport implementations may include server
          // replies in their errors. Never relay those through the CLI while
          // an owner is entering a mailbox credential.
          throw safeImapSignInFailure(error);
        }
        applyConnectionSensitivity(ctx.db, connection, connector.manifest(), requested);
        if (json) io.out(jsonEnvelope("connect", "ok", { connector_id: connectorId, source_key: connection.source_key, state: "enrolled" }));
        else {
          io.out(`connected ${connectorId} source=${connection.source_key}`);
          io.out("Email stays local. Kizuki reads mail; it never sends, deletes, or marks it read.");
          io.out(`next: ${INVOCATION} backfill imap`);
        }
        return 0;
      });
    }
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
        const connector = await loadConnector(existing, ctx.store);
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
