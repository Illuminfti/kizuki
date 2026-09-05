import type { Database } from "bun:sqlite";
import { isAbsolute, resolve } from "node:path";
import type {
  Connector,
  Connection,
  HealthState,
  SecretResolver,
  SignInIo,
} from "@kizuki/core";
import {
  ConnectionStateStore,
  createStatePersister,
  enrollConnection,
  isPlainObject,
  listConnections,
  sourceCaptureAdmission,
} from "@kizuki/core";
import { REGISTRY, getConnector } from "@kizuki/connectors";
import { TelegramConnector, type TelegramConnectorConfig, type TelegramDeps } from "@kizuki/connector-telegram";
import { errorText } from "./output";
import { tokenResolver, validTokenRef } from "./secrets";
import { consentHint } from "./source-consent";

export const HOST_STATE_SCHEMA = "kizuki.cli.connection-state/v1" as const;

export interface HostConnectionState {
  schema: typeof HOST_STATE_SCHEMA;
  connector_id: string;
  config:
    | { path: string; base_url?: never; token_secret_ref?: never }
    | { base_url: string; token_secret_ref: string; path?: never }
    | { secret_ref: string; path?: never; base_url?: never; token_secret_ref?: never }
    | { state_ref: string; path?: never; base_url?: never; token_secret_ref?: never; secret_ref?: never };
}

export class ConnectionError extends Error {
  override name = "ConnectionError";
}

const SOURCE_KEY = /^[0-9A-HJKMNPQRSTVWXYZ]{26}$/;

export function encodeHostState(state: HostConnectionState): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      schema: state.schema,
      connector_id: state.connector_id,
      config: state.config.path !== undefined
        ? { path: state.config.path }
        : state.config.base_url !== undefined
          ? { base_url: state.config.base_url, token_secret_ref: state.config.token_secret_ref }
          : "state_ref" in state.config ? { state_ref: state.config.state_ref } : { secret_ref: state.config.secret_ref },
    }),
  );
}

export function decodeHostState(
  bytes: Uint8Array,
  connectorId: string,
): HostConnectionState {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ConnectionError("connection state is not valid UTF-8");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new ConnectionError("connection state is not valid JSON");
  }
  if (!isPlainObject(parsed)) {
    throw new ConnectionError("connection state is not an object");
  }
  const keys = Object.keys(parsed).sort();
  if (keys.length !== 3 || keys[0] !== "config" || keys[1] !== "connector_id" || keys[2] !== "schema") {
    throw new ConnectionError("connection state has unexpected keys");
  }
  if (parsed["schema"] !== HOST_STATE_SCHEMA) {
    throw new ConnectionError("connection state schema is not recognized");
  }
  if (parsed["connector_id"] !== connectorId) {
    throw new ConnectionError("connection state connector_id does not match");
  }
  const config = parsed["config"];
  if (!isPlainObject(config)) {
    throw new ConnectionError("connection state config is not an object");
  }
  const configKeys = Object.keys(config);
  if (connectorId === "kizuki.beeper") {
    const endpoint = config["base_url"];
    const ref = config["token_secret_ref"];
    if (configKeys.length !== 2 || typeof endpoint !== "string" ||
        typeof ref !== "string" || !validTokenRef(ref)) {
      throw new ConnectionError("Beeper connection state requires an endpoint and a supported token reference");
    }
    // The connector validates the loopback URL before any secret resolution or request.
    getConnector(connectorId, { base_url: endpoint, token_secret_ref: ref });
    return { schema: HOST_STATE_SCHEMA, connector_id: connectorId,
      config: { base_url: endpoint, token_secret_ref: ref } };
  }
  if (connectorId === "kizuki.imap") {
    const ref = config["secret_ref"];
    if (configKeys.length !== 1 || typeof ref !== "string" || !/^file:connections\/[0-9A-HJKMNPQRSTVWXYZ]{26}\.state$/.test(ref)) throw new ConnectionError("IMAP connection state requires a core-minted state reference");
    return { schema: HOST_STATE_SCHEMA, connector_id: connectorId, config: { secret_ref: ref } };
  }
  if (configKeys.length !== 1 || configKeys[0] !== "path") {
    throw new ConnectionError("connection state config has unexpected keys");
  }
  const path = config["path"];
  if (typeof path !== "string" || path.length === 0 || !isAbsolute(path)) {
    throw new ConnectionError("connection state path must be absolute");
  }
  return {
    schema: HOST_STATE_SCHEMA,
    connector_id: connectorId,
    config: { path },
  };
}

