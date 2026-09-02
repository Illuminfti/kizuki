import { HealthReport, isPlainObject } from "@kizuki/core";
import type {
  CaptureEventInput,
  ConnectionStateWriter,
  Connector,
  Cursor,
  Manifest,
  PurgePlan,
  SecretResolver,
  SignInDisplay,
  SignInIo,
  SyncBatch,
} from "@kizuki/core";
import { TelegramConnectorError } from "./api";
import type { AppCredentials, TelegramApi, TelegramApiFactory, TelegramUser } from "./api";
import { appCredentials, requireAppCredentials } from "./app-credentials";
import { createRealApi } from "./client";
import { MAX_DIALOGS } from "./cursor";
import {
  TELEGRAM_CONNECTOR_ID,
  TELEGRAM_CONNECTOR_VERSION,
  mapMessage,
  userDisplay,
} from "./map";
import { PurgeIndex } from "./plan";
import { FIXTURE_ACCOUNT, FIXTURE_OBSERVED_AT } from "./scripted";
import { PHONE_FORMAT, runSignIn } from "./sign-in";
import { TELEGRAM_STATE_SCHEMA, encodeState, parseState } from "./state";
import { walk } from "./walk";

export { TELEGRAM_CONNECTOR_ID };

/** Mirrors `stateRefFor` in core: the connector only ever asks for its own ref. */
const STATE_REF = /^file:connections\/[0-9A-HJKMNPQRSTVWXYZ]{26}\.state$/;

export interface TelegramConnectorConfig {
  /** The connection's single secret_ref, once the owner has signed in. */
  state_ref?: string;
}

export interface TelegramDeps {
  api: TelegramApiFactory;
  credentials: () => AppCredentials | null;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

const MANIFEST: Manifest = {
  schema: "kizuki.connector/v1",
  connector_id: TELEGRAM_CONNECTOR_ID,
  version: TELEGRAM_CONNECTOR_VERSION,
  kinds: ["message"],
  capabilities: {
    backfill: true,
    sync: true,
    // Deletions are visible only through the update stream, which this
    // connector does not consume.
    tombstones: false,
    purge: true,
    fixture: true,
  },
  // The session is created by sign-in, not required up front.
  required_secrets: [],
  emits_sensitivity_hint: true,
  auth_modes: ["sign_in"],
};

export class TelegramConnector implements Connector {
  readonly #stateRef: string | null;
  readonly #deps: TelegramDeps;
  readonly #plan = new PurgeIndex();
  #api: TelegramApi | null = null;
  #self: TelegramUser | null = null;
  #floodUntil = 0;
  #dialogLimitReached = false;
  #revoked = false;
  #lastSuccessAt: string | undefined;

  constructor(
    config: TelegramConnectorConfig,
    deps: Partial<TelegramDeps> = {},
  ) {
    this.#stateRef = parseStateRef(config);
    this.#deps = {
      api: deps.api ?? createRealApi,
      credentials: deps.credentials ?? appCredentials,
      now: deps.now ?? Date.now,
      sleep: deps.sleep ?? Bun.sleep,
    };
  }

  manifest(): Manifest {
    return MANIFEST;
  }

