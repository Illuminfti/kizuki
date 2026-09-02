import type { Api, TelegramClient, utils as Utils } from "telegram";
import type { Dialog } from "telegram/tl/custom/dialog.js";
import type { StringSession } from "telegram/sessions/index.js";
import { TelegramConnectorError } from "./api";
import type {
  AppCredentials,
  MessagesQuery,
  PeerType,
  SignInFlow,
  TelegramApi,
  TelegramApiFactory,
  TelegramDialog,
  TelegramMessage,
  TelegramUser,
} from "./api";
import { TELEGRAM_CONNECTOR_VERSION } from "./map";
import { describeMedia } from "./media";

/** Provider errors that mean the stored session is finished, not merely failing. */
const DEAD_SESSION = new Set([
  "AUTH_KEY_UNREGISTERED",
  "AUTH_KEY_INVALID",
  "SESSION_REVOKED",
  "SESSION_EXPIRED",
  "USER_DEACTIVATED",
  "USER_DEACTIVATED_BAN",
]);
/** Telegram's own ceiling for one history page. */
const MAX_PAGE = 500;

interface Runtime {
  client: TelegramClient;
  session: StringSession;
  utils: typeof Utils;
  isFloodWait: (error: unknown) => error is { seconds: number };
  isRpcError: (error: unknown) => error is { errorMessage: string };
  logOutRequest: () => Api.AnyRequest;
}

/**
 * The one module that talks to Telegram. The library is loaded lazily so the
 * registry, the offline fixture and the conformance suite never pull MTProto
 * code into the process.
 */
class RealTelegramApi implements TelegramApi {
  readonly #session: string;
  readonly #credentials: AppCredentials;
  #runtime: Runtime | null = null;

  constructor(session: string, credentials: AppCredentials) {
    this.#session = session;
    this.#credentials = credentials;
  }

  async connect(): Promise<void> {
    const runtime = await this.#load();
    await this.#guard(() => runtime.client.connect(), runtime);
  }

  async disconnect(): Promise<void> {
    if (this.#runtime === null) return;
    await this.#runtime.client.disconnect();
  }

  async isAuthorized(): Promise<boolean> {
    const runtime = await this.#load();
    return this.#guard(() => runtime.client.checkAuthorization(), runtime);
  }

  async start(flow: SignInFlow): Promise<void> {
    const runtime = await this.#load();
    await this.#guard(
      () =>
        runtime.client.start({
          phoneNumber: flow.phone,
          phoneCode: () => flow.code(),
          password: (hint) => flow.password(hint),
          onError: (error) => flow.onError(rpcName(error, runtime)),
        }),
      runtime,
    );
  }

  async me(): Promise<TelegramUser> {
    const runtime = await this.#load();
    const me = await this.#guard(() => runtime.client.getMe(false), runtime);
    return {
      id: me.id.toString(),
      ...(me.username === undefined ? {} : { username: me.username }),
      ...(me.firstName === undefined ? {} : { first_name: me.firstName }),
      ...(me.lastName === undefined ? {} : { last_name: me.lastName }),
      bot: me.bot === true,
    };
  }

  saveSession(): string {
    if (this.#runtime === null) {
      throw new TelegramConnectorError(
        "missing_session",
        "kizuki.telegram: no client is running; connect first",
      );
    }
    return this.#runtime.session.save();
  }

  async *dialogs(limit: number): AsyncGenerator<TelegramDialog> {
    const runtime = await this.#load();
    const iterator = runtime.client.iterDialogs({ limit });
    for await (const dialog of iterator) {
      const mapped = mapDialog(dialog, runtime);
      if (mapped !== null) yield mapped;
    }
  }

  async *messages(
    peer_id: string,
    query: MessagesQuery,
  ): AsyncGenerator<TelegramMessage> {
    const runtime = await this.#load();
    // Reverse mode makes minId the exclusive start and returns ascending ids.
    const iterator = runtime.client.iterMessages(peer_id, {
      reverse: true,
      offsetId: query.min_id,
      minId: query.min_id,
      maxId: query.max_id ?? 0,
      limit: Math.min(query.limit, MAX_PAGE),
      waitTime: 1,
    });
    for await (const message of iterator) {
      const mapped = mapMessageRecord(message, peer_id, runtime);
      if (mapped !== null) yield mapped;
    }
  }

  async logOut(): Promise<void> {
    const runtime = await this.#load();
    await this.#guard(
      () => runtime.client.invoke(runtime.logOutRequest()),
      runtime,
    );
  }

  async #load(): Promise<Runtime> {
    if (this.#runtime !== null) return this.#runtime;
    const library = await import("telegram");
    const sessions = await import("telegram/sessions/index.js");
    const logging = await import("telegram/extensions/Logger.js");
    const failures = await import("telegram/errors/index.js");
    const session = new sessions.StringSession(this.#session);
    const client = new library.TelegramClient(
      session,
      this.#credentials.api_id,
      this.#credentials.api_hash,
      {
        connectionRetries: 3,
        requestRetries: 3,
        timeout: 10,
        autoReconnect: false,
        // Never sleep inside the library: every wait is surfaced to the owner.
        floodSleepThreshold: 0,
        useWSS: false,
        deviceModel: "Kizuki",
        appVersion: TELEGRAM_CONNECTOR_VERSION,
        langCode: "en",
        systemLangCode: "en",
        baseLogger: new library.Logger(logging.LogLevel.NONE),
      },
    );
    this.#runtime = {
      client,
      session,
      utils: library.utils,
      isFloodWait: (error): error is { seconds: number } =>
        error instanceof failures.FloodWaitError,
      isRpcError: (error): error is { errorMessage: string } =>
        error instanceof failures.RPCError,
      logOutRequest: () => new library.Api.auth.LogOut(),
    };
    return this.#runtime;
  }

  async #guard<T>(operation: () => Promise<T>, runtime: Runtime): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      throw classify(error, runtime);
    }
  }
}

