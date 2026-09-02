import { TelegramConnectorError } from "./api";
import type {
  AppCredentials,
  MessagesQuery,
  SignInFlow,
  TelegramApi,
  TelegramDialog,
  TelegramMessage,
  TelegramUser,
} from "./api";
import type { TelegramDeps } from "./connector";

/** Recognisable, obviously synthetic, and asserted against by the redaction tests. */
export const FIXTURE_SESSION = "fixture-session-token-not-a-real-credential";
export const FIXTURE_CREDENTIALS: AppCredentials = {
  api_id: 12345,
  api_hash: "cafe",
};
export const FIXTURE_OBSERVED_AT = "2026-01-01T00:00:00.000Z";

export interface ScriptedSignIn {
  code: string;
  password?: string;
  password_hint?: string;
  /** How many times `start` reports a wait before it accepts the flow. */
  flood?: { seconds: number; times: number };
}

export interface ScriptedAccount {
  me: TelegramUser;
  authorized: boolean;
  dialogs: TelegramDialog[];
  /** Per peer id, ascending message ids. */
  messages: Record<string, TelegramMessage[]>;
  /** The call after this many `messages()` calls reports a wait, once. */
  flood?: { after_calls: number; seconds: number };
  sign_in?: ScriptedSignIn;
}

function at(day: number, hour: number, minute: number): number {
  return Math.floor(Date.UTC(2026, 0, day, hour, minute, 0) / 1000);
}

const ADA: TelegramUser = {
  id: "1001",
  username: "ada",
  first_name: "ada",
  bot: false,
};

const PRIVATE_MESSAGES: TelegramMessage[] = [
  { peer_id: "1002", id: 1, date: at(2, 9, 0), text: "morning", out: false, service: false },
  { peer_id: "1002", id: 2, date: at(2, 9, 5), text: "morning back", out: true, service: false },
  {
    peer_id: "1002",
    id: 3,
    date: at(2, 9, 10),
    text: "",
    out: false,
    service: false,
    attachment: {
      attachment_id: "5001",
      media_type: "application/pdf",
      filename: "agenda.pdf",
      byte_size: 2048,
    },
  },
  { peer_id: "1002", id: 4, date: at(2, 9, 15), text: "got it", out: true, service: false, reply_to: 3 },
  { peer_id: "1002", id: 5, date: at(2, 9, 20), text: "see you at the standup", out: false, service: false },
];

const GROUP_MESSAGES: TelegramMessage[] = [
  {
    peer_id: "-42",
    id: 10,
    date: at(3, 10, 0),
    text: "standup at ten",
    out: false,
    service: false,
    from: { id: "1002", display: "grace", kind: "user" },
  },
  {
    peer_id: "-42",
    id: 11,
    date: at(3, 10, 2),
    text: "on my way",
    out: false,
    service: false,
    from: { id: "1003", display: "linus", kind: "user" },
    edit_date: at(3, 10, 4),
  },
  {
    peer_id: "-42",
    id: 12,
    date: at(3, 10, 5),
    text: "",
    out: false,
    service: true,
    from: { id: "1003", display: "linus", kind: "user" },
  },
  {
    peer_id: "-42",
    id: 13,
    date: at(3, 10, 8),
    text: "sharing the agenda here too",
    out: true,
    service: false,
    from: { id: "1001", display: "@ada", kind: "user" },
    forward_from: { id: "1002", name: "grace", date: at(2, 9, 10) },
  },
];

const CHANNEL_MESSAGES: TelegramMessage[] = [
  {
    peer_id: "-100777",
    id: 20,
    date: at(4, 12, 0),
    text: "acme ships the first release",
    out: false,
    service: false,
    post_author: "grace",
  },
  {
    peer_id: "-100777",
    id: 21,
    date: at(4, 12, 30),
    text: "release notes are attached",
    out: false,
    service: false,
    attachment: { attachment_id: "7001", media_type: "image/jpeg" },
  },
  {
    peer_id: "-100777",
    id: 22,
    date: at(4, 13, 0),
    text: "",
    out: false,
    service: false,
    media_kind: "MessageMediaPoll",
  },
  {
    peer_id: "-100777",
    id: 23,
    date: at(4, 13, 30),
    text: "thanks for reading",
    out: false,
    service: false,
    from: { id: "1002", display: "grace", kind: "user" },
  },
];

