import {
  HealthReport,
  freezeManifest,
  isPlainObject,
  policyForConnector,
} from "@kizuki/core";
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
  StatePersister,
} from "@kizuki/core";
import { TelegramConnectorError } from "./api";
import type { TelegramApi, TelegramUser } from "./api";
import { appCredentials } from "./app-credentials";
import { createRealApi } from "./client";
import {
  TELEGRAM_CONNECTOR_ID,
  TELEGRAM_CONNECTOR_VERSION,
  mapMessage,
} from "./map";
import { degradedDetail } from "./degraded";
import { PurgeIndex } from "./plan";
import { FIXTURE_OBSERVED_AT, fixtureAccount } from "./fixture";
import { notConnected, notSignedIn, revoked } from "./refusals";
import { disconnectQuietly, openSession } from "./session";
import type { SessionDeps } from "./session";
import { enroll, waitSeconds } from "./sign-in";
import { encodeState, type TelegramState } from "./state";
import { TELEGRAM_CURSOR_SCHEMA } from "./cursor";
import { walk } from "./walk";
import type { DialogListing } from "./walk";

export { TELEGRAM_CONNECTOR_ID };

/** Mirrors `stateRefFor` in core: the connector only ever asks for its own ref. */
const STATE_REF = /^file:connections\/[0-9A-HJKMNPQRSTVWXYZ]{26}\.state$/;

export interface TelegramConnectorConfig {
  /** The connection's single secret_ref, once the owner has signed in. */
  state_ref?: string;
}

export interface TelegramDeps extends SessionDeps {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  persist: StatePersister;
}

const MANIFEST: Manifest = freezeManifest({
  schema: "kizuki.connector/v1",
  connector_id: TELEGRAM_CONNECTOR_ID,
  version: TELEGRAM_CONNECTOR_VERSION,
  contract_minor: 1,
  implementation: "@kizuki/connector-telegram",
  allowed_egress: ["telegram.org"],
  cursor_schema: TELEGRAM_CURSOR_SCHEMA,
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
  ...policyForConnector(TELEGRAM_CONNECTOR_ID),
  auth_modes: ["sign_in"],
});