export const createRealApi: TelegramApiFactory = (session, credentials) =>
  new RealTelegramApi(session, credentials);

function classify(error: unknown, runtime: Runtime): TelegramConnectorError {
  if (error instanceof TelegramConnectorError) return error;
  if (runtime.isFloodWait(error)) {
    return new TelegramConnectorError(
      "flood_wait",
      `kizuki.telegram: telegram asked us to wait ${error.seconds}s`,
      { retry_after: error.seconds, cause: error },
    );
  }
  if (!runtime.isRpcError(error)) {
    // Socket, timeout and name-resolution faults never reach the RPC layer.
    return new TelegramConnectorError(
      "unreachable",
      "kizuki.telegram: telegram is unreachable",
      { cause: error },
    );
  }
  const name = error.errorMessage;
  if (DEAD_SESSION.has(name)) {
    return new TelegramConnectorError(
      "unauthenticated",
      "kizuki.telegram: the stored session is no longer authorized; sign in again",
      { cause: error },
    );
  }
  if (name === "PHONE_NUMBER_INVALID") {
    return new TelegramConnectorError(
      "invalid_phone",
      "kizuki.telegram: telegram rejected the phone number",
      { cause: error },
    );
  }
  return new TelegramConnectorError(
    "parse_error",
    `kizuki.telegram: telegram returned ${name}`,
    { cause: error },
  );
}

function rpcName(error: unknown, runtime: Runtime): string {
  return runtime.isRpcError(error) ? error.errorMessage : "UNKNOWN";
}

function mapDialog(dialog: Dialog, runtime: Runtime): TelegramDialog | null {
  const entity = dialog.entity;
  if (entity === undefined) return null;
  const peerType: PeerType = dialog.isUser
    ? "user"
    : dialog.isGroup
      ? "group"
      : "channel";
  return {
    peer_id: runtime.utils.getPeerId(entity, true),
    peer_type: peerType,
    title: runtime.utils.getDisplayName(entity),
    public: hasPublicHandle(entity),
    top_message_id: dialog.message?.id ?? 0,
  };
}

function hasPublicHandle(entity: unknown): boolean {
  if (typeof entity !== "object" || entity === null) return false;
  const record = entity as { username?: unknown; usernames?: unknown };
  if (typeof record.username === "string" && record.username.length > 0) {
    return true;
  }
  return Array.isArray(record.usernames) && record.usernames.length > 0;
}

function mapMessageRecord(
  message: Api.Message | Api.MessageService,
  peer_id: string,
  runtime: Runtime,
): TelegramMessage | null {
  if (typeof message.id !== "number") return null;
  const sender = senderReference(message, runtime);
  const forward = message.fwdFrom;
  const forwardOrigin =
    forward === undefined ? null : peerReference(forward.fromId, runtime);
  const forwardFrom =
    forward === undefined
      ? undefined
      : {
          ...(forwardOrigin === null ? {} : { id: forwardOrigin.id }),
          ...(typeof forward.fromName === "string"
            ? { name: forward.fromName }
            : {}),
          ...(typeof forward.date === "number" ? { date: forward.date } : {}),
        };
  const media = describeMedia(message.media);
  return {
    peer_id,
    id: message.id,
    date: message.date,
    text: typeof message.message === "string" ? message.message : "",
    out: message.out === true,
    ...(sender === null ? {} : { from: sender }),
    ...(typeof message.postAuthor === "string"
      ? { post_author: message.postAuthor }
      : {}),
    ...(typeof message.replyToMsgId === "number"
      ? { reply_to: message.replyToMsgId }
      : {}),
    ...(forwardFrom === undefined ? {} : { forward_from: forwardFrom }),
    ...(typeof message.editDate === "number"
      ? { edit_date: message.editDate }
      : {}),
    ...(message.groupedId === undefined
      ? {}
      : { grouped_id: message.groupedId.toString() }),
    service: message.className === "MessageService",
    ...(media.attachment === null ? {} : { attachment: media.attachment }),
    ...(media.kind === null ? {} : { media_kind: media.kind }),
  };
}

/** Prefers the entity the response already carried; falls back to the bare id. */
function senderReference(
  message: Api.Message | Api.MessageService,
  runtime: Runtime,
): { id: string; display: string; kind: "user" | "chat" } | null {
  const reference = peerReference(message.fromId, runtime);
  if (reference === null) return null;
  const entity = message.sender;
  return entity === undefined
    ? reference
    : { ...reference, display: runtime.utils.getDisplayName(entity) };
}

function peerReference(
  peer: unknown,
  runtime: Runtime,
): { id: string; display: string; kind: "user" | "chat" } | null {
  if (peer === null || peer === undefined) return null;
  let id: string;
  try {
    id = runtime.utils.getPeerId(peer as Parameters<typeof runtime.utils.getPeerId>[0], true);
  } catch {
    return null;
  }
  const kind = id.startsWith("-") ? "chat" : "user";
  return { id, display: id, kind };
}