export const FIXTURE_ACCOUNT: ScriptedAccount = {
  me: ADA,
  authorized: true,
  dialogs: [
    { peer_id: "1002", peer_type: "user", title: "grace", public: false, top_message_id: 5 },
    { peer_id: "-42", peer_type: "group", title: "acme planning", public: false, top_message_id: 13 },
    { peer_id: "-100777", peer_type: "channel", title: "acme news", public: true, top_message_id: 23 },
  ],
  messages: {
    "1002": PRIVATE_MESSAGES,
    "-42": GROUP_MESSAGES,
    "-100777": CHANNEL_MESSAGES,
  },
  sign_in: { code: "22222" },
};

/** Deep copy so a mutating test cannot leak into the next one. */
export function fixtureAccount(
  overrides: Partial<ScriptedAccount> = {},
): ScriptedAccount {
  return {
    ...(structuredClone(FIXTURE_ACCOUNT) as ScriptedAccount),
    ...overrides,
  };
}

export class ScriptedTelegramApi implements TelegramApi {
  readonly calls: { method: keyof TelegramApi; args: unknown[] }[] = [];
  readonly #account: ScriptedAccount;
  readonly #session: string;
  #authorized: boolean;
  #reachable = true;
  #messageCalls = 0;
  readonly #hidden: TelegramDialog[] = [];
  #floodFired = false;
  #signInFloods = 0;

  constructor(account: ScriptedAccount, session: string = FIXTURE_SESSION) {
    this.#account = account;
    this.#session = session;
    this.#authorized = account.authorized;
  }

  async connect(): Promise<void> {
    this.#record("connect", []);
    this.#assertReachable();
  }

  async disconnect(): Promise<void> {
    this.#record("disconnect", []);
  }

  async isAuthorized(): Promise<boolean> {
    this.#record("isAuthorized", []);
    this.#assertReachable();
    return this.#authorized;
  }

  async start(flow: SignInFlow): Promise<void> {
    this.#record("start", [flow.phone]);
    this.#assertReachable();
    const script = this.#account.sign_in;
    if (script === undefined) {
      throw new TelegramConnectorError(
        "unauthenticated",
        "kizuki.telegram: the scripted account refuses interactive sign-in",
      );
    }
    const flood = script.flood;
    if (flood !== undefined && this.#signInFloods < flood.times) {
      this.#signInFloods += 1;
      throw waitError(flood.seconds);
    }
    await this.#collect(flow, script, "code");
    if (script.password !== undefined) {
      await this.#collect(flow, script, "password");
    }
    this.#authorized = true;
  }

  async me(): Promise<TelegramUser> {
    this.#record("me", []);
    this.#assertReachable();
    this.#assertAuthorized();
    return this.#account.me;
  }

  saveSession(): string {
    this.#record("saveSession", []);
    return this.#session;
  }

  async *dialogs(limit: number): AsyncGenerator<TelegramDialog> {
    this.#record("dialogs", [limit]);
    this.#assertReachable();
    this.#assertAuthorized();
    for (const dialog of this.#account.dialogs.slice(0, limit)) {
      yield dialog;
    }
  }

  async *messages(
    peer_id: string,
    query: MessagesQuery,
  ): AsyncGenerator<TelegramMessage> {
    this.#record("messages", [peer_id, query]);
    this.#assertReachable();
    this.#assertAuthorized();
    this.#messageCalls += 1;
    const flood = this.#account.flood;
    const floods =
      flood !== undefined &&
      !this.#floodFired &&
      this.#messageCalls > flood.after_calls;
    let yielded = 0;
    for (const message of this.#account.messages[peer_id] ?? []) {
      if (message.id <= query.min_id) continue;
      if (query.max_id !== undefined && message.id >= query.max_id) continue;
      if (yielded >= query.limit) return;
      // A wait mid-dialog is the interesting case: the caller must keep the
      // records it already has and resume from exactly the last one.
      if (floods && yielded === 1) break;
      yield message;
      yielded += 1;
    }
    if (floods) {
      this.#floodFired = true;
      throw waitError(flood.seconds);
    }
  }

