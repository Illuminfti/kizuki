import type { SignInIo } from "../contracts/connector";
import { isNonEmptyString, isPlainObject } from "../util/validate";

export interface OAuthProvider {
  name: string;
  authorization_url: string;
  token_url: string;
  revocation_url?: string;
  client_id: string;
  /** Installed-app secret: not confidential, sent only to token_url/revocation_url. */
  client_secret?: string;
  scopes: string[];
  extra_authorization_params?: Record<string, string>;
  /** Redirect path on the loopback listener; default "/callback". */
  redirect_path?: string;
}

export interface TokenSet {
  access_token: string;
  refresh_token: string | null;
  expires_at: string;
  scope: string;
  token_type: "Bearer";
}

export type OAuthErrorCode =
  | "timeout"
  | "state_mismatch"
  | "provider_error"
  | "invalid_token_response"
  | "transport"
  | "refresh_rejected"
  | "invalid_state"
  | "unauthenticated"
  | "not_supported";

/**
 * Carries a code, the provider label and at most a short sanitised detail.
 * Secrets are structurally excluded: nothing from a callback query, a token
 * response body or the PKCE material may reach `message`, so `String(error)`
 * and `JSON.stringify(error)` are safe to log.
 */
export class OAuthError extends Error {
  override name = "OAuthError";
  readonly code: OAuthErrorCode;
  readonly provider: string;

  constructor(code: OAuthErrorCode, provider: string, detail?: string) {
    const safe = sanitizeDetail(detail);
    super(
      safe === undefined
        ? `${provider}: ${code}`
        : `${provider}: ${code}: ${safe}`,
    );
    this.code = code;
    this.provider = provider;
  }
}

export interface Pkce {
  verifier: string;
  challenge: string;
}

const VERIFIER_BYTES = 32;
const STATE_BYTES = 32;
const MAX_DETAIL_CHARS = 64;
const PRINTABLE_ASCII = /^[\x20-\x7e]+$/;

const FIXED_AUTHORIZATION_PARAMS = new Set([
  "response_type",
  "client_id",
  "redirect_uri",
  "scope",
  "state",
  "code_challenge",
  "code_challenge_method",
]);

/**
 * Only a short printable ASCII fragment of provider-controlled text may reach
 * an error message; everything else is dropped rather than truncated.
 */
function sanitizeDetail(detail: unknown): string | undefined {
  if (typeof detail !== "string") return undefined;
  if (detail.length === 0 || detail.length > MAX_DETAIL_CHARS) return undefined;
  return PRINTABLE_ASCII.test(detail) ? detail : undefined;
}

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function randomOf(
  randomBytes: (length: number) => Uint8Array,
  length: number,
): Uint8Array {
  const bytes = randomBytes(length);
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== length) {
    throw new TypeError(`randomBytes must return ${length} bytes`);
  }
  return bytes;
}

function defaultRandomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

/** base64url(SHA-256(ASCII(verifier))) — RFC 7636 section 4.2. */
export function pkceChallenge(verifier: string): string {
  return base64url(
    new Uint8Array(new Bun.CryptoHasher("sha256").update(verifier).digest()),
  );
}

/** 32 random bytes to a base64url verifier (43 chars); challenge = S256. */
export function buildPkce(
  randomBytes: (length: number) => Uint8Array = defaultRandomBytes,
): Pkce {
  const verifier = base64url(randomOf(randomBytes, VERIFIER_BYTES));
  return { verifier, challenge: pkceChallenge(verifier) };
}

export function buildAuthorizationUrl(
  provider: OAuthProvider,
  params: { redirect_uri: string; state: string; code_challenge: string },
): string {
  const url = new URL(provider.authorization_url);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", provider.client_id);
  url.searchParams.set("redirect_uri", params.redirect_uri);
  url.searchParams.set("scope", provider.scopes.join(" "));
  url.searchParams.set("state", params.state);
  url.searchParams.set("code_challenge", params.code_challenge);
  url.searchParams.set("code_challenge_method", "S256");
  for (const [key, value] of Object.entries(
    provider.extra_authorization_params ?? {},
  )) {
    if (FIXED_AUTHORIZATION_PARAMS.has(key)) {
      throw new TypeError(
        `extra_authorization_params may not override the fixed parameter ${key}`,
      );
    }
    url.searchParams.set(key, value);
  }
  return url.toString();
}

function bodyError(body: unknown): string | undefined {
  if (!isPlainObject(body)) return undefined;
  const value = body["error"];
  return typeof value === "string" ? value : undefined;
}

export function parseTokenResponse(
  provider: OAuthProvider,
  status: number,
  body: unknown,
  now: Date,
  previous?: TokenSet,
): TokenSet {
  if (status !== 200) {
    throw new OAuthError("provider_error", provider.name, bodyError(body));
  }
  const invalid = (): never => {
    throw new OAuthError("invalid_token_response", provider.name);
  };
  if (!isPlainObject(body)) return invalid();

  const accessToken = body["access_token"];
  if (!isNonEmptyString(accessToken)) return invalid();

  const tokenType = body["token_type"];
  if (typeof tokenType !== "string" || tokenType.toLowerCase() !== "bearer") {
    return invalid();
  }

  const expiresIn = body["expires_in"];
  if (typeof expiresIn !== "number" || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    return invalid();
  }

  const rotated = body["refresh_token"];
  let refreshToken: string | null;
  // Only an absent field means "unchanged": an explicit null is a malformed
  // response, not a provider telling us to keep what we have.
  if (rotated === undefined) {
    refreshToken = previous?.refresh_token ?? null;
  } else if (isNonEmptyString(rotated)) {
    refreshToken = rotated;
  } else {
    return invalid();
  }

  const grantedScope = body["scope"];
  if (grantedScope !== undefined && typeof grantedScope !== "string") {
    return invalid();
  }

  // A lifetime large enough to leave the ECMAScript time range would make
  // toISOString throw past this module's error contract.
  const expiresAt = new Date(now.getTime() + expiresIn * 1000);
  if (Number.isNaN(expiresAt.getTime())) return invalid();

  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_at: expiresAt.toISOString(),
    // A refresh that omits the scope granted the same scope as before; falling
    // back to the requested scopes would record a grant the owner never made.
    scope: grantedScope ?? previous?.scope ?? provider.scopes.join(" "),
    token_type: "Bearer",
  };
}

