import {
  OAuthError,
  refreshTokens,
  type OAuthProvider,
  type OAuthTransport,
  type TokenSet,
} from "./oauth";
import { encodeOAuthState, type OAuthState } from "./state";

/** Hands refreshed state back to the trusted host; the session owns no store. */
export type StatePersister = (bytes: Uint8Array) => Promise<void>;

export interface OAuthSessionInit {
  provider: OAuthProvider;
  state: OAuthState;
  transport: OAuthTransport;
  persist: StatePersister;
  now?: () => Date;
  /** Refresh this many seconds before expires_at; default 60. */
  skewSeconds?: number;
}

const DEFAULT_SKEW_SECONDS = 60;

/**
 * A live access token for one connection. Refresh is single-flight so a batch
 * of concurrent requests costs one round trip, and every refreshed envelope
 * is persisted before the caller sees the new token: a rotated refresh token
 * that was not written back would strand the next process.
 */
export class OAuthSession {
  readonly provider: string;
  readonly account: OAuthState["account"];

  private readonly definition: OAuthProvider;
  private readonly transport: OAuthTransport;
  private readonly persist: StatePersister;
  private readonly now: () => Date;
  private readonly skewMs: number;
  private state: OAuthState | null;
  private inFlight: Promise<void> | null = null;

  constructor(init: OAuthSessionInit) {
    this.definition = init.provider;
    this.transport = init.transport;
    this.persist = init.persist;
    this.now = init.now ?? ((): Date => new Date());
    this.skewMs = (init.skewSeconds ?? DEFAULT_SKEW_SECONDS) * 1000;
    this.state = init.state;
    this.provider = init.state.provider;
    this.account = init.state.account;
  }

  private require(): OAuthState {
    if (this.state === null) {
      throw new OAuthError("unauthenticated", this.provider);
    }
    return this.state;
  }

  async accessToken(): Promise<string> {
    const state = this.require();
    const expiresAt = Date.parse(state.tokens.expires_at);
    if (
      Number.isFinite(expiresAt) &&
      expiresAt - this.skewMs > this.now().getTime()
    ) {
      return state.tokens.access_token;
    }
    await this.refresh();
    return this.require().tokens.access_token;
  }

  refresh(): Promise<void> {
    const running = this.inFlight;
    if (running !== null) return running;
    const started = this.exchange().finally(() => {
      this.inFlight = null;
    });
    this.inFlight = started;
    return started;
  }

  private async exchange(): Promise<void> {
    const state = this.require();
    const tokens = await refreshTokens(
      this.definition,
      state.tokens,
      this.transport,
      this.now,
    );
    const next: OAuthState = {
      ...state,
      tokens,
      written_at: this.now().toISOString(),
    };
    // Memory advances first: a persist failure must not leave this process
    // holding a refresh token the provider has already rotated away.
    this.state = next;
    await this.persist(encodeOAuthState(next));
  }

  tokens(): TokenSet {
    return { ...this.require().tokens };
  }

  forget(): void {
    this.state = null;
  }
}