function connectorAuthModes(id: string): readonly string[] | null {
  for (const config of [{}, { path: "/var/empty" }, { token_secret_ref: "env:BEEPER_TOKEN" }] as const) {
    try {
      return getConnector(id, config).manifest().auth_modes;
    } catch {
      // Try the next shape; a constructor that cannot even emit a
      // manifest is not a CLI enrollment path.
    }
  }
  return null;
}

export function listEnrollableConnectorIds(): string[] {
  return Object.keys(REGISTRY)
    .sort()
    .filter((id) => connectorAuthModes(id)?.includes("none") === true ||
      (id === "kizuki.beeper" && connectorAuthModes(id)?.includes("secret_ref") === true) ||
      (["kizuki.imap", "kizuki.telegram"].includes(id) && connectorAuthModes(id)?.includes("sign_in") === true));
}

function resolveRegisteredId(input: string): string | null {
  if (input in REGISTRY) return input;
  const prefixed = `kizuki.${input}`;
  if (prefixed in REGISTRY) return prefixed;
  return null;
}

export function resolveConnectorId(input: string): string {
  const registered = resolveRegisteredId(input);
  const enrollable = listEnrollableConnectorIds();
  if (registered !== null && enrollable.includes(registered)) return registered;
  if (registered !== null) {
    throw new ConnectionError(
      `sign-in for ${registered} is not enrollable through this CLI`,
    );
  }
  throw new ConnectionError(
    `unknown connector: ${input}; known: ${enrollable.join(", ")}`,
  );
}

export async function enrollHostConnection(
  db: Database,
  store: ConnectionStateStore,
  connectorId: string,
  state: HostConnectionState,
): Promise<Connection> {
  if (state.connector_id !== connectorId) {
    throw new ConnectionError("connection state connector_id does not match");
  }
  decodeHostState(encodeHostState(state), connectorId);
  store.recover(db);
  const enrollment = store.begin();
  try {
    await enrollment.writer.write(encodeHostState(state));
    return store.save(db, connectorId, enrollment.pending);
  } catch (error) {
    store.discard(enrollment.pending);
    throw error;
  }
}

/**
 * Enroll a connector that mints its own opaque state during an interactive
 * sign-in. The ledger owns both the durable filename and replacement
 * transaction: CLI code never parses, copies, or persists this state.
 */
export async function enrollSignedInConnection(
  db: Database,
  store: ConnectionStateStore,
  connector: Connector,
  io: SignInIo,
  sourceKey?: string,
  verifyReplacement?: (previous: Uint8Array, candidate: Uint8Array) => void,
): Promise<Connection> {
  const manifest = connector.manifest();
  if (!manifest.auth_modes.includes("sign_in") || connector.signIn === undefined) {
    throw new ConnectionError(`${manifest.connector_id} does not support interactive sign-in`);
  }
  store.recover(db);
  const existing = listConnections(db, { includeDisconnected: true }).filter(
    (connection) => connection.connector_id === manifest.connector_id,
  );
  const previous = sourceKey === undefined
    ? existing.length === 1 ? existing[0] : undefined
    : existing.find((connection) => connection.source_key === sourceKey);
  if (sourceKey !== undefined && previous === undefined) {
    throw new ConnectionError(`no connection for ${manifest.connector_id} source=${sourceKey}`);
  }
  if (sourceKey === undefined && existing.length > 1) {
    throw new ConnectionError(`several connections for ${manifest.connector_id}; select a source before re-signing in`);
  }
  if (previous !== undefined) {
    return store.replace(db, previous, connector, io, verifyReplacement);
  }
  return enrollConnection(db, store, connector, io);
}

export interface HostConnection {
  connection: Connection;
  state: HostConnectionState | null;
  problem: string | null;
}

function inspectConnection(
  store: ConnectionStateStore,
  connection: Connection,
): HostConnection {
  try {
    if (["kizuki.imap", "kizuki.telegram"].includes(connection.connector_id)) {
      const ref = connection.secret_refs[0];
      if (connection.secret_refs.length !== 1 || ref === undefined) throw new ConnectionError(`${connection.connector_id} connection state is missing`);
      if (store.read(connection) === null) throw new ConnectionError(`${connection.connector_id} connection state is missing`);
      // Signed-in state is connector-owned opaque bytes. This small in-memory
      // descriptor exposes only the core-minted reference needed to build the
      // connector; it is never encoded or written as host state.
      return {
        connection,
        state: {
          schema: HOST_STATE_SCHEMA,
          connector_id: connection.connector_id,
          config: connection.connector_id === "kizuki.telegram" ? { state_ref: ref } : { secret_ref: ref },
        },
        problem: null,
      };
    }
    const bytes = store.read(connection);
    if (bytes === null) {
      return {
        connection,
        state: null,
        problem: "connection state is missing",
      };
    }
    return {
      connection,
      state: decodeHostState(bytes, connection.connector_id),
      problem: null,
    };
  } catch (error) {
    return { connection, state: null, problem: errorText(error) };
  }
}

