import { XApiConnector, createXApiConnector, inspectXApiState, type XApiConfig, createMarkdownFolderConnector, MARKDOWN_FOLDER_CONNECTOR_ID, MAX_FILES, LEGACY_EVENTS_AUTH_MODES, LEGACY_EVENTS_CONNECTOR_ID, LEGACY_WIKI_AUTH_MODES, LEGACY_WIKI_CONNECTOR_ID, REGISTRY, getConnector, type MarkdownFolderConfig, type MarkdownFolderDeps } from "@kizuki/connectors";
import { xApiClient, xApiRequiredFields, xApiStateConfig } from "./x-api";
import type { ConnectionStateReader } from "@kizuki/core";
import { GoogleCalendarConnector, createGoogleCalendarConnector, inspectGoogleCalendarState, type GoogleCalendarConnectorConfig } from "@kizuki/connector-google-calendar";
import { googleCalendarClient, googleCalendarRequiredFields, googleCalendarStateConfig } from "./google-calendar";
import { GmailConnector, createGmailConnector, inspectGmailState, type GmailConnectorConfig } from "@kizuki/connector-gmail";
import { gmailClient, gmailRequiredFields, gmailStateConfig } from "./gmail";
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
  EVENT_LIMITS,
  createStatePersister,
  enrollConnection,
  isPlainObject,
  listConnections,
  sourceCaptureAdmission,
  inspectSourceGrant,
} from "@kizuki/core";
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
const MARKDOWN_SHA256 = /^[0-9a-f]{64}$/;

type HostConnectorFactoryDeps = Partial<TelegramDeps> & Partial<MarkdownFolderDeps>;

/**
 * Latest live Markdown identities for one enrolled source. Identifier and
 * metadata only; never event text. Fail closed on an incompatible inventory.
 */
export function markdownCommittedIdentities(
  db: Database,
  sourceKey: string,
): Array<[string, { sha256: string; size: number }]> {
  if (!SOURCE_KEY.test(sourceKey)) {
    throw new ConnectionError("markdown committed identities require a source key");
  }
  let rows: Array<{ relpath: string; sha256: unknown; size: unknown }>;
  try {
    rows = db
      .query<{ relpath: string; sha256: unknown; size: unknown }, [string, string, number]>(
        `SELECT relpath, sha256, size FROM (
           SELECT e.source_record_id AS relpath,
                  json_extract(e.metadata, '$.sha256') AS sha256,
                  json_extract(e.metadata, '$.size') AS size,
                  e.deleted,
                  ROW_NUMBER() OVER (
                    PARTITION BY e.source_record_id
                    ORDER BY e.accepted_at DESC, e.event_id DESC
                  ) AS rn
             FROM events e
             JOIN source_event_bindings b ON b.event_id = e.event_id
            WHERE b.source_key = ?
              AND e.connector_id = ?
         )
         WHERE rn = 1 AND deleted = 0
         LIMIT ?`,
      )
      .all(sourceKey, MARKDOWN_FOLDER_CONNECTOR_ID, MAX_FILES + 1);
  } catch (error) {
    throw new ConnectionError(
      `markdown committed identities are unreadable: ${errorText(error)}`,
    );
  }
  if (rows.length > MAX_FILES) {
    throw new ConnectionError("markdown committed identities exceed the scan bound");
  }
  const files: Array<[string, { sha256: string; size: number }]> = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const relpath = row.relpath;
    const sha256 = row.sha256;
    const size = row.size;
    if (
      typeof relpath !== "string" ||
      relpath.length === 0 ||
      new TextEncoder().encode(relpath).byteLength > EVENT_LIMITS.sourceRecordIdBytes ||
      seen.has(relpath) ||
      typeof sha256 !== "string" ||
      !MARKDOWN_SHA256.test(sha256) ||
      typeof size !== "number" ||
      !Number.isInteger(size) ||
      size < 0 ||
      size > EVENT_LIMITS.textBytes
    ) {
      throw new ConnectionError(
        "markdown committed identities are incompatible with scan policy",
      );
    }
    seen.add(relpath);
    files.push([relpath, { sha256, size }]);
  }
  return files;
}

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