export class TelegramConnector implements Connector {
  readonly #stateRef: string | null;
  readonly #deps: TelegramDeps;
  readonly #plan = new PurgeIndex();
  #api: TelegramApi | null = null;
  #self: TelegramUser | null = null;
  #floodUntil = 0;
  #listing: DialogListing | null = null;
  #revoked = false;
  #closed = false;
  #closing: Promise<void> | null = null;
  #state: TelegramState | null = null;
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
      persist: deps.persist ?? (async () => { throw new Error("state persister unavailable"); }),
    };
  }

  manifest(): Manifest {
    return MANIFEST;
  }

  signIn(io: SignInIo, state: ConnectionStateWriter): Promise<SignInDisplay> {
    this.#assertOpen();
    return enroll(this.#deps, io, state);
  }

  async connect(resolve: SecretResolver): Promise<void> {
    // Revocation is terminal for the instance, not a state to reconnect out
    // of: whatever the stored ref still resolves to, this connector was told
    // its access ended.
    this.#assertOpen();
    if (this.#revoked) throw revoked();
    const ref = this.#stateRef;
    if (ref === null) throw notSignedIn();
    if (this.#deps.now() < this.#floodUntil) throw this.#waiting();
    const opened = await openSession(this.#deps, ref, resolve, { now: this.#deps.now, onState: state => { this.#state = state; }, onFlood: seconds => this.#recordFlood(this.#deps.now() + seconds * 1000) });
    if (this.#closed) { await disconnectQuietly(opened.api); this.#assertOpen(); }
    // Re-authentication keeps the same connection, so a second connect
    // supersedes the first: hand its client back rather than abandon a live
    // one for the life of the process. Only once the replacement is proven.
    const superseded = this.#api;
    if (superseded !== null && superseded !== opened.api) {
      await disconnectQuietly(superseded);
    }
    this.#api = opened.api;
    this.#self = opened.self;
    this.#listing = null;
    this.#lastSuccessAt = this.#nowIso();
  }

  async health(): Promise<HealthReport> {
    this.#assertOpen();
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
      const authorized = await api.isAuthorized();
      this.#assertOpen();
      if (!authorized) {
        return new HealthReport({
          state: "unauthenticated",
          checked_at,
          detail: "the stored session is no longer authorized",
          ...success,
        });
      }
    } catch (error) {
      this.#assertOpen();
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
        await this.#recordFlood(this.#deps.now() + seconds * 1000);
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
    if (this.#revoked) return;
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
        await disconnectQuietly(api);
        throw error;
      }
    }
    // The data path goes with the access: leaving the client in place would
    // let a later batch keep reading from a connection the owner ended, and a
    // teardown that faults must not leave the instance holding a client it
    // has already told the host is gone.
    this.#revoked = true;
    this.#api = null;
    this.#self = null;
    this.#listing = null;
    await disconnectQuietly(api);
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
    this.#assertOpen();
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
      api: {
        dialogs: limit => this.#guardIteration(() => api.dialogs(limit)),
        messages: (peer, query) => this.#guardIteration(() => api.messages(peer, query)),
      },
      self,
      now: this.#deps.now,
      plan: this.#plan,
      dialogs: this.#listing?.dialogs ?? null,
    });
    this.#assertOpen();
    // A pass that listed nothing says nothing about the account's dialogs.
    if (result.listing !== null) this.#listing = result.listing;
    if (result.floodUntil === null) {
      this.#lastSuccessAt = this.#nowIso();
      return result.batch;
    }
    // The pass stopped where the provider told it to, not where it meant to:
    // that instant is the last failure, not the last success.
    await this.#recordFlood(result.floodUntil);
    // A batch is worth handing back mid-wait when the pass actually moved:
    // records collected, or pages read past ids that will not be asked for
    // again. Dropping the second kind is what makes a dialog whose leading
    // history emits nothing unreadable — no checkpoint is ever written, and
    // every run spends the wait re-reading the same pages. A pass that moved
    // nothing goes back with the wait instead, because an empty batch that
    // moved no cursor either reads as a drained account.
    const moved = result.batch.events.length > 0 || result.read > 0;
    const resumable =
      moved && result.batch.cursor !== null && result.batch.cursor !== cursor;
    if (!resumable) throw this.#waiting();
    return result.batch;
  }

  async *#guardIteration<T>(create: () => AsyncIterable<T>): AsyncGenerator<T> {
    this.#assertOpen();
    const iterator = create()[Symbol.asyncIterator]();
    try {
      for (;;) {
        this.#assertOpen();
        const next = await iterator.next();
        this.#assertOpen();
        if (next.done) return;
        yield next.value;
      }
    } finally { await iterator.return?.(); }
  }

  #assertOpen(): void { if (this.#closed) throw new TelegramConnectorError("closed", "kizuki.telegram: connector is closed"); }

  async #recordFlood(until: number): Promise<void> {
    this.#assertOpen();
    this.#floodUntil = Math.max(this.#floodUntil, until);
    try {
      if (this.#state === null || !Number.isSafeInteger(this.#floodUntil) || this.#floodUntil > 253402300799999) throw new Error("invalid cooldown");
      const next = { ...this.#state, retry_not_before: new Date(this.#floodUntil).toISOString() };
      await this.#deps.persist(encodeState(next));
      this.#state = next;
    } catch {
      throw new TelegramConnectorError("state_persistence_failed", "kizuki.telegram: provider cooldown could not be saved; stop this source and repair connection state before retrying");
    }
  }

  /** Terminal transport cleanup only; never logs out the provider session. */
  async close(): Promise<void> {
    if (this.#closing !== null) return this.#closing;
    this.#closed = true;
    const api = this.#api; this.#api = null; this.#self = null; this.#listing = null;
    this.#closing = api === null ? Promise.resolve() : api.disconnect();
    return this.#closing;
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