export function listHostConnections(
  db: Database,
  store: ConnectionStateStore,
  connectorId?: string,
  opts: { includeDisconnected?: boolean } = {},
): HostConnection[] {
  return listConnections(db, opts)
    .filter(
      (connection) =>
        connectorId === undefined || connection.connector_id === connectorId,
    )
    .map((connection) => inspectConnection(store, connection));
}

export function selectConnection(
  db: Database,
  store: ConnectionStateStore,
  connectorId: string,
  selector: string | undefined,
): HostConnection {
  const matches = listHostConnections(db, store, connectorId);
  let selected: HostConnection | undefined;

  if (selector === undefined) {
    if (matches.length === 0) {
      throw new ConnectionError(
        `no connection for ${connectorId}; run: kizuki connect ${connectorId} --source PATH`,
      );
    }
    if (matches.length > 1) {
      throw new ConnectionError(
        `several connections for ${connectorId}; pass --source <PATH|KEY>`,
      );
    }
    selected = matches[0];
  } else if (SOURCE_KEY.test(selector)) {
    selected = matches.find(
      (item) => item.connection.source_key === selector,
    );
    if (selected === undefined) {
      throw new ConnectionError(
        `no connection for ${connectorId} source=${selector}; run: kizuki connect ${connectorId} --source PATH`,
      );
    }
  } else {
    const absolute = resolve(selector);
    selected = matches.find((item) => item.state?.config.path === absolute ||
      item.state?.config.base_url === selector.replace(/\/$/, ""));
    if (selected === undefined) {
      throw new ConnectionError(
        `no connection for ${connectorId}; run: kizuki connect ${connectorId} --source PATH`,
      );
    }
  }

  if (selected === undefined) {
    throw new ConnectionError(
      `no connection for ${connectorId}; run: kizuki connect ${connectorId} --source PATH`,
    );
  }
  if (selected.state === null) {
    throw new ConnectionError(
      `${connectorId} source=${selected.connection.source_key}: ${selected.problem ?? "state missing"}; reconnect it`,
    );
  }
  return selected;
}

export const refuseSecrets: SecretResolver = async () => {
  throw new ConnectionError("no secret configured for this connection");
};

/** A usable source may be degraded; only closed states block enrollment. */
export function blocksEnrollment(state: HealthState): boolean {
  return state !== "ok" && state !== "degraded";
}

export async function loadConnector(
  selected: HostConnection,
  store: ConnectionStateStore,
  db: Database,
  env: Record<string, string | undefined> = process.env,
  factory: (id: string, config?: unknown, telegramDeps?: Partial<TelegramDeps>) => Connector = (id, config, deps) => id === "kizuki.telegram" ? new TelegramConnector(config as TelegramConnectorConfig, deps) : getConnector(id, config),
): Promise<Connector> {
  try { sourceCaptureAdmission(db, selected.connection.connector_id, selected.connection.source_key); }
  catch (error) {
    if (error instanceof Error && error.message === "source_capture_denied") {
      throw new ConnectionError(`source_capture_denied; ${consentHint(db, selected.connection.source_key)}`);
    }
    throw error;
  }
  if (selected.state === null) {
    throw new ConnectionError(
      `${selected.connection.connector_id} source=${selected.connection.source_key}: ${selected.problem ?? "state missing"}; reconnect it`,
    );
  }
  const telegram = selected.connection.connector_id === "kizuki.telegram";
  const connector = factory(
    selected.connection.connector_id,
    selected.state.config,
    telegram ? { persist: createStatePersister(db, store, selected.connection).persist } : undefined,
  );
  const config = selected.state.config;
  const ref = "state_ref" in config ? config.state_ref : "token_secret_ref" in config
    ? config.token_secret_ref
    : "secret_ref" in config
      ? config.secret_ref
      : undefined;
  if (telegram || selected.connection.connector_id === "kizuki.imap") {
    const state = store.read(selected.connection);
    if (state === null) throw new ConnectionError(`${selected.connection.connector_id} connection state is missing`);
    try {
      await connector.connect(async (wanted) => {
        if (wanted !== ref) throw new ConnectionError("unexpected connection state reference");
        return new TextDecoder().decode(state);
      });
    } catch (error) {
      await closeHostConnector(connector).catch(() => {});
      throw error;
    }
  } else {
    await connector.connect(ref === undefined ? refuseSecrets : tokenResolver(ref, env));
  }
  return connector;
}

/** Concrete Telegram transport cleanup never revokes a provider session. */
export async function closeHostConnector(connector: Connector): Promise<void> {
  if (connector instanceof TelegramConnector) await connector.close();
}
