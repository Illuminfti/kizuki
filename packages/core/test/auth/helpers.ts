import type { SignInIo } from "../../src/contracts/connector";
import { OAuthError } from "../../src/auth/oauth";
import type {
  LoopbackListener,
  OAuthProvider,
  OAuthTransport,
  TokenSet,
} from "../../src/auth/oauth";
import type { OAuthState } from "../../src/auth/state";

export const NOW = new Date("2026-03-01T10:00:00.000Z");

export interface RecordedPost {
  url: string;
  form: Record<string, string>;
}

export type ScriptedResponse = { status: number; body: unknown } | Error;

interface Waiter {
  resolve: (url: URL) => void;
  reject: (error: Error) => void;
}

/** In-memory stand-in for the loopback listener; the test plays the browser. */
export class FakeListener implements LoopbackListener {
  readonly redirect_uri: string;
  closed = false;
  received: URL | null = null;
  private readonly waiters: Waiter[] = [];
  private readonly closeError: Error | null;

  constructor(
    redirectPath: string,
    closeError: Error | null = null,
    redirectUri?: string,
  ) {
    this.redirect_uri = redirectUri ?? `http://127.0.0.1:43210${redirectPath}`;
    this.closeError = closeError;
  }

  callback(): Promise<URL> {
    if (this.closed) {
      return Promise.reject(new OAuthError("timeout", "loopback"));
    }
    if (this.received !== null) return Promise.resolve(this.received);
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  async close(): Promise<void> {
    // A listener that cannot be stopped is still listening: it keeps its
    // waiters and still answers callback(), which is what a real port that
    // refused to come down would do.
    if (this.closeError !== null) throw this.closeError;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter.reject(new OAuthError("timeout", "loopback"));
    }
  }

  deliver(query: Record<string, string>): void {
    const url = new URL(this.redirect_uri);
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value);
    }
    if (this.received === null) this.received = url;
    for (const waiter of this.waiters.splice(0)) waiter.resolve(this.received);
  }
}

export class FakeTransport implements OAuthTransport {
  readonly posts: RecordedPost[] = [];
  readonly responses: ScriptedResponse[] = [];
  readonly listeners: FakeListener[] = [];
  /** Set to make every listener this transport hands out fail to shut down. */
  listenerCloseError: Error | null = null;
  /** Set to make every listener report a redirect URI of the test's choosing. */
  listenerRedirectUri: string | null = null;

  constructor(...responses: ScriptedResponse[]) {
    this.responses.push(...responses);
  }

  async listen(redirectPath: string): Promise<LoopbackListener> {
    const listener = new FakeListener(
      redirectPath,
      this.listenerCloseError,
      this.listenerRedirectUri ?? undefined,
    );
    this.listeners.push(listener);
    return listener;
  }

  async postForm(
    url: string,
    form: Record<string, string>,
  ): Promise<{ status: number; body: unknown }> {
    this.posts.push({ url, form: { ...form } });
    const next = this.responses.shift();
    if (next === undefined) throw new Error("no scripted response left");
    if (next instanceof Error) throw next;
    return next;
  }

  /** The browser lands on the redirect URI of the most recent listener. */
  redirect(query: Record<string, string>): void {
    const listener = this.listeners.at(-1);
    if (listener === undefined) throw new Error("no listener to redirect to");
    listener.deliver(query);
  }
}

export interface FakeIo extends SignInIo {
  notifications: string[];
  opened: string[];
  /** Resolves with the URL of the first openUrl call. */
  firstOpen: Promise<string>;
}

export function fakeIo(
  opts: { openUrl?: (url: string) => Promise<void> } = {},
): FakeIo {
  let resolveFirst: (url: string) => void = () => undefined;
  const firstOpen = new Promise<string>((resolve) => {
    resolveFirst = resolve;
  });
  const io: FakeIo = {
    notifications: [],
    opened: [],
    firstOpen,
    prompt: async () => "",
    notify: (text) => {
      io.notifications.push(text);
    },
    openUrl: (url) => {
      io.opened.push(url);
      resolveFirst(url);
      return opts.openUrl === undefined ? Promise.resolve() : opts.openUrl(url);
    },
  };
  return io;
}

export function provider(overrides: Partial<OAuthProvider> = {}): OAuthProvider {
  return {
    name: "fixture",
    authorization_url: "https://provider.invalid/authorize",
    token_url: "https://provider.invalid/token",
    revocation_url: "https://provider.invalid/revoke",
    client_id: "fixture-client",
    scopes: ["read", "profile"],
    ...overrides,
  };
}

export function providerWithoutRevocation(): OAuthProvider {
  const { revocation_url: _dropped, ...rest } = provider();
  return rest;
}

export function tokenResponse(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    access_token: "SENTINEL-ACCESS",
    token_type: "bearer",
    expires_in: 3600,
    refresh_token: "SENTINEL-REFRESH",
    scope: "read profile",
    ...overrides,
  };
}

export function tokenSet(overrides: Partial<TokenSet> = {}): TokenSet {
  return {
    access_token: "SENTINEL-ACCESS",
    refresh_token: "SENTINEL-REFRESH",
    expires_at: "2026-03-01T11:00:00.000Z",
    scope: "read profile",
    token_type: "Bearer",
    ...overrides,
  };
}

/** Deterministic randomness: call n fills every byte with n. */
export function countingRandom(): (length: number) => Uint8Array {
  let calls = 0;
  return (length) => {
    calls += 1;
    return new Uint8Array(length).fill(calls);
  };
}

export function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

export function oauthState(overrides: Partial<OAuthState> = {}): OAuthState {
  return {
    schema: "kizuki.oauth-state/v1",
    provider: "fixture",
    account: { id: "acct-ada", display: "ada@example.invalid" },
    tokens: tokenSet(),
    written_at: "2026-03-01T10:00:00.000Z",
    ...overrides,
  };
}
