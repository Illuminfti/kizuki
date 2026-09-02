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
import { TelegramConnectorError, redactedCause } from "./api";
import type { AppCredentials, TelegramApi, TelegramApiFactory, TelegramUser } from "./api";
import { appCredentials, requireAppCredentials } from "./app-credentials";
import { createRealApi } from "./client";
import {
  TELEGRAM_CONNECTOR_ID,
  TELEGRAM_CONNECTOR_VERSION,
  mapMessage,
  userDisplay,
} from "./map";
import { degradedDetail } from "./degraded";
import { PurgeIndex } from "./plan";
import { FIXTURE_OBSERVED_AT, fixtureAccount } from "./fixture";
import { PHONE_FORMAT, runSignIn, terminalSafe, waitSeconds } from "./sign-in";
import { TELEGRAM_STATE_SCHEMA, encodeState, parseState } from "./state";
import { walk } from "./walk";
import type { DialogListing } from "./walk";

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
  #listing: DialogListing | null = null;
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
    // The label is printed, so it is sanitised; the same name reaches the
    // ledger through the mapper untouched, where it is evidence.
    const label = terminalSafe(userDisplay(me));
    return { display: label.length === 0 ? `user ${me.id}` : label };
  }

  async connect(resolve: SecretResolver): Promise<void> {
    // Revocation is terminal for the instance, not a state to reconnect out
    // of: whatever the stored ref still resolves to, this connector was told
    // its access ended.
    if (this.#revoked) throw revoked();
    const ref = this.#stateRef;
    if (ref === null) throw notSignedIn();
    let text: string;
    try {
      text = await resolve(ref);
    } catch (error) {
      // The resolver failed over the state file, so its own report may name
      // the bytes it was reading. Only the shape of that failure is safe to
      // carry.
      throw new TelegramConnectorError(
        "missing_session",
        "kizuki.telegram: not signed in; run: kizuki connect telegram",
        { cause: redactedCause(error) },
      );
    }
    const state = parseState(text);
    const credentials = requireAppCredentials(this.#deps.credentials);
    const api = this.#deps.api(state.session, credentials);
    let me: TelegramUser;
    try {
      await api.connect();
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
      // Nothing the replacement did is worth the connection already in hand:
      // a reconnect that could not prove itself leaves the working client in
      // place rather than trading it for none at all.
      await this.#disconnectQuietly(api);
      throw error;
    }
    // Re-authentication keeps the same connection, so a second connect
    // supersedes the first: hand its client back rather than abandon a live
    // one for the life of the process. Only once the replacement is proven.
    const superseded = this.#api;
    if (superseded !== null && superseded !== api) {
      await this.#disconnectQuietly(superseded);
    }
    this.#api = api;
    this.#self = me;
    this.#listing = null;
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
      if (
        error instanceof TelegramConnectorError &&
        error.code === "unauthenticated"
      ) {
        return new HealthReport({
          state: "unauthenticated",
          checked_at,
          detail: "the stored session is no longer authorized",
          ...success,
        });
      }
      const seconds = waitSeconds(error);
      if (seconds !== null) {
        // Telegram answered the probe by asking for a pause. Recording it is
        // what keeps the next batch from spending a request into the same
        // wait, and calling throttling an outage would send `doctor` looking
        // for a fault there is none of.
        this.#floodUntil = this.#deps.now() + seconds * 1000;
        return new HealthReport({
          state: "rate_limited",
          checked_at,
          detail: `retry after ${seconds}s`,
          ...success,
        });
      }
      return new HealthReport({
        state: "unreachable",
        checked_at,
        detail: "telegram did not answer the authorization probe",
        ...success,
      });
    }
    const degraded = degradedDetail(this.#listing);
    if (degraded !== null) {
      return new HealthReport({
        state: "degraded",
        checked_at,
        detail: degraded,
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
    // Nothing here reached Telegram, so the session is still live there. A
    // quiet success would have the host record an access that never ended.
    if (api === null) throw notConnected();
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
    // The data path goes with the access: leaving the client in place would
    // let a later batch keep reading from a connection the owner ended.
    this.#api = null;
    this.#self = null;
    this.#listing = null;
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
    // A copy, not the module's own account: the account and the scripted
    // client that edits it are both exported, and the sample the conformance
    // suite measures against cannot be something a caller can move.
    const account = fixtureAccount();
    const events: CaptureEventInput[] = [];
    for (const dialog of account.dialogs) {
      for (const message of account.messages[dialog.peer_id] ?? []) {
        const event = mapMessage(
          message,
          dialog,
          account.me,
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
    if (this.#revoked) throw revoked();
    const api = this.#api;
    const self = this.#self;
    if (api === null || self === null) throw notConnected();
    if (this.#deps.now() < this.#floodUntil) {
      // Telegram asked for a pause, and spending a request to be told so again
      // is how a wait becomes a longer one. The caller is told what it is
      // waiting for rather than handed an empty batch, which is this
      // connector's word for an account with nothing left to give.
      throw this.#waiting();
    }
    const result = await walk(cursor, mode, {
      api,
      self,
      now: this.#deps.now,
      plan: this.#plan,
      dialogs: this.#listing?.dialogs ?? null,
    });
    // A pass that listed nothing says nothing about the account's dialogs.
    if (result.listing !== null) this.#listing = result.listing;
    if (result.floodUntil === null) {
      this.#lastSuccessAt = this.#nowIso();
      return result.batch;
    }
    // The pass stopped where the provider told it to, not where it meant to:
    // that instant is the last failure, not the last success.
    this.#floodUntil = result.floodUntil;
    // A batch whose cursor did not move cannot be resumed from, so returning
    // it would leave a runner to choose between reading the same records for
    // ever and calling honest backpressure a broken connector. The records go
    // back with the wait; they are still there to be read once it lapses.
    if (result.batch.cursor === null || result.batch.cursor === cursor) {
      throw this.#waiting();
    }
    return result.batch;
  }

  /** The pause still in force, as the error a caller can act on. */
  #waiting(): TelegramConnectorError {
    const seconds = Math.ceil((this.#floodUntil - this.#deps.now()) / 1000);
    return new TelegramConnectorError(
      "flood_wait",
      `kizuki.telegram: telegram asked us to wait ${seconds}s`,
      { retry_after: seconds },
    );
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

function revoked(): TelegramConnectorError {
  return new TelegramConnectorError(
    "unauthenticated",
    "kizuki.telegram: access was revoked; sign in again",
  );
}

function notConnected(): TelegramConnectorError {
  return new TelegramConnectorError(
    "missing_session",
    "kizuki.telegram: connect() has not been called",
  );
}