  async logOut(): Promise<void> {
    this.#record("logOut", []);
    this.#assertReachable();
    this.#assertAuthorized();
    this.#authorized = false;
  }

  edit(peer_id: string, id: number, text: string, edit_date: number): void {
    const message = (this.#account.messages[peer_id] ?? []).find(
      (candidate) => candidate.id === id,
    );
    if (message === undefined) {
      throw new TelegramConnectorError(
        "parse_error",
        "kizuki.telegram: the scripted account has no such message",
      );
    }
    message.text = text;
    message.edit_date = edit_date;
  }

  append(peer_id: string, message: TelegramMessage): void {
    const existing = this.#account.messages[peer_id];
    if (existing === undefined) {
      this.#account.messages[peer_id] = [message];
      return;
    }
    existing.push(message);
  }

  addDialog(dialog: TelegramDialog, messages: TelegramMessage[] = []): void {
    this.#account.dialogs.push(dialog);
    this.#account.messages[dialog.peer_id] = messages;
  }

  /**
   * Drops a dialog from the listing while its history stays readable: what a
   * chat past the listing ceiling, or one the owner archived, looks like.
   */
  hideDialog(peer_id: string): void {
    this.#hidden.push(
      ...this.#account.dialogs.filter((dialog) => dialog.peer_id === peer_id),
    );
    this.#account.dialogs = this.#account.dialogs.filter(
      (dialog) => dialog.peer_id !== peer_id,
    );
  }

  /** Puts back everything `hideDialog` took out, in its original order. */
  showDialogs(): void {
    this.#account.dialogs.push(...this.#hidden.splice(0));
  }

  /** Arms one wait report `calls` further `messages()` calls from now. */
  floodAfter(calls: number, seconds: number): void {
    this.#account.flood = { after_calls: this.#messageCalls + calls, seconds };
    this.#floodFired = false;
  }

  /** Models the account signing this session out elsewhere. */
  revoke(): void {
    this.#authorized = false;
  }

  disconnectNetwork(): void {
    this.#reachable = false;
  }

  async #collect(
    flow: SignInFlow,
    script: ScriptedSignIn,
    field: "code" | "password",
  ): Promise<void> {
    const expected = field === "code" ? script.code : script.password;
    const name =
      field === "code" ? "PHONE_CODE_INVALID" : "PASSWORD_HASH_INVALID";
    for (;;) {
      const supplied =
        field === "code"
          ? await flow.code()
          : await flow.password(script.password_hint);
      if (supplied === expected) return;
      if (await flow.onError(name)) {
        throw new TelegramConnectorError(
          "parse_error",
          `kizuki.telegram: telegram rejected the sign-in attempt (${name})`,
        );
      }
    }
  }

  #record(method: keyof TelegramApi, args: unknown[]): void {
    this.calls.push({ method, args });
  }

  #assertReachable(): void {
    if (this.#reachable) return;
    throw new TelegramConnectorError(
      "unreachable",
      "kizuki.telegram: telegram is unreachable",
    );
  }

  #assertAuthorized(): void {
    if (this.#authorized) return;
    throw new TelegramConnectorError(
      "unauthenticated",
      "kizuki.telegram: this session is no longer authorized",
    );
  }
}

export function scriptedDeps(
  account: ScriptedAccount = fixtureAccount(),
  session: string = FIXTURE_SESSION,
): Partial<TelegramDeps> {
  const api = new ScriptedTelegramApi(account, session);
  return {
    api: () => api,
    credentials: () => FIXTURE_CREDENTIALS,
    now: () => Date.parse(FIXTURE_OBSERVED_AT),
    sleep: async () => {},
  };
}

function waitError(seconds: number): TelegramConnectorError {
  return new TelegramConnectorError(
    "flood_wait",
    `kizuki.telegram: telegram asked us to wait ${seconds}s`,
    { retry_after: seconds },
  );
}
