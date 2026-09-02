import { TelegramConnectorError } from "./api";
import type {
  MessagesQuery,
  SignInFlow,
  TelegramApi,
  TelegramDialog,
  TelegramMessage,
  TelegramUser,
} from "./api";
import type { TelegramDeps } from "./connector";
import {
  FIXTURE_CREDENTIALS,
  FIXTURE_OBSERVED_AT,
  FIXTURE_SESSION,
  fixtureAccount,
} from "./fixture";
import type { ScriptedAccount, ScriptedSignIn } from "./fixture";

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
