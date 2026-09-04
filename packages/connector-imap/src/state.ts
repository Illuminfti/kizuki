import { KizukiError, isPlainObject } from "@kizuki/core";

export const IMAP_STATE_SCHEMA = "kizuki.imap-state/v1" as const;
export const DEFAULT_MAX_MESSAGE_BYTES = 2_097_152;
export const MAX_HOST_LENGTH = 253;

/**
 * The opaque bytes behind `file:connections/<ulid>.state`. Every field the
 * connector needs to reach the server lives here and nowhere else — SQLite's
 * CHECK constraints refuse to hold any of it.
 */
export interface ImapState {
  schema: typeof IMAP_STATE_SCHEMA;
  host: string;
  port: number;
  username: string;
  password: string;
  folders: string[];
  max_message_bytes: number;
}

const FIELDS = [
  "schema",
  "host",
  "port",
  "username",
  "password",
  "folders",
  "max_message_bytes",
] as const;

/** Field names only: a rejection reason must never carry a credential. */
function refuse(field: string, requirement: string): never {
  throw new KizukiError(
    "misconfigured",
    `kizuki.imap: connection state field ${field} ${requirement}`,
  );
}

function requireString(raw: Record<string, unknown>, field: string): string {
  const value = raw[field];
  if (typeof value !== "string" || value.length === 0) {
    refuse(field, "must be a non-empty string");
  }
  return value;
}

export function validateHost(host: string): void {
  if (host.length === 0 || host.length > MAX_HOST_LENGTH) {
    refuse("host", `must be 1..${MAX_HOST_LENGTH} characters`);
  }
  if (/\s/.test(host) || host.includes("/")) {
    refuse("host", "must not contain whitespace or a path separator");
  }
}

export function validatePort(port: unknown): number {
  if (!Number.isInteger(port) || (port as number) < 1 || (port as number) > 65535) {
    refuse("port", "must be an integer in 1..65535");
  }
  return port as number;
}

function validateFolders(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    refuse("folders", "must be a non-empty array");
  }
  const folders: string[] = [];
  for (const folder of raw) {
    if (typeof folder !== "string" || folder.length === 0) {
      refuse("folders", "must contain non-empty strings");
    }
    if (folders.includes(folder)) refuse("folders", "must not repeat a mailbox");
    folders.push(folder);
  }
  // The connector syncs INBOX plus whatever else the owner picked. A state
  // without it would quietly sync neither, and the owner would have no way to
  // tell that from an empty mailbox.
  if ((folders[0] ?? "").toUpperCase() !== "INBOX") {
    refuse("folders", "must list INBOX first");
  }
  return folders;
}

export function parseImapState(text: string): ImapState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw new KizukiError(
      "misconfigured",
      "kizuki.imap: connection state is not readable",
      { cause: error },
    );
  }
  if (!isPlainObject(parsed)) {
    throw new KizukiError(
      "misconfigured",
      "kizuki.imap: connection state must be an object",
    );
  }
  for (const key of Object.keys(parsed)) {
    if (!(FIELDS as readonly string[]).includes(key)) {
      throw new KizukiError(
        "misconfigured",
        "kizuki.imap: connection state has an unknown field",
      );
    }
  }
  if (parsed["schema"] !== IMAP_STATE_SCHEMA) {
    refuse("schema", `must be ${IMAP_STATE_SCHEMA}`);
  }
  const host = requireString(parsed, "host");
  validateHost(host);
  const maxMessageBytes = parsed["max_message_bytes"];
  if (
    !Number.isInteger(maxMessageBytes) ||
    (maxMessageBytes as number) < 1
  ) {
    refuse("max_message_bytes", "must be a positive integer");
  }
  return {
    schema: IMAP_STATE_SCHEMA,
    host,
    port: validatePort(parsed["port"]),
    username: requireString(parsed, "username"),
    password: requireString(parsed, "password"),
    folders: validateFolders(parsed["folders"]),
    max_message_bytes: maxMessageBytes as number,
  };
}

export function serializeImapState(state: ImapState): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      schema: state.schema,
      host: state.host,
      port: state.port,
      username: state.username,
      password: state.password,
      folders: state.folders,
      max_message_bytes: state.max_message_bytes,
    }),
  );
}

/** Refuse replacing a source with another mailbox without revealing either identity. */
export function assertSameImapIdentity(previous: Uint8Array, candidate: Uint8Array): void {
  const before = parseImapState(new TextDecoder("utf-8", { fatal: true }).decode(previous));
  const after = parseImapState(new TextDecoder("utf-8", { fatal: true }).decode(candidate));
  if (before.host.toLowerCase() !== after.host.toLowerCase() || before.port !== after.port || before.username !== after.username) {
    throw new KizukiError("misconfigured", "kizuki.imap: mailbox identity does not match the existing connection");
  }
}
