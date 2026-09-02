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
 * The authorization URL is handed to a browser, so it lands in history, in
 * referrer headers and in the provider's access log. Nothing that
 * authenticates the client or the owner may ride along.
 */
const CREDENTIAL_AUTHORIZATION_PARAMS = new Set([
  "client_secret",
  "client_assertion",
  "assertion",
  "password",
  "code",
  "code_verifier",
  "access_token",
  "refresh_token",
  "id_token",
]);

/**
 * The assembled URL also carries values this module generated or joined — the
 * state nonce, the PKCE challenge, the scope list — where a short match is far
 * likelier to be an accident than the credential, and refusing on an accident
 * fails a sign-in for a collision the owner cannot see and cannot reproduce.
 * Installed-app secrets are much longer than this. A field the provider
 * authored gets no such exemption: see refuseSecretInField.
 */
const MIN_GUARDED_SECRET_LENGTH = 8;

/**
 * A value that becomes a query parameter is percent-encoded once on the way
 * into the URL, so a secret already encoded in the provider definition needs
 * two rounds before it reads as itself again.
 */
const SECRET_DECODE_ROUNDS = 2;

const PERCENT_ESCAPE = /%[0-9A-Fa-f]{2}/g;

/**
 * Escapes are decoded one at a time rather than through decodeURIComponent: a
 * malformed sequence elsewhere in the text must not stop the well-formed ones
 * from being read, and a legal value that merely contains a bare `%` must not
 * be refused.
 */
function percentDecoded(text: string): string {
  return text.replace(PERCENT_ESCAPE, (escape) =>
    String.fromCharCode(Number.parseInt(escape.slice(1), 16)),
  );
}

/**
 * Percent-encoding hides a secret from a plain substring test while a browser,
 * a referrer header and the provider's access log all still see it decoded.
 */
function carriesSecret(secret: string, text: string): boolean {
  let form = text;
  for (let round = 0; round <= SECRET_DECODE_ROUNDS; round += 1) {
    if (form.includes(secret)) return true;
    const decoded = percentDecoded(form);
    if (decoded === form) return false;
    form = decoded;
  }
  return false;
}

/**
 * Refusing a parameter name is not enough: a secret carried as somebody else's
 * value, or in the endpoint's own userinfo or path, reaches the same browser
 * history, referrer headers and provider access log.
 */
export function refuseSecret(
  secret: string | undefined,
  text: string,
  where: string,
): void {
  if (secret === undefined || secret.length < MIN_GUARDED_SECRET_LENGTH) return;
  if (carriesSecret(secret, text)) {
    throw new TypeError(`${where} may not carry the client secret`);
  }
}

/**
 * A field the provider authored is judged at every length. Nothing but the
 * provider definition could have put the credential there, so there is no
 * accidental collision to protect and a four-character secret reaches the
 * browser's history exactly as a long one does.
 */
function refuseSecretInField(
  secret: string | undefined,
  text: string,
  where: string,
): void {
  if (secret === undefined || secret.length === 0) return;
  if (carriesSecret(secret, text)) {
    throw new TypeError(`${where} may not carry the client secret`);
  }
}

/**
 * The URL parser reports failure by quoting its whole input, which may carry
 * the installed-app secret or a path the owner never meant to log. Only the
 * name of the field may reach the message.
 */
export function parseEndpoint(endpoint: string, where: string, base?: string): URL {
  try {
    return new URL(endpoint, base);
  } catch {
    throw new TypeError(`${where} is not a URL`);
  }
}

/**
 * `http` is safe only where the response cannot leave the machine, which is
 * also what lets a test drive a real authorization server on a spare port.
 */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * An endpoint core speaks to carries the authorization code, the PKCE verifier
 * and the installed-app secret, and the authorization endpoint is handed
 * straight to the owner's browser. A scheme other than TLS either puts that on
 * the wire in the clear or hands the browser something that is not a request
 * at all, so the refusal comes before any of it is built.
 */
export function assertTransportScheme(endpoint: string, where: string): void {
  const url = parseEndpoint(endpoint, where);
  if (url.protocol === "https:") return;
  if (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)) return;
  throw new TypeError(`${where} must use https, or http on a loopback host`);
}

/**
 * The transport picks the redirect URI, and it is the one value that reaches
 * both the consent screen and the token exchange. A URI off this machine turns
 * the owner's browser into a courier: the provider sends the authorization code
 * to whatever host it names. The only transport in core builds a loopback URI,
 * but the transport is a public seam a provider package supplies, so the URI is
 * judged rather than trusted.
 */
export function assertLoopbackRedirectUri(redirectUri: string): void {
  const url = parseEndpoint(redirectUri, "redirect_uri");
  if (url.protocol !== "http:" || !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new TypeError("redirect_uri must be http on a loopback host");
  }
}

/**
 * The listener interpolates this straight after `host:port`, so anything but a
 * bare rooted path rewrites the redirect URI: `@host/cb` moves the authority
 * to another host and would hand the owner's authorization code to it.
 */
export function assertRedirectPath(path: string): void {
  const probe = parseEndpoint(path, "redirect_path", "http://127.0.0.1:1/");
  if (
    probe.origin !== "http://127.0.0.1:1" ||
    probe.pathname !== path ||
    probe.search.length > 0 ||
    probe.hash.length > 0
  ) {
    throw new TypeError(
      "redirect_path must be a rooted path with no query, fragment or authority",
    );
  }
}

/** Every endpoint of the provider, judged before any of them is used. */
function assertProviderEndpoints(provider: OAuthProvider): void {
  assertTransportScheme(provider.authorization_url, "authorization_url");
  assertTransportScheme(provider.token_url, "token_url");
  if (provider.revocation_url !== undefined) {
    assertTransportScheme(provider.revocation_url, "revocation_url");
  }
  if (provider.redirect_path !== undefined) {
    assertRedirectPath(provider.redirect_path);
  }
}

/** Every provider-authored value that reaches the browser URL verbatim. */
function browserVisibleFields(provider: OAuthProvider): [string, string][] {
  const fields: [string, string][] = [
    ["authorization_url", provider.authorization_url],
    ["client_id", provider.client_id],
  ];
  if (provider.redirect_path !== undefined) {
    fields.push(["redirect_path", provider.redirect_path]);
  }
  for (const [key, value] of Object.entries(
    provider.extra_authorization_params ?? {},
  )) {
    fields.push([`extra_authorization_params.${key}`, value]);
  }
  return fields;
}

/** Everything a browser URL can be judged on before the listener exists. */
export function assertBrowserSafeProvider(provider: OAuthProvider): void {
  assertProviderEndpoints(provider);
  const url = parseEndpoint(provider.authorization_url, "authorization_url");
  // A query already on the endpoint is a parameter nobody reviewed.
  if (url.search.length > 0 || url.hash.length > 0) {
    throw new TypeError(
      "authorization_url may not carry a query or a fragment; put provider extras in extra_authorization_params",
    );
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new TypeError("authorization_url may not carry userinfo credentials");
  }
  for (const [key, value] of Object.entries(
    provider.extra_authorization_params ?? {},
  )) {
    if (FIXED_AUTHORIZATION_PARAMS.has(key)) {
      throw new TypeError(
        `extra_authorization_params may not override the fixed parameter ${key}`,
      );
    }
    if (CREDENTIAL_AUTHORIZATION_PARAMS.has(key)) {
      throw new TypeError(
        `extra_authorization_params may not put the credential ${key} in a browser URL`,
      );
    }
  }
  for (const [where, value] of browserVisibleFields(provider)) {
    refuseSecretInField(provider.client_secret, value, where);
  }
}