export function connectorAuthModes(id: string): readonly string[] | null {
  // These importers need a real mapping to construct; their shared manifest
  // auth metadata is enough to discover the CLI path, never to admit capture.
  if (id === LEGACY_EVENTS_CONNECTOR_ID) return LEGACY_EVENTS_AUTH_MODES;
  if (id === LEGACY_WIKI_CONNECTOR_ID) return LEGACY_WIKI_AUTH_MODES;
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

/** Only these host codecs are path-only. Auth-none alone is not sufficient. */
const PORTABLE_PATH_IDS = Object.freeze([
  "kizuki.markdown-folder", "kizuki.import-chatgpt", "kizuki.import-claude",
  "kizuki.import-whatsapp", "kizuki.import-pocket", "kizuki.import-omnivore",
  "kizuki.import-x-archive", "kizuki.screenpipe",
]);
export function portableLocalAdapter(): import("@kizuki/core").PortableLocalAdapter {
  for (const id of PORTABLE_PATH_IDS) {
    const manifest = getConnector(id, { path: "/var/empty" }).manifest();
    if (manifest.auth_modes.length !== 1 || manifest.auth_modes[0] !== "none" || manifest.required_secrets.length !== 0) {
      throw new ConnectionError("portable local connector contract changed");
    }
  }
  return Object.freeze({
    connector_ids: PORTABLE_PATH_IDS,
    decode(id: string, bytes: Uint8Array) {
      const state = decodeHostState(bytes, id);
      if (state.config.path === undefined) throw new ConnectionError("portable connection requires a local path");
      return Object.freeze({ path: state.config.path });
    },
    encode(id: string, config: { readonly path: string }) {
      return encodeHostState({ schema: HOST_STATE_SCHEMA, connector_id: id, config });
    },
  });
}

export function listEnrollableConnectorIds(): string[] {
  return Object.keys(REGISTRY)
    .sort()
    .filter((id) => connectorAuthModes(id)?.includes("none") === true ||
      (id === "kizuki.beeper" && connectorAuthModes(id)?.includes("secret_ref") === true) ||
      (["kizuki.imap", "kizuki.telegram", "kizuki.gmail", "kizuki.google-calendar", "kizuki.x"].includes(id) && connectorAuthModes(id)?.includes("sign_in") === true));
}

function resolveRegisteredId(input: string): string | null {
  if (input === "x-api") return "kizuki.x";
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
  const enrollment = store.beginWithRecovery(db);
  try {
    await enrollment.writer.write(encodeHostState(state));
    return store.save(db, connectorId, enrollment.pending);
  } catch (error) {
    store.discard(enrollment.pending);
    throw error;
  }
}

export class DuplicateSourceError extends ConnectionError {
  constructor() { super("source_already_enrolled; select its existing --source KEY to reauthorize; source consent is unchanged"); }
}

function verifyAccountEnrollment(connectorId: string): Parameters<typeof enrollConnection>[4] {
  const identity = connectorId === "kizuki.gmail"
    ? (bytes: Uint8Array) => JSON.stringify([inspectGmailState(bytes).account_id])
    : connectorId === "kizuki.google-calendar"
      ? (bytes: Uint8Array) => { const state = inspectGoogleCalendarState(bytes); return JSON.stringify([state.account_id, state.calendar_id]); }
      : connectorId === "kizuki.x"
        ? (bytes: Uint8Array) => { const state = inspectXApiState(bytes); return JSON.stringify([state.account_id, state.app_digest, state.selection]); }
        : undefined;
  if (identity === undefined) return undefined;
  return (candidate, existing) => {
    const selected = identity(candidate);
    if (existing.some(item => identity(item.state) === selected)) throw new DuplicateSourceError();
  };
}

/** Core owns state publication; provider inspectors supply only identity policy. */
export async function enrollSignedInConnection(
  db: Database,
  store: ConnectionStateStore,
  connector: Connector,
  io: SignInIo,
  sourceKey?: string,
  verifyReplacement?: (previous: Uint8Array, candidate: Uint8Array) => void,
  newSource = false,
): Promise<Connection> {
  if (newSource && sourceKey !== undefined) throw new ConnectionError("--new-source and --source are mutually exclusive");
  const manifest = connector.manifest();
  if (!manifest.auth_modes.includes("sign_in") || connector.signIn === undefined) {
    throw new ConnectionError(`${manifest.connector_id} does not support interactive sign-in`);
  }
  const existing = listConnections(db, { includeDisconnected: true }).filter(
    (connection) => connection.connector_id === manifest.connector_id,
  );
  const previous = newSource ? undefined : sourceKey === undefined
    ? existing.length === 1 ? existing[0] : undefined
    : existing.find((connection) => connection.source_key === sourceKey);
  if (sourceKey !== undefined && previous === undefined) {
    throw new ConnectionError(`no connection for ${manifest.connector_id} source=${sourceKey}`);
  }
  if (!newSource && sourceKey === undefined && existing.length > 1) {
    throw new ConnectionError(`several connections for ${manifest.connector_id}; select a source before re-signing in`);
  }
  if (previous !== undefined) {
    return store.replace(db, previous, connector, io, verifyReplacement);
  }
  return enrollConnection(db, store, connector, io, verifyAccountEnrollment(manifest.connector_id));
}

export interface HostConnection {
  connection: Connection;
  state: HostConnectionState | null;
  problem: string | null;
}

function inspectConnection(
  store: ConnectionStateReader,
  connection: Connection,
): HostConnection {
  try {
    if (["kizuki.imap", "kizuki.telegram", "kizuki.gmail", "kizuki.google-calendar", "kizuki.x"].includes(connection.connector_id)) {
      const ref = connection.secret_refs[0];
      if (connection.secret_refs.length !== 1 || ref === undefined) throw new ConnectionError(`${connection.connector_id} connection state is missing`);
      // Browser OAuth capture selection is metadata-only. loadConnector admits the
      // source before reading credentials; explicit reauthorization reads its
      // selected prior state in its enrollment command under owner sign-in authority.
      if (!["kizuki.gmail", "kizuki.google-calendar", "kizuki.x"].includes(connection.connector_id) && store.read(connection) === null) throw new ConnectionError(`${connection.connector_id} connection state is missing`);
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
  store: ConnectionStateReader,
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
  store: ConnectionStateReader,
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

function inspectionSafePersister(db: Database, store: ConnectionStateReader, connection: Connection): ReturnType<typeof createStatePersister>["persist"] {
  if (store instanceof ConnectionStateStore) return createStatePersister(db, store, connection).persist;
  return async () => { throw new ConnectionError("connector state mutation requires an explicit write context"); };
}

export async function loadConnector(
  selected: HostConnection,
  store: ConnectionStateReader,
  db: Database,
  env: Record<string, string | undefined> = process.env,
  factory: (id: string, config?: unknown, deps?: HostConnectorFactoryDeps) => Connector = (id, config, deps) => id === "kizuki.telegram" ? new TelegramConnector(config as TelegramConnectorConfig, deps) : id === "kizuki.gmail" ? createGmailConnector(config as GmailConnectorConfig, deps?.persist ? {persist:deps.persist} : {}) : id === "kizuki.google-calendar" ? createGoogleCalendarConnector(config as GoogleCalendarConnectorConfig, deps?.persist ? {persist:deps.persist} : {}) : id === "kizuki.x" ? createXApiConnector(config as XApiConfig, deps?.persist ? {persist:deps.persist} : {}) : id === "kizuki.markdown-folder" ? createMarkdownFolderConnector(config as MarkdownFolderConfig, deps?.committedFiles ? { committedFiles: deps.committedFiles } : {}) : getConnector(id, config),
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
  if (selected.connection.connector_id === "kizuki.x") {
    const bytes = store.read(selected.connection);
    if (bytes === null) throw new ConnectionError("X protected state is unavailable.");
    const identity = inspectXApiState(bytes);
    const grant = inspectSourceGrant(db, selected.connection.source_key);
    if (!grant || xApiRequiredFields(identity.selection).some(field => !grant.policy.allowed_fields.includes(field as "text" | "subjects" | "attachments" | "metadata"))) {
      throw new ConnectionError("source_field_denied; X selected fields are incompatible with this grant. Inspect the source policy and explicitly reconcile consent; projection changes through reauthorization are unsupported.");
    }
    if (identity.recovery_required) throw new ConnectionError("credential_recovery_required; X refresh outcome is unknown; use connect recover-x-api for an explicit new authorization.");
    const client = await xApiClient(env, identity);
    if (sourceCaptureAdmission(db, selected.connection.connector_id, selected.connection.source_key)?.expected_revision !== grant.revision) {
      throw new ConnectionError("source_capture_denied; source consent changed during host composition; retry with current policy.");
    }
    const ref = selected.connection.secret_refs[0]!;
    const connector = factory("kizuki.x", xApiStateConfig(bytes, ref, client), {
      persist: inspectionSafePersister(db, store, selected.connection),
    });
    try {
      await connector.connect(async wanted => {
        if (wanted !== ref) throw new ConnectionError("unexpected X state reference");
        return new TextDecoder().decode(bytes);
      });
    } catch {
      await closeHostConnector(connector);
      throw new ConnectionError("X connection unavailable; check operator configuration and reauthorize the existing source.");
    }
    return connector;
  }
  if (selected.connection.connector_id === "kizuki.gmail") {
    const bytes = store.read(selected.connection);
    if (bytes === null) throw new ConnectionError("Gmail protected state is unavailable.");
    const identity = inspectGmailState(bytes);
    const grant = inspectSourceGrant(db, selected.connection.source_key);
    if (!grant || gmailRequiredFields(identity.fields).some(field => !grant.policy.allowed_fields.includes(field as "text" | "subjects" | "attachments" | "metadata"))) {
      throw new ConnectionError("source_field_denied; Gmail selected fields are incompatible with this grant. Inspect the source policy and explicitly reconcile consent; projection changes through reauthorization are unsupported.");
    }
    const client = await gmailClient(env);
    if (sourceCaptureAdmission(db, selected.connection.connector_id, selected.connection.source_key)?.expected_revision !== grant.revision) {
      throw new ConnectionError("source_capture_denied; source consent changed during host composition; retry with current policy.");
    }
    const ref = selected.connection.secret_refs[0]!;
    const connector = factory("kizuki.gmail", gmailStateConfig(bytes, ref, client), {
      persist: inspectionSafePersister(db, store, selected.connection),
    });
    try {
      await connector.connect(async wanted => {
        if (wanted !== ref) throw new ConnectionError("unexpected Gmail state reference");
        return new TextDecoder().decode(bytes);
      });
    } catch {
      await closeHostConnector(connector);
      throw new ConnectionError("Gmail connection unavailable; check operator configuration and reauthorize the existing source.");
    }
    return connector;
  }
  if (selected.connection.connector_id === "kizuki.google-calendar") {
    const bytes = store.read(selected.connection);
    if (bytes === null) throw new ConnectionError("Google Calendar protected state is unavailable.");
    const identity = inspectGoogleCalendarState(bytes);
    const grant = inspectSourceGrant(db, selected.connection.source_key);
    if (!grant || googleCalendarRequiredFields(identity.fields).some(field => !grant.policy.allowed_fields.includes(field as "text" | "subjects" | "attachments" | "metadata"))) {
      throw new ConnectionError("source_field_denied; Google Calendar selected fields are incompatible with this grant. Inspect the source policy and explicitly reconcile consent; projection changes through reauthorization are unsupported.");
    }
    const client = await googleCalendarClient(env);
    if (sourceCaptureAdmission(db, selected.connection.connector_id, selected.connection.source_key)?.expected_revision !== grant.revision) {
      throw new ConnectionError("source_capture_denied; source consent changed during host composition; retry with current policy.");
    }
    const ref = selected.connection.secret_refs[0]!;
    const connector = factory("kizuki.google-calendar", googleCalendarStateConfig(bytes, ref, client), {
      persist: inspectionSafePersister(db, store, selected.connection),
    });
    try {
      await connector.connect(async wanted => {
        if (wanted !== ref) throw new ConnectionError("unexpected Google Calendar state reference");
        return new TextDecoder().decode(bytes);
      });
    } catch {
      await closeHostConnector(connector);
      throw new ConnectionError("Google Calendar connection unavailable; check operator configuration and reauthorize the existing source.");
    }
    return connector;
  }
  const telegram = selected.connection.connector_id === "kizuki.telegram";
  const markdown = selected.connection.connector_id === "kizuki.markdown-folder";
  const connector = factory(
    selected.connection.connector_id,
    selected.state.config,
    telegram
      ? { persist: inspectionSafePersister(db, store, selected.connection) }
      : markdown
        ? {
            committedFiles: () =>
              markdownCommittedIdentities(db, selected.connection.source_key),
          }
        : undefined,
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

/** Local transport/custody cleanup never revokes a provider account. */
export async function closeHostConnector(connector: Connector): Promise<void> {
  if (connector instanceof XApiConnector) await connector.closeForHost();
  if (connector instanceof TelegramConnector) await connector.close();
  if (connector instanceof GmailConnector) await connector.close();
  if (connector instanceof GoogleCalendarConnector) await connector.close();
}