export interface LoopbackListener {
  redirect_uri: string;
  /** Resolves with the first request URL on the redirect path. */
  callback(): Promise<URL>;
  close(): Promise<void>;
}

export interface OAuthTransport {
  listen(redirectPath: string): Promise<LoopbackListener>;
  /** `body` is the parsed JSON document, or null when the response is not JSON. */
  postForm(
    url: string,
    form: Record<string, string>,
  ): Promise<{ status: number; body: unknown }>;
}

export interface SignInOptions {
  timeoutMs?: number;
  now?: () => Date;
  randomBytes?: (length: number) => Uint8Array;
}

const DEFAULT_TIMEOUT_MS = 300_000;

function clientSecretForm(provider: OAuthProvider): Record<string, string> {
  return provider.client_secret === undefined
    ? {}
    : { client_secret: provider.client_secret };
}

/** The only place a transport rejection becomes an error owners may see. */
async function postForm(
  provider: OAuthProvider,
  transport: OAuthTransport,
  url: string,
  form: Record<string, string>,
): Promise<{ status: number; body: unknown }> {
  try {
    return await transport.postForm(url, form);
  } catch (error) {
    if (error instanceof OAuthError) throw error;
    throw new OAuthError(
      "transport",
      provider.name,
      error instanceof Error ? error.name : typeof error,
    );
  }
}

async function withTimeout<T>(
  pending: Promise<T>,
  timeoutMs: number,
  provider: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new OAuthError("timeout", provider)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function signInWithBrowser(
  provider: OAuthProvider,
  io: SignInIo,
  transport: OAuthTransport,
  opts: SignInOptions = {},
): Promise<TokenSet> {
  if (provider.client_id.length === 0) {
    throw new TypeError("OAuth provider is missing a client_id");
  }
  const randomBytes = opts.randomBytes ?? defaultRandomBytes;
  const now = opts.now ?? ((): Date => new Date());
  const pkce = buildPkce(randomBytes);
  const nonce = base64url(randomOf(randomBytes, STATE_BYTES));

  const listener = await transport.listen(provider.redirect_path ?? "/callback");
  try {
    const url = buildAuthorizationUrl(provider, {
      redirect_uri: listener.redirect_uri,
      state: nonce,
      code_challenge: pkce.challenge,
    });
    // Subscribe before the browser opens: a fast provider must not race us.
    const pending = listener.callback();
    io.notify(
      `Sign in to ${provider.name} in your browser. If it did not open, visit:\n${url}`,
    );
    // A hanging or failing opener never blocks a completed sign-in.
    void Promise.resolve()
      .then(() => io.openUrl(url))
      .catch(() => undefined);

    const landed = await withTimeout(
      pending,
      opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      provider.name,
    );

    const returned = landed.searchParams.get("state");
    if (
      returned === null ||
      returned.length !== nonce.length ||
      returned !== nonce
    ) {
      throw new OAuthError("state_mismatch", provider.name);
    }
    const denied = landed.searchParams.get("error");
    if (denied !== null) {
      throw new OAuthError("provider_error", provider.name, denied);
    }
    const code = landed.searchParams.get("code");
    if (code === null || code.length === 0) {
      throw new OAuthError("provider_error", provider.name);
    }

    const response = await postForm(provider, transport, provider.token_url, {
      grant_type: "authorization_code",
      code,
      redirect_uri: listener.redirect_uri,
      client_id: provider.client_id,
      code_verifier: pkce.verifier,
      ...clientSecretForm(provider),
    });
    return parseTokenResponse(provider, response.status, response.body, now());
  } finally {
    await listener.close();
  }
}

export async function refreshTokens(
  provider: OAuthProvider,
  tokens: TokenSet,
  transport: OAuthTransport,
  now: () => Date = () => new Date(),
): Promise<TokenSet> {
  if (tokens.refresh_token === null) {
    throw new OAuthError("refresh_rejected", provider.name);
  }
  const response = await postForm(provider, transport, provider.token_url, {
    grant_type: "refresh_token",
    refresh_token: tokens.refresh_token,
    client_id: provider.client_id,
    ...clientSecretForm(provider),
  });
  if (
    (response.status === 400 || response.status === 401) &&
    bodyError(response.body) === "invalid_grant"
  ) {
    throw new OAuthError("refresh_rejected", provider.name, "invalid_grant");
  }
  return parseTokenResponse(
    provider,
    response.status,
    response.body,
    now(),
    tokens,
  );
}

export async function revokeToken(
  provider: OAuthProvider,
  token: string,
  transport: OAuthTransport,
): Promise<void> {
  const revocationUrl = provider.revocation_url;
  if (revocationUrl === undefined) {
    throw new OAuthError("not_supported", provider.name);
  }
  const response = await postForm(provider, transport, revocationUrl, {
    token,
    client_id: provider.client_id,
    ...clientSecretForm(provider),
  });
  if (response.status === 200) return;
  // A token the provider already dropped is a revoked token.
  if (response.status === 400 && bodyError(response.body) === "invalid_token") {
    return;
  }
  throw new OAuthError(
    "provider_error",
    provider.name,
    bodyError(response.body),
  );
}
