/** Plain records the connector logic works on, so provider types stay in `client.ts`. */
export type PeerType = "user" | "group" | "channel";

export const PEER_TYPES: readonly PeerType[] = ["user", "group", "channel"];

export interface AppCredentials {
  api_id: number;
  api_hash: string;
}

export interface TelegramUser {
  id: string;
  username?: string;
  first_name?: string;
  last_name?: string;
  bot: boolean;
}

export interface TelegramDialog {
  peer_id: string;
  peer_type: PeerType;
  title: string;
  top_message_id: number;
}

export interface TelegramAttachment {
  attachment_id: string;
  media_type: string;
  filename?: string;
  byte_size?: number;
}

export interface TelegramMessage {
  peer_id: string;
  id: number;
  date: number;
  text: string;
  out: boolean;
  from?: { id: string; display: string; kind: "user" | "chat" };
  post_author?: string;
  reply_to?: number;
  forward_from?: { id?: string; name?: string; date?: number };
  edit_date?: number;
  grouped_id?: string;
  service: boolean;
  attachment?: TelegramAttachment;
  media_kind?: string;
}

export interface SignInFlow {
  phone: string;
  code(): Promise<string>;
  password(hint?: string): Promise<string>;
  /** Return true to abort; called with the provider error name only. */
  onError(errorName: string): Promise<boolean>;
}

export interface MessagesQuery {
  /** Exclusive lower bound; 0 reads from the start of the dialog. */
  min_id: number;
  /** Exclusive upper bound; undefined means no bound. */
  max_id?: number;
  limit: number;
}

export interface TelegramApi {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isAuthorized(): Promise<boolean>;
  start(flow: SignInFlow): Promise<void>;
  me(): Promise<TelegramUser>;
  saveSession(): string;
  dialogs(limit: number): AsyncIterable<TelegramDialog>;
  /** Oldest to newest, ids strictly ascending, never more than `limit` items. */
  messages(
    peer_id: string,
    query: MessagesQuery,
  ): AsyncIterable<TelegramMessage>;
  logOut(): Promise<void>;
}

export type TelegramApiFactory = (
  session: string,
  credentials: AppCredentials,
) => TelegramApi;

export type TelegramErrorCode =
  | "closed"
  | "state_persistence_failed"
  | "placeholder_credentials"
  | "missing_session"
  | "corrupt_state"
  | "invalid_phone"
  | "sign_in_aborted"
  | "identity_mismatch"
  | "unauthenticated"
  | "flood_wait"
  | "unreachable"
  | "parse_error";

/**
 * A parser quotes the token it failed on, and a provider names its own
 * failures in text it chose, so an error raised over credential bytes carries
 * them into every rendered cause chain. Nothing but the runtime kind of the
 * failure crosses that boundary: a credential can be spelled like a class
 * name, so even the name is left behind.
 */
export function redactedCause(error: unknown): Error {
  const shape = error instanceof Error ? "Error" : typeof error;
  return new Error(`kizuki.telegram: ${shape} (details withheld)`);
}

/** Ours already says only what it chose to; anything else is reduced to shape. */
export function safeCause(error: unknown): Error {
  return error instanceof TelegramConnectorError ? error : redactedCause(error);
}

/**
 * Declared here rather than reusing `KizukiError`: `@kizuki/connectors` depends
 * on this package for its registry entry, so importing back would be a cycle.
 * No message may carry captured text, a phone number, a code or the session.
 */
export class TelegramConnectorError extends Error {
  readonly code: TelegramErrorCode;
  readonly retry_after: number | undefined;

  constructor(
    code: TelegramErrorCode,
    message: string,
    options?: { retry_after?: number; cause?: unknown },
  ) {
    super(message, options);
    this.name = "TelegramConnectorError";
    this.code = code;
    this.retry_after = options?.retry_after;
  }
}
