import type { SignInIo } from "../contracts/connector";
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
  snapshotProvider,
} from "./provider-guard";
import type { OAuthProvider } from "./provider-guard";
import { bodyError, parseTokenResponse } from "./token-response";
import type { TokenSet } from "./token-response";

export { OAuthError } from "./oauth-error";
export type { OAuthErrorCode } from "./oauth-error";
export { buildPkce, pkceChallenge } from "./pkce";
export type { Pkce } from "./pkce";
export { assertRedirectPath } from "./provider-guard";
export type { OAuthProvider } from "./provider-guard";
export { parseTokenResponse } from "./token-response";
export type { TokenSet } from "./token-response";

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
  const definition = snapshotProvider(provider);
  assertBrowserSafeProvider(definition);
  const url = parseEndpoint(definition.authorization_url, "authorization_url");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", definition.client_id);
  url.searchParams.set("redirect_uri", params.redirect_uri);
  url.searchParams.set("scope", definition.scopes.join(" "));
  url.searchParams.set("state", params.state);
  url.searchParams.set("code_challenge", params.code_challenge);
  url.searchParams.set("code_challenge_method", "S256");
  for (const [key, value] of Object.entries(
    definition.extra_authorization_params ?? {},
  )) {
    url.searchParams.set(key, value);
  }
  const built = url.toString();
  // The redirect URI is the transport's, so the finished URL is judged once
  // more rather than trusted a piece at a time.
  refuseSecret(definition.client_secret, built, "the authorization URL");
  return built;
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
  // Nothing below reads the caller's object again: the browser wait between
  // the checks and the token exchange is long enough for it to change.
  const definition = snapshotProvider(provider);
  if (definition.client_id.length === 0) {
    throw new TypeError("OAuth provider is missing a client_id");
  }
  // Judged before anything is opened: a provider the owner cannot be sent to
  // must not cost a listener, a browser tab or a consent screen.
  assertBrowserSafeProvider(definition);
  const randomBytes = opts.randomBytes ?? defaultRandomBytes;
  const now = opts.now ?? ((): Date => new Date());
  const pkce = buildPkce(randomBytes);
  const nonce = base64url(randomOf(randomBytes, STATE_BYTES));

  const secrets = operationSecrets(definition, pkce.verifier, nonce);
  /** Set once the flow has succeeded and only the shutdown can still fail. */
  let closing = false;

  const listener = await transport.listen(definition.redirect_path ?? "/callback");
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
    const url = buildAuthorizationUrl(definition, {
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
      `Sign in to ${definition.name} in your browser. If it did not open, visit:\n${url}`,
    );
    // A hanging or failing opener never blocks a completed sign-in.
    void Promise.resolve()
      .then(() => io.openUrl(url))
      .catch(() => undefined);

    const landed = await withTimeout(
      pending,
      opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      definition.name,
    );

    const returned = landed.searchParams.get("state");
    if (
      returned === null ||
      returned.length !== nonce.length ||
      returned !== nonce
    ) {
      throw new OAuthError("state_mismatch", definition.name);
    }
    const denied = landed.searchParams.get("error");
    if (denied !== null) {
      throw new OAuthError("provider_error", definition.name, denied);
    }
    const code = landed.searchParams.get("code");
    if (code === null || code.length === 0) {
      throw new OAuthError("provider_error", definition.name);
    }
    secrets.push(code);

    const response = await postForm(definition, transport, definition.token_url, {
      grant_type: "authorization_code",
      code,
      redirect_uri: listener.redirect_uri,
      client_id: definition.client_id,
      code_verifier: pkce.verifier,
      ...clientSecretForm(definition),
    });
    const tokens = parseTokenResponse(
      definition,
      response.status,
      response.body,
      now(),
    );
    // A port still answering on 127.0.0.1 after this returns is an open door
    // on the owner's machine that nothing else will close. The grant can be
    // made again; the listener cannot be reclaimed by anyone, so a shutdown
    // that fails has to fail the sign-in with it.
    closing = true;
    await listener.close();
    return tokens;
  } catch (error) {
    const failure = closing
      ? transportError(error, definition.name)
      : asOAuthError(error, definition.name);
    // A shutdown that also fails must not displace the failure the caller has
    // to act on, and it has already been attempted when `closing` is set.
    if (!closing) await listener.close().catch(() => undefined);
    throw withoutSecrets(failure, secrets);
  }
}

export async function refreshTokens(
  provider: OAuthProvider,
  tokens: TokenSet,
  transport: OAuthTransport,
  now: () => Date = () => new Date(),
): Promise<TokenSet> {
  const definition = snapshotProvider(provider);
  assertTransportScheme(definition.token_url, "token_url");
  if (tokens.refresh_token === null) {
    throw new OAuthError("refresh_rejected", definition.name);
  }
  const secrets = operationSecrets(
    definition,
    tokens.refresh_token,
    tokens.access_token,
  );
  try {
    const response = await postForm(definition, transport, definition.token_url, {
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: definition.client_id,
      ...clientSecretForm(definition),
    });
    if (
      (response.status === 400 || response.status === 401) &&
      bodyError(response.body) === "invalid_grant"
    ) {
      throw new OAuthError("refresh_rejected", definition.name, "invalid_grant");
    }
    return parseTokenResponse(
      definition,
      response.status,
      response.body,
      now(),
      tokens,
    );
  } catch (error) {
    throw withoutSecrets(asOAuthError(error, definition.name), secrets);
  }
}

export async function revokeToken(
  provider: OAuthProvider,
  token: string,
  transport: OAuthTransport,
): Promise<void> {
  const definition = snapshotProvider(provider);
  const revocationUrl = definition.revocation_url;
  if (revocationUrl === undefined) {
    throw new OAuthError("not_supported", definition.name);
  }
  assertTransportScheme(revocationUrl, "revocation_url");
  const secrets = operationSecrets(definition, token);
  try {
    const response = await postForm(definition, transport, revocationUrl, {
      token,
      client_id: definition.client_id,
      ...clientSecretForm(definition),
    });
    if (response.status === 200) return;
    // A token the provider already dropped is a revoked token.
    if (response.status === 400 && bodyError(response.body) === "invalid_token") {
      return;
    }
    throw new OAuthError(
      "provider_error",
      definition.name,
      bodyError(response.body),
    );
  } catch (error) {
    throw withoutSecrets(asOAuthError(error, definition.name), secrets);
  }
}
