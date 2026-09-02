import type { Api, TelegramClient, utils as Utils } from "telegram";
import type { Dialog } from "telegram/tl/custom/dialog.js";
import type { StringSession } from "telegram/sessions/index.js";
import { TelegramConnectorError, redactedCause } from "./api";
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
import { classify, guarded, isRefusedCredential } from "./guard";
import type { ProviderErrors } from "./guard";
import { TELEGRAM_CONNECTOR_VERSION } from "./map";
import { describeMedia } from "./media";
import { hasPublicHandle } from "./peer";

/** Telegram's own ceiling for one history page. */
const MAX_PAGE = 500;

interface Runtime extends ProviderErrors {
  client: TelegramClient;
  session: StringSession;
  utils: typeof Utils;
  logOutRequest: () => Api.AnyRequest;
  stateRequest: () => Api.AnyRequest;
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
    try {
      await runtime.client.invoke(runtime.stateRequest());
      return true;
    } catch (error) {
      const classified = classify(error, runtime);
      // Only the provider saying the session is finished is an answer of no.
      // A socket or timeout fault is no answer at all, and calling it a
      // revoked sign-in would send the owner to authenticate again over a
      // connection that is merely down.
      if (classified.code === "unauthenticated") return false;
      throw classified;
    }
  }

  async start(flow: SignInFlow): Promise<void> {
    const runtime = await this.#load();
    const refusal: { error: TelegramConnectorError | null } = { error: null };
    try {
      await this.#guard(
        () =>
          runtime.client.start({
            phoneNumber: flow.phone,
            phoneCode: () => flow.code(),
            password: (hint) => flow.password(hint),
            // A number with no account behind it sends the library down its
            // sign-up branch, which registers one under a placeholder name and
            // accepts the provider's terms on the owner's behalf. This
            // connector signs in to an account that exists and takes no
            // outbound action, so the branch is refused before either request
            // is sent.
            firstAndLastNames: () => refuseRegistration(refusal),
            onError: (error) => askOrEnd(error, flow, refusal, runtime),
          }),
        runtime,
      );
    } catch (error) {
      // The library reports the refusal as its own cancellation; the reason it
      // was cancelled is the useful one.
      const refused = refusal.error;
      if (refused !== null) throw refused;
      throw error;
    }
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
    yield* guarded(
      () => runtime.client.iterDialogs({ limit }),
      (dialog) => mapDialog(dialog, runtime),
      runtime,
    );
  }

  async *messages(
    peer_id: string,
    query: MessagesQuery,
  ): AsyncGenerator<TelegramMessage> {
    const runtime = await this.#load();
    yield* guarded(
      () =>
        // Reverse mode makes minId the exclusive start and returns ascending ids.
        runtime.client.iterMessages(peer_id, {
          reverse: true,
          offsetId: query.min_id,
          minId: query.min_id,
          maxId: query.max_id ?? 0,
          limit: Math.min(query.limit, MAX_PAGE),
          waitTime: 1,
        }),
      (message) => mapMessageRecord(message, peer_id, runtime),
      runtime,
    );
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
    try {
      this.#runtime = await this.#build();
    } catch (error) {
      // A library that will not load is indistinguishable, to a caller, from a
      // provider it cannot reach; either way no request can be made.
      throw new TelegramConnectorError(
        "unreachable",
        "kizuki.telegram: the telegram client could not be started",
        { cause: redactedCause(error) },
      );
    }
    return this.#runtime;
  }

  async #build(): Promise<Runtime> {
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
    return {
      client,
      session,
      utils: library.utils,
      isFloodWait: (error): error is { seconds: number } =>
        error instanceof failures.FloodWaitError,
      isRpcError: (error): error is { errorMessage: string } =>
        error instanceof failures.RPCError,
      logOutRequest: () => new library.Api.auth.LogOut(),
      stateRequest: () => new library.Api.updates.GetState(),
    };
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

/**
 * The library hands every failure inside its sign-in loops to `onError` and
 * reads a `false` answer as "ask the owner again", so a wait or a socket fault
 * answered that way is spent as one of their attempts and then abandons a
 * sign-in that was never refused. Only a credential Telegram named as wrong
 * is worth another prompt; anything else is recorded and answered with the
 * stop the library understands, so `start` can throw the real reason.
 */
async function askOrEnd(
  error: unknown,
  flow: SignInFlow,
  refusal: { error: TelegramConnectorError | null },
  runtime: Runtime,
): Promise<boolean> {
  if (refusal.error !== null) return true;
  const name = rpcName(error, runtime);
  if (runtime.isRpcError(error) && isRefusedCredential(name)) {
    return flow.onError(name);
  }
  refusal.error = classify(error, runtime);
  return true;
}

function refuseRegistration(holder: {
  error: TelegramConnectorError | null;
}): never {
  const refused = new TelegramConnectorError(
    "sign_in_aborted",
    "kizuki.telegram: that number has no telegram account; this connector signs in to one, it never creates one",
  );
  holder.error = refused;
  throw refused;
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