  async signIn(
    io: SignInIo,
    state: ConnectionStateWriter,
  ): Promise<SignInDisplay> {
    const credentials = requireAppCredentials(this.#deps.credentials);
    const phone = (
      await io.prompt(
        "Telegram phone number (international format, e.g. +15551234567): ",
      )
    ).trim();
    if (!PHONE_FORMAT.test(phone)) {
      throw new TelegramConnectorError(
        "invalid_phone",
        "kizuki.telegram: phone number must be in international format",
      );
    }
    const api = this.#deps.api("", credentials);
    await api.connect();
    let me: TelegramUser;
    try {
      await runSignIn(api, io, phone, this.#deps.sleep);
      // Only once the account is known: a state blob without a confirmed
      // identity could not be checked against the session on the next connect.
      me = await api.me();
      await state.write(
        encodeState({
          schema: TELEGRAM_STATE_SCHEMA,
          user_id: me.id,
          session: api.saveSession(),
        }),
      );
    } catch (error) {
      await this.#disconnectQuietly(api);
      throw error;
    }
    await api.disconnect();
    return { display: userDisplay(me) };
  }

  async connect(resolve: SecretResolver): Promise<void> {
    const ref = this.#stateRef;
    if (ref === null) throw notSignedIn();
    let text: string;
    try {
      text = await resolve(ref);
    } catch (error) {
      throw new TelegramConnectorError(
        "missing_session",
        "kizuki.telegram: not signed in; run: kizuki connect telegram",
        { cause: error },
      );
    }
    const state = parseState(text);
    const credentials = requireAppCredentials(this.#deps.credentials);
    const api = this.#deps.api(state.session, credentials);
    await api.connect();
    let me: TelegramUser;
    try {
      if (!(await api.isAuthorized())) {
        throw new TelegramConnectorError(
          "unauthenticated",
          "kizuki.telegram: the stored session is no longer authorized; sign in again",
        );
      }
      me = await api.me();
      if (me.id !== state.user_id) {
        throw new TelegramConnectorError(
          "identity_mismatch",
          "kizuki.telegram: signed-in account does not match the stored connection",
        );
      }
    } catch (error) {
      await this.#disconnectQuietly(api);
      throw error;
    }
    this.#api = api;
    this.#self = me;
    this.#revoked = false;
    this.#lastSuccessAt = this.#nowIso();
  }

  async health(): Promise<HealthReport> {
    const checked_at = this.#nowIso();
    const success =
      this.#lastSuccessAt === undefined
        ? {}
        : { last_success_at: this.#lastSuccessAt };
    if (this.#stateRef === null) {
      return new HealthReport({
        state: "disabled",
        checked_at,
        detail: "not signed in",
      });
    }
    if (this.#revoked) {
      return new HealthReport({
        state: "unauthenticated",
        checked_at,
        detail: "access was revoked",
        ...success,
      });
    }
    const api = this.#api;
    if (api === null) {
      return new HealthReport({
        state: "unauthenticated",
        checked_at,
        detail: "connect() has not been called",
      });
    }
    const now = this.#deps.now();
    if (now < this.#floodUntil) {
      return new HealthReport({
        state: "rate_limited",
        checked_at,
        detail: `retry after ${Math.ceil((this.#floodUntil - now) / 1000)}s`,
        ...success,
      });
    }
    try {
      if (!(await api.isAuthorized())) {
        return new HealthReport({
          state: "unauthenticated",
          checked_at,
          detail: "the stored session is no longer authorized",
          ...success,
        });
      }
    } catch (error) {
      return new HealthReport({
        state:
          error instanceof TelegramConnectorError &&
          error.code === "unauthenticated"
            ? "unauthenticated"
            : "unreachable",
        checked_at,
        detail: "telegram did not answer the authorization probe",
        ...success,
      });
    }
    if (this.#dialogLimitReached) {
      return new HealthReport({
        state: "degraded",
        checked_at,
        detail: `dialog limit reached (${MAX_DIALOGS}); newest dialogs only`,
        ...success,
      });
    }
    return new HealthReport({ state: "ok", checked_at, ...success });
  }

  backfill(cursor: Cursor | null): Promise<SyncBatch> {
    return this.#advance(cursor, "backfill");
  }

  sync(cursor: Cursor | null): Promise<SyncBatch> {
    return cursor === null
      ? this.#advance(null, "backfill")
      : this.#advance(cursor, "sync");
  }

  async revoke(): Promise<void> {
    const api = this.#api;
    if (api === null) {
      this.#revoked = true;
      return;
    }
    try {
      await api.logOut();
    } catch (error) {
      if (
        !(error instanceof TelegramConnectorError) ||
        error.code !== "unauthenticated"
      ) {
        // Access did not end; do not let the host believe it did.
        await this.#disconnectQuietly(api);
        throw error;
      }
    }
    this.#revoked = true;
    await api.disconnect();
  }

  async purgeSource(subject_id: string): Promise<PurgePlan> {
    return {
      subject_id,
      source_record_ids: [],
      unreachable_source_record_ids: this.#plan.forSubject(subject_id),
    };
  }

  /** Needs no credentials, no network and no connect: the conformance suite runs cold. */
  async fixture(): Promise<CaptureEventInput[]> {
    const events: CaptureEventInput[] = [];
    for (const dialog of FIXTURE_ACCOUNT.dialogs) {
      for (const message of FIXTURE_ACCOUNT.messages[dialog.peer_id] ?? []) {
        const event = mapMessage(
          message,
          dialog,
          FIXTURE_ACCOUNT.me,
          FIXTURE_OBSERVED_AT,
        );
        if (event !== null) events.push(event);
      }
    }
    return events;
  }

  async #advance(
    cursor: Cursor | null,
    mode: "backfill" | "sync",
  ): Promise<SyncBatch> {
    const api = this.#api;
    const self = this.#self;
    if (api === null || self === null) throw notConnected();
    const result = await walk(cursor, mode, {
      api,
      self,
      now: this.#deps.now,
      plan: this.#plan,
    });
    // A pass that listed nothing says nothing about the account's dialogs.
    if (result.listing !== null) {
      this.#dialogLimitReached = result.listing.limitReached;
    }
    if (result.floodUntil !== null) this.#floodUntil = result.floodUntil;
    this.#lastSuccessAt = this.#nowIso();
    return result.batch;
  }

  #nowIso(): string {
    return new Date(this.#deps.now()).toISOString();
  }

  /** The sign-in or connect failure is the useful one; a teardown fault must not mask it. */
  async #disconnectQuietly(api: TelegramApi): Promise<void> {
    try {
      await api.disconnect();
    } catch {
      return;
    }
  }
}

export function createTelegramConnector(
  config: TelegramConnectorConfig,
): TelegramConnector {
  return new TelegramConnector(config);
}

function parseStateRef(config: TelegramConnectorConfig): string | null {
  if (!isPlainObject(config)) {
    throw new TelegramConnectorError(
      "corrupt_state",
      "kizuki.telegram: connector config must be an object",
    );
  }
  const ref = config["state_ref"];
  if (ref === undefined) return null;
  if (typeof ref !== "string" || !STATE_REF.test(ref)) {
    throw new TelegramConnectorError(
      "corrupt_state",
      "kizuki.telegram: connection state reference is not a core-minted ref",
    );
  }
  return ref;
}

function notSignedIn(): TelegramConnectorError {
  return new TelegramConnectorError(
    "missing_session",
    "kizuki.telegram: not signed in; run: kizuki connect telegram",
  );
}

function notConnected(): TelegramConnectorError {
  return new TelegramConnectorError(
    "missing_session",
    "kizuki.telegram: connect() has not been called",
  );
}
