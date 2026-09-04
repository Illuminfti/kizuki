import type { Database } from "bun:sqlite";
import { isAbsolute, resolve } from "node:path";
import type {
  Connector,
  Connection,
  HealthState,
  SecretResolver,
} from "@kizuki/core";
import { ConnectionStateStore, isPlainObject, listConnections } from "@kizuki/core";
import { REGISTRY, getConnector } from "@kizuki/connectors";
import { errorText } from "./output";

export const HOST_STATE_SCHEMA = "kizuki.cli.connection-state/v1" as const;

export interface HostConnectionState {
  schema: typeof HOST_STATE_SCHEMA;
  connector_id: string;
  config: { path: string };
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
      config: { path: state.config.path },
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
  for (const config of [{}, { path: "/var/empty" }] as const) {
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
    .filter((id) => connectorAuthModes(id)?.includes("none") === true);
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
): HostConnection[] {
  return listConnections(db)
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
    selected = matches.find((item) => item.state?.config.path === absolute);
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

export const refuseSecrets: SecretResolver = async (ref) => {
  throw new ConnectionError(`no secret configured for ${ref}`);
};

/** A usable source may be degraded; only closed states block enrollment. */
export function blocksEnrollment(state: HealthState): boolean {
  return state !== "ok" && state !== "degraded";
}

export async function loadConnector(
  selected: HostConnection,
): Promise<Connector> {
  if (selected.state === null) {
    throw new ConnectionError(
      `${selected.connection.connector_id} source=${selected.connection.source_key}: ${selected.problem ?? "state missing"}; reconnect it`,
    );
  }
  const connector = getConnector(
    selected.connection.connector_id,
    selected.state.config,
  );
  await connector.connect(refuseSecrets);
  return connector;
}
