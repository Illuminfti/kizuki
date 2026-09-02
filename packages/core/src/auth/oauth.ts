import type { SignInIo } from "../contracts/connector";
import { isRfc3339 } from "../util/time";
import { isNonEmptyString, isPlainObject } from "../util/validate";
import {
  OAuthError,
  asOAuthError,
  transportError,
  withoutSecrets,
} from "./oauth-error";
import { base64url, buildPkce, defaultRandomBytes, randomOf } from "./pkce";
import {
  assertBrowserSafeProvider,
  assertLoopbackRedirectUri,
  assertTransportScheme,
  parseEndpoint,
  refuseSecret,
} from "./provider-guard";
import type { OAuthProvider } from "./provider-guard";

export { OAuthError } from "./oauth-error";
export type { OAuthErrorCode } from "./oauth-error";
export { buildPkce, pkceChallenge } from "./pkce";
export type { Pkce } from "./pkce";
export { assertRedirectPath } from "./provider-guard";
export type { OAuthProvider } from "./provider-guard";

export interface TokenSet {
  access_token: string;
  refresh_token: string | null;
  /** RFC3339, computed from the provider's expires_in when the response parsed. */
  expires_at: string;
  /** The scope the owner granted, not the scope the provider was asked for. */
  scope: string;
  token_type: "Bearer";
}

const STATE_BYTES = 32;

/** Everything one operation could see echoed back at it. */
function operationSecrets(
  provider: OAuthProvider,
  ...rest: (string | null)[]
): string[] {
  const secrets =
    provider.client_secret === undefined ? [] : [provider.client_secret];
  for (const value of rest) {
    if (value !== null) secrets.push(value);
  }
  return secrets;
}

export function buildAuthorizationUrl(
  provider: OAuthProvider,
  params: { redirect_uri: string; state: string; code_challenge: string },
): string {
  assertBrowserSafeProvider(provider);
  const url = parseEndpoint(provider.authorization_url, "authorization_url");
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
    url.searchParams.set(key, value);
  }
  const built = url.toString();
  // The redirect URI is the transport's, so the finished URL is judged once
  // more rather than trusted a piece at a time.
  refuseSecret(provider.client_secret, built, "the authorization URL");
  return built;
}

function bodyError(body: unknown): string | undefined {
  if (!isPlainObject(body)) return undefined;
  const value = body["error"];
  return typeof value === "string" ? value : undefined;
}

/**
 * `previous` is the token set being refreshed. An omitted `refresh_token` or
 * `scope` keeps what it holds, so only a first exchange falls back to the
 * scopes the provider was asked for: a refresh must never record a wider
 * grant than the owner made on the consent screen.
 */
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

  // A lifetime past the ECMAScript time range would make toISOString throw,
  // and one merely past year 9999 makes it emit the expanded form the envelope
  // reader refuses; either way the durable state would be unreadable, so the
  // refusal belongs here rather than a process later.
  const expiresAt = new Date(now.getTime() + expiresIn * 1000);
  if (Number.isNaN(expiresAt.getTime())) return invalid();
  const expiresAtText = expiresAt.toISOString();
  if (!isRfc3339(expiresAtText)) return invalid();

  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_at: expiresAtText,
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

/**
 * An empty secret is a public client spelling "none" the long way. Posting the
 * field with an empty value is not the same request: a provider reads it as an
 * authentication attempt and may reject the exchange for it.
 */
function clientSecretForm(provider: OAuthProvider): Record<string, string> {
  const secret = provider.client_secret;
  return secret === undefined || secret.length === 0
    ? {}
    : { client_secret: secret };
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
    // Even an OAuthError from a transport is untrusted here: it was authored
    // outside this module and its detail may quote the request or the answer.
    throw transportError(error, provider.name);
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
  // Judged before anything is opened: a provider the owner cannot be sent to
  // must not cost a listener, a browser tab or a consent screen.
  assertBrowserSafeProvider(provider);
  const randomBytes = opts.randomBytes ?? defaultRandomBytes;
  const now = opts.now ?? ((): Date => new Date());
  const pkce = buildPkce(randomBytes);
  const nonce = base64url(randomOf(randomBytes, STATE_BYTES));

  const secrets = operationSecrets(provider, pkce.verifier, nonce);

  const listener = await transport.listen(provider.redirect_path ?? "/callback");
  // The transport chose this URI and the provider is about to be told to send
  // the owner's authorization code to it. A refusal is a configuration fault
  // like every other guard here, so it keeps its TypeError rather than being
  // relabelled as something the provider did.
  try {
    assertLoopbackRedirectUri(listener.redirect_uri);
  } catch (error) {
    await listener.close().catch(() => undefined);
    throw error;
  }
  try {
    const url = buildAuthorizationUrl(provider, {
      redirect_uri: listener.redirect_uri,
      state: nonce,
      code_challenge: pkce.challenge,
    });
    // Subscribe before the browser opens: a fast provider must not race us.
    const pending = listener.callback();
    // Nothing observes this promise until the race below reaches it. Closing
    // the listener on a failure path rejects it, and without a handler that
    // rejection would kill the process after the caller handled the error.
    void pending.catch(() => undefined);
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
    secrets.push(code);

    const response = await postForm(provider, transport, provider.token_url, {
      grant_type: "authorization_code",
      code,
      redirect_uri: listener.redirect_uri,
      client_id: provider.client_id,
      code_verifier: pkce.verifier,
      ...clientSecretForm(provider),
    });
    return parseTokenResponse(provider, response.status, response.body, now());
  } catch (error) {
    throw withoutSecrets(asOAuthError(error, provider.name), secrets);
  } finally {
    // A listener that will not shut down must neither displace the failure the
    // caller has to act on nor discard a grant the owner already made: the
    // provider has minted tokens by now and only this process can store them.
    await listener.close().catch(() => undefined);
  }
}

export async function refreshTokens(
  provider: OAuthProvider,
  tokens: TokenSet,
  transport: OAuthTransport,
  now: () => Date = () => new Date(),
): Promise<TokenSet> {
  assertTransportScheme(provider.token_url, "token_url");
  if (tokens.refresh_token === null) {
    throw new OAuthError("refresh_rejected", provider.name);
  }
  const secrets = operationSecrets(
    provider,
    tokens.refresh_token,
    tokens.access_token,
  );
  try {
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
  } catch (error) {
    throw withoutSecrets(asOAuthError(error, provider.name), secrets);
  }
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
  assertTransportScheme(revocationUrl, "revocation_url");
  const secrets = operationSecrets(provider, token);
  try {
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
  } catch (error) {
    throw withoutSecrets(asOAuthError(error, provider.name), secrets);
  }
}
