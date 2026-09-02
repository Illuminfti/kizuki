# Lane: oauth-core — PKCE + loopback sign-in helper in core; OAuth tokens live only in host-minted connection state

Reconciled against `main` @ `76930db` (2026-09-02). Every path, symbol and
flag below was grepped on that revision; anything not on main is marked NEW
with its intended location.

Packages: `packages/core` (NEW `src/auth/`, NEW `src/errors.ts`, edits to
`src/ledger/connection-state.ts` and `src/index.ts`), `packages/connectors`
(`src/errors.ts` becomes a re-export; no behaviour change), `scripts/`
(`verify-network.ts` gains an allowlist; NEW `scripts/network-allowlist.txt`),
one sentence in the root `README.md`. No CLI verbs. No provider package (the
Google connector is the sibling lane `connector-google.md`, which depends on
this one; X and WHOOP later reuse the same helper).

Read first, in order: `CONVENTIONS.md`; `docs/architecture.md` (invariants 6
and 8, the "Sign-in, not setup" paragraph under kizuki.connector/v1);
`rfcs/0000-constraints.md` §8–9; `packages/core/AGENTS.md`;
`packages/core/src/contracts/connector.ts` (`AUTH_MODES`, `SignInIo`,
`SignInDisplay`, `ConnectionStateWriter`, `SecretResolver`, `Connector.signIn`);
`packages/core/src/ledger/connection-state.ts` (all of it:
`ConnectionStateStore.begin/save/discard/recover/read/replace`,
`enrollConnection`); `packages/core/src/ledger/connections.ts`;
`packages/core/test/connections.test.ts` (the fixture-connector and
temp-dir test shape to match); `packages/core/src/util/hash.ts`
(`Bun.CryptoHasher`); `packages/core/src/util/time.ts` (`isRfc3339`);
`scripts/verify-network.ts` + `scripts/verify-network.test.ts`;
`scripts/verify.sh`; `packages/connectors/src/errors.ts`,
`packages/connectors/src/conformance.ts`. Plan reference:
`workspace/kizuki-plan/ARCHITECTURE.md` §3.1 (sign-in, not setup; OAuth via
PKCE + loopback listener, core helper `auth/oauth.ts`), §10 (secrets:
`secret_ref` only; nothing plaintext in SQLite), §12 (zero-network test).
Where the plan still says `signIn(io, secretsDir)`, main wins.

Sibling lanes this spec is aligned with (read them before starting; if
one has landed, build on its code instead of re-creating it):
`ci-hardening.md` §3 (`packages/core/src/app-credentials.ts`, the one door for
compiled-in app credentials) and §4 (the allowlist format and scanner API —
§8 below is identical plus one delta); `connector-telegram.md` §4 (the
host→connector state hand-off convention `{ state_ref }` + `connect(resolve)`),
§7 (`runToCompletion`), §9 (the README pledge sentence — §10 below merges it).

## Already on main (do not re-implement)

- `AUTH_MODES = ["none","sign_in","oauth","secret_ref"]`, `Manifest.auth_modes`,
  `SignInIo { prompt, notify, openUrl }`, `SignInDisplay { display }`,
  `ConnectionStateWriter { write(bytes) }`, optional
  `Connector.signIn(io, state)`; conformance refuses a manifest whose
  `auth_modes` and `signIn` disagree (`packages/connectors/src/conformance.ts`).
- The opaque-state store: `ConnectionStateStore(controlDirectory)` writes
  `<control>/connections/<ulid>.state` at 0600 (directory 0700) through a
  one-shot writer, journaled atomic swap, `recover()`, `read()`, `replace()`
  (interactive re-sign-in keeping the source key) and
  `enrollConnection(db, store, connector, io)`. The `connections` table
  (schema v2, `packages/core/src/ledger/db.ts`) only admits the two fixed
  config envelopes and the single ref `file:connections/<source_key>.state`;
  tests prove raw SQLite never contains state bytes. `source_key` is a
  core-minted ULID. The control directory the CLI lanes pass is
  `<vault>/.kizuki` (gitignored by `initVault`'s `.kizuki/.gitignore`).
- `isSecretRef` / `parseSecretRef` (`env:` and `file:` only);
  `SecretResolver = (secret_ref) => Promise<string>`.
- `scripts/verify-network.ts`: AST scan of every tracked `packages/**/*.{ts,…}`
  (tests included) for `fetch`, `Bun.serve`, `Bun.connect`, `WebSocket`,
  `EventSource`, `XMLHttpRequest`, `node:http`/`net`/`tls`/`dns`… imports, run
  by `scripts/verify.sh` (CI). It has no allowlist today, so nothing under
  `packages/` may name the network until §8 lands.
- `content_hash` excludes `observed_at` (`packages/core/src/util/hash.ts`).

Dropped from the previous version of this spec because main superseded it:
`saveTokens` / `loadTokens(secretsDir, …)` and `file:` secret refs for
tokens (tokens are opaque bytes the trusted host stores; connector code never
sees a path); `signIn(io, secretsDir)` and a connector-returned
`{ source_key, config, secret_refs }` (core mints all three; `signIn` returns
`{ display }` only); `contracts/connector.ts` at the repo root (it is
`packages/core/src/contracts/connector.ts`); `scripts/check-no-network.sh`
(the gate is `scripts/verify-network.ts`); `packages/connector-telegram` "if it
exists on this branch" (it does not exist on main).

## Objective

`kizuki connect <oauth-connector>` must be: the browser opens on the
provider's consent screen, the owner clicks allow, the terminal prints
`connected …`. No developer console, no client id pasted, no token in
SQLite, logs, errors or fixtures. This lane ships the reusable core so that
Google (sibling lane), X and WHOOP (later lanes) are each a provider
definition plus a mapping layer:

1. RFC 7636 PKCE (S256) + RFC 6749 authorization-code flow against a loopback
   redirect listener on `127.0.0.1`, zero dependencies.
2. A token envelope (`kizuki.oauth-state/v1`) written ONLY through the
   `ConnectionStateWriter` the host lends at sign-in, and read back only
   through the host's `SecretResolver` over `ConnectionStateStore.read`.
3. Token refresh during backfill/sync, with the refreshed envelope persisted
   through a host-minted writer scoped to the same connection
   (`ConnectionStateStore.rewrite`), so refresh-token rotation (X rotates on
   every refresh) survives a process boundary.
4. The network scanner learns a per-file allowlist so the call sites this
   design needs are declared, reviewed and stale-checked.

## 1. Module map (`packages/core/src/`)

```
auth/oauth.ts       PKCE, state nonce, authorization URL, token-response parsing,
                    signInWithBrowser, refreshTokens, revokeToken, OAuthError.  Pure.
auth/loopback.ts    loopbackTransport(): the ONLY file in core allowed to call
                    Bun.serve and fetch (allowlisted, §8).
auth/state.ts       kizuki.oauth-state/v1 envelope: encodeOAuthState / parseOAuthState.
auth/session.ts     OAuthSession: access token with refresh + persistence.
auth/index.ts       re-exports.
errors.ts           KizukiError moves here from packages/connectors (§7).
ledger/connection-state.ts   + rewrite(), + createStatePersister().
```

Keep every file under ~400 lines. No `any`, no `as unknown as`, no `// @ts-ignore`.

## 2. `auth/oauth.ts`

```ts
export interface OAuthProvider {
  name: string; // free label stored in the state envelope, e.g. "google"
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
  expires_at: string; // RFC3339, computed from expires_in at parse time
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

export class OAuthError extends Error {
  override name = "OAuthError";
  readonly code: OAuthErrorCode;
  readonly provider: string;
  constructor(code: OAuthErrorCode, provider: string, detail?: string);
}

export interface Pkce {
  verifier: string;
  challenge: string;
}

/** 32 random bytes → base64url verifier (43 chars); challenge = S256. */
export function buildPkce(randomBytes?: (length: number) => Uint8Array): Pkce;
/** base64url(SHA-256(ASCII(verifier))) — RFC 7636 §4.2. */
export function pkceChallenge(verifier: string): string;

export function buildAuthorizationUrl(
  provider: OAuthProvider,
  params: { redirect_uri: string; state: string; code_challenge: string },
): string;

export function parseTokenResponse(
  provider: OAuthProvider,
  status: number,
  body: unknown,
  now: Date,
  previous?: TokenSet,
): TokenSet;

export interface LoopbackListener {
  redirect_uri: string; // http://127.0.0.1:<port><redirect_path>
  callback(): Promise<URL>; // first request URL on redirect_path; rejects after close()
  close(): Promise<void>;
}

export interface OAuthTransport {
  listen(redirectPath: string): Promise<LoopbackListener>;
  postForm(
    url: string,
    form: Record<string, string>,
  ): Promise<{ status: number; body: unknown }>; // body = parsed JSON, or null when not JSON
}

export interface SignInOptions {
  timeoutMs?: number; // default 300_000
  now?: () => Date;
  randomBytes?: (length: number) => Uint8Array;
}

export async function signInWithBrowser(
  provider: OAuthProvider,
  io: SignInIo,
  transport: OAuthTransport,
  opts?: SignInOptions,
): Promise<TokenSet>;

export async function refreshTokens(
  provider: OAuthProvider,
  tokens: TokenSet,
  transport: OAuthTransport,
  now?: () => Date,
): Promise<TokenSet>;

export async function revokeToken(
  provider: OAuthProvider,
  token: string,
  transport: OAuthTransport,
): Promise<void>;
```

Behaviour, exactly:

- `buildPkce`: `randomBytes` defaults to `crypto.getRandomValues`. Verifier is
  base64url without padding of 32 bytes (43 characters from `[A-Za-z0-9_-]`).
  `pkceChallenge` uses `new Bun.CryptoHasher("sha256").update(verifier).digest()`
  → base64url without padding. RFC 7636 Appendix B: verifier
  `dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk` → challenge
  `E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM` (verified on this box with
  Bun 1.3.14).
- `buildAuthorizationUrl`: query = `response_type=code`, `client_id`,
  `redirect_uri`, `scope` (space-joined), `state`, `code_challenge`,
  `code_challenge_method=S256`, then `extra_authorization_params` (an extra
  may not override the seven fixed keys: throw `TypeError`). The
  `client_secret` never appears in a URL.
- `parseTokenResponse`: `status !== 200` → `OAuthError("provider_error", name, <body.error when it is a string of ≤ 64 printable ASCII chars>)`;
  the body is never echoed otherwise. Requires `access_token` non-empty
  string, `token_type` string equal to `bearer` case-insensitively
  (normalised to `"Bearer"`), `expires_in` finite number > 0. `refresh_token`
  optional string; when absent → `previous?.refresh_token ?? null` (a refresh
  response may omit it; a rotating provider sends a new one and the new one
  wins). `scope` optional string, default `provider.scopes.join(" ")`.
  Anything else → `OAuthError("invalid_token_response")`. `expires_at =
new Date(now.getTime() + expires_in * 1000).toISOString()`.
- `signInWithBrowser`:
  1. `client_id` empty → `TypeError` (placeholder detection with the exact
     owner-facing message is the connector's job via
     `appCredentialRefusal(group)`; core only refuses to run without an id).
  2. `pkce = buildPkce(opts.randomBytes)`; `state = base64url(32 random bytes)`.
  3. `listener = await transport.listen(provider.redirect_path ?? "/callback")`.
  4. `url = buildAuthorizationUrl(...)`; `pending = listener.callback()`
     (subscribe BEFORE opening the browser);
     `io.notify(`Sign in to ${provider.name} in your browser. If it did not open, visit:\n${url}`)`;
     `io.openUrl(url)` is started and its rejection ignored — a hanging or
     failing opener never blocks a completed sign-in.
  5. `await Promise.race([pending, timeout])`; timeout → `OAuthError("timeout")`.
  6. Validate the callback URL: `state` must equal the nonce (length check,
     then exact comparison) else `state_mismatch`; `error` param present →
     `provider_error` carrying that `error` value only (≤ 64 printable ASCII
     chars; nothing else from the query); no `code` → `provider_error`.
  7. `transport.postForm(token_url, { grant_type: "authorization_code", code,
redirect_uri: listener.redirect_uri, client_id, code_verifier,
...(client_secret ? { client_secret } : {}) })` → `parseTokenResponse`.
  8. `finally { await listener.close() }` on every path.
- `refreshTokens`: `tokens.refresh_token === null` → `OAuthError("refresh_rejected")`
  without a request. `postForm(token_url, { grant_type: "refresh_token",
refresh_token, client_id, ...client_secret })`; status 400/401 with
  `body.error === "invalid_grant"` → `refresh_rejected`; other non-200 →
  `provider_error`; 200 → `parseTokenResponse(..., previous = tokens)`.
- `revokeToken`: no `revocation_url` → `OAuthError("not_supported")`.
  `postForm(revocation_url, { token, client_id, ...client_secret })`; 200 →
  done; 400 with `body.error === "invalid_token"` → done (already revoked);
  otherwise `provider_error`.
- Transport failures (`postForm` rejecting) surface as `OAuthError("transport")`
  carrying only the underlying error's `name` (never a URL, never a body).
- Redaction rule (tested): no `OAuthError.message`, `String(error)` or
  `JSON.stringify(error)` may contain the verifier, the state nonce, the
  code, an access token or a refresh token.

## 3. `auth/loopback.ts` — the transport (allowlisted network file)

```ts
export function loopbackTransport(opts?: {
  postTimeoutMs?: number;
}): OAuthTransport;
```

- `listen(path)`: `Bun.serve({ hostname: "127.0.0.1", port: 0, fetch })`
  (port 0 = ephemeral; Google installed-app clients accept any loopback
  port). `redirect_uri = \`http://127.0.0.1:${server.port}${path}\``.
  Requests: `GET <path>` → 200 `text/html; charset=utf-8` with the fixed body
  `<!doctype html><title>Kizuki</title><p>Sign-in received. You can close this tab and return to the terminal.</p>`
  — never reflects the query string; every other method/path → 404 with an
  empty body. The first `GET <path>` resolves `callback()` with the request
  URL; later ones get the same page and are ignored. `close()` awaits
  `server.stop(true)`; a pending `callback()` then rejects with
  `OAuthError("timeout")`.
- `postForm(url, form)`: `fetch(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: new URLSearchParams(form), signal: AbortSignal.timeout(postTimeoutMs ?? 30_000), redirect: "error" })`;
  response text capped at 1 MiB (beyond → `OAuthError("transport")`);
  `body` = `JSON.parse(text)` or `null` when parsing fails. Never logs.

This file and its socket test are the only entries core adds to
`scripts/network-allowlist.txt` (§8).

## 4. `auth/state.ts` — the envelope the writer stores

```ts
export const OAUTH_STATE_SCHEMA = "kizuki.oauth-state/v1" as const;

export interface OAuthState {
  schema: typeof OAUTH_STATE_SCHEMA;
  provider: string; // OAuthProvider.name
  account: { id: string; display: string }; // provider-stable account id (Google `sub`), human label (email)
  tokens: TokenSet;
  written_at: string; // RFC3339
}

export function encodeOAuthState(state: OAuthState): Uint8Array; // UTF-8 JSON, keys in the order above
export function parseOAuthState(
  source: Uint8Array | string,
  provider: string,
): OAuthState;
```

`parseOAuthState` accepts the raw bytes (`ConnectionStateStore.read`) or
their UTF-8 text (what a host `SecretResolver` returns, see §6) and fails
closed with `OAuthError("invalid_state", provider)` on: not UTF-8 JSON
object, wrong `schema`, `provider` mismatch, non-string / empty `account.id`
or `account.display`, tokens not matching `TokenSet` (`refresh_token` must be
`string | null`, `expires_at` and `written_at` must pass `isRfc3339`,
`token_type` must be `"Bearer"`), any extra top-level key.
`encodeOAuthState` throws `RangeError` when the result exceeds
`MAX_CONNECTION_STATE_BYTES`. These bytes go ONLY into a
`ConnectionStateWriter`; nothing else in the tree may write them to disk or
SQLite (the existing "raw SQLite never contains state bytes" test is
extended to cover tokens, §11). This envelope carries no `connector_id` key
and a schema other than the CLI lanes' host envelope, which is how
cli-wave2's `connectorFor` tells connector-authored state from host state
(connector-telegram §4).

## 5. `auth/session.ts` — refresh + persistence

```ts
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

export class OAuthSession {
  readonly provider: string;
  readonly account: OAuthState["account"];
  constructor(init: OAuthSessionInit);
  /** Valid bearer token; refreshes (single-flight) when within skew of expiry. */
  accessToken(): Promise<string>;
  /** Force a refresh; persists the new envelope before resolving. */
  refresh(): Promise<void>;
  /** Snapshot of the current tokens (for revocation). */
  tokens(): TokenSet;
  /** Drop tokens from memory; accessToken() then throws OAuthError("unauthenticated"). */
  forget(): void;
}
```

- `accessToken()`: after `forget()` → `OAuthError("unauthenticated")`. If
  `Date.parse(expires_at) - skew*1000 > now` → return the token; else
  `refresh()` and return the new one. Concurrent callers share one in-flight
  refresh (exactly one `postForm` for N simultaneous `accessToken()` calls).
- `refresh()`: `tokens = await refreshTokens(...)` → replace in memory →
  `await persist(encodeOAuthState({ ...state, tokens, written_at: now }))`.
  A persist failure propagates (the run must fail visibly: a rotated refresh
  token that was not persisted would strand the next process); the in-memory
  tokens stay replaced so the current process keeps working.
- A connector builds the session in `connect(resolve)` from the state text
  the host resolver returns and the `persist` the host lends (§6); the
  session never touches the store itself.

## 6. `ledger/connection-state.ts` additions, and the host contract

```ts
export class ConnectionStateStore {
  // existing members unchanged …

  /**
   * Non-interactive state replacement for the same source: token refresh,
   * rotation. Same preconditions as replace(); the connection must already
   * hold state. `update` receives a one-shot writer scoped to this source.
   */
  rewrite(
    db: Database,
    connection: Connection,
    update: (writer: ConnectionStateWriter) => Promise<void>,
  ): Promise<Connection>;
}

export interface StatePersisterHandle {
  persist: StatePersister; // serialised: calls run one after another, never concurrently
  current(): Connection; // the Connection after the latest successful rewrite
}

export function createStatePersister(
  db: Database,
  store: ConnectionStateStore,
  connection: Connection,
): StatePersisterHandle;
```

- Implement `rewrite` and the existing `replace` over one private helper
  (`swap(db, connection, update, missingStateMessage)`): `recover(db)` →
  `getConnection` → persisted-identity check (the exact comparison `replace`
  does today) → eligibility (`state_ref_index === 0` and the ref equals
  `file:connections/<source_key>.state`) → `this.read(persisted)` →
  `beginFor(source_key)` → `await update(writer)` → not written →
  `LedgerError(message)` → `save`. `replace` keeps its current message
  (`replacement sign-in did not provide connection state`; existing tests
  assert it); `rewrite` uses `state rewrite did not provide connection state`.
  On any failure `discard(pending)`; old state stays intact (the existing
  rollback/journal machinery is reused, not copied).
- `createStatePersister`: keeps `current = connection`; `persist(bytes)` chains
  on the previous call's promise, then
  `current = await store.rewrite(db, current, (w) => w.write(bytes))`. Two
  overlapping `persist` calls therefore never hit
  `connection state enrollment is already active`.
- Note in the `rewrite` docstring (for the CLI/doctor lanes): `save` advances
  `connected_at` on every rewrite, so after this lane `connected_at` means
  "state last written at", not "signed in at".
- The host contract every CLI lane must satisfy for an OAuth connector
  (`kizuki.google` first), mirroring connector-telegram §4 so `connectorFor`
  has one convention:
  1. Sign-in: `enrollConnection(db, store, connector, io)` with the connector
     built from `{}`; the connector calls `signInWithBrowser`, then
     `state.write(encodeOAuthState(...))` once, and returns `{ display }`.
  2. Later runs: build the connector from
     `{ state_ref: connection.secret_refs[0], persist: createStatePersister(db, store, connection).persist }`
     and call `connect(resolver)` where the resolver answers exactly that
     ref with `new TextDecoder().decode(store.read(connection))` and throws
     for any other ref. The connector parses the text with
     `parseOAuthState` and builds its `OAuthSession` with the lent `persist`.
     A connector given a `state_ref` but no `persist` must refuse in
     `connect` (fail closed: a refresh it cannot persist is a refresh it must
     not make).
  3. Re-sign-in: `store.replace(db, connection, connector, io)` (unchanged).

## 7. `errors.ts` — one `KizukiError`, in core

Move `KizukiError` and `KizukiErrorCode` from `packages/connectors/src/errors.ts`
to NEW `packages/core/src/errors.ts` and extend the code union:

```ts
export type KizukiErrorCode =
  | "unknown_connector"
  | "parse_error"
  | "missing_secret"
  | "misconfigured"
  | "unauthenticated"
  | "rate_limited"
  | "unreachable"
  | "provider_error";
export class KizukiError extends Error {
  readonly code: KizukiErrorCode;
  constructor(code: KizukiErrorCode, message: string, options?: ErrorOptions);
}
```

`packages/connectors/src/errors.ts` becomes
`export { KizukiError } from "@kizuki/core"; export type { KizukiErrorCode } from "@kizuki/core";`
so every existing import and the conformance `instanceof KizukiError` check
keep working unchanged. Reason: a provider package (`@kizuki/connector-google`)
must depend on core only — `@kizuki/connectors` will depend on it for the
registry, and a workspace cycle is not acceptable. (connector-telegram
chose its own error class for the same reason; either is fine, but new
OAuth connectors use `KizukiError`.)

## 8. Network scanner allowlist (`scripts/`)

Identical to ci-hardening §4, restated here so whichever lane lands first
implements it and the other builds on it — plus ONE delta marked below.

NEW `scripts/network-allowlist.txt`: one entry per line `<tracked path>:<reason>`;
`#` comments and blank lines ignored; a line without `:`, an empty path or
reason, or a duplicate path is a parse error naming the line. Entries name
tracked files under `packages/<pkg>/src/`. **Delta:** an entry may also name
a file under `packages/<pkg>/test/` when its reason starts with `test:` —
the scanner scans tests too, and the loopback transport must be exercised
against a real socket once. Initial content after this lane:

```
# path:reason  (invariant 6: only user-configured connectors and the configured model endpoint may touch the network)
packages/core/src/auth/loopback.ts:OAuth sign-in for user-configured connectors: loopback redirect listener on 127.0.0.1 and token/revocation endpoint POSTs (Bun.serve, fetch)
packages/core/test/auth/loopback.test.ts:test: fake provider on 127.0.0.1 exercising the loopback transport; the only test in the tree that opens a socket
```

`scripts/verify-network.ts` (keep `scanSourceText` and `NetworkFinding` unchanged):

```ts
export interface AllowlistEntry {
  path: string;
  reason: string;
  line: number;
}
export function parseAllowlist(text: string): AllowlistEntry[];
export interface TreeScan {
  findings: NetworkFinding[]; // in files NOT allowlisted
  allowlisted: { entry: AllowlistEntry; findings: NetworkFinding[] }[];
  stale: AllowlistEntry[]; // untracked, outside packages/*/src (or packages/*/test without a "test:" reason), or zero findings
}
export function applyAllowlist(
  findings: NetworkFinding[],
  entries: AllowlistEntry[],
  trackedFiles: string[],
): TreeScan; // pure
export async function scanTrackedSources(opts?: {
  allowlistPath?: string;
}): Promise<TreeScan>;
```

`main()` fails (exit 1) on any `findings` or `stale`, printing each as
`file:line:col: reason` / `stale allowlist entry: <path> (<why>)`; on success
prints `allowlisted: <path> (<n> findings): <reason>` per entry and finally
`network source verification passed (<n> allowlisted files)`. Module
imports (`node:http`, `undici`, …) are reported like any other finding; an
allowlisted file still may not import them (the reason text documents which
APIs it uses; reviewers hold it to that). `scripts/verify.sh` keeps calling
`bun run scripts/verify-network.ts`; if ci-hardening has landed, `bun run verify:network`
is the same thing.

## 9. Exports

`packages/core/src/index.ts` adds runtime exports `KizukiError`, `OAuthError`,
`OAUTH_STATE_SCHEMA`, `OAuthSession`, `buildPkce`, `pkceChallenge`,
`buildAuthorizationUrl`, `parseTokenResponse`, `signInWithBrowser`,
`refreshTokens`, `revokeToken`, `loopbackTransport`, `encodeOAuthState`,
`parseOAuthState`, `createStatePersister`, and the types `KizukiErrorCode`,
`OAuthProvider`, `TokenSet`, `OAuthErrorCode`, `Pkce`, `LoopbackListener`,
`OAuthTransport`, `SignInOptions`, `OAuthState`, `StatePersister`,
`StatePersisterHandle`, `OAuthSessionInit`. Update the sorted list in
`packages/core/test/index.test.ts` (it pins every runtime export).
`@kizuki/core` `package.json` gains no dependency.

## 10. README (one sentence)

Root `README.md`, Pledges → "Zero phone-home": the sentence "Today there
are zero runtime dependencies and zero network calls anywhere in the tree;
CI greps both the dependency manifests and the source for network surface."
is no longer true once `auth/loopback.ts` exists. Replace it with:
"Core has zero runtime dependencies. The only code that opens a socket is
sign-in and sync for sources you connect — every such file is listed with
its reason in `scripts/network-allowlist.txt` — and only after you sign in;
CI scans every package manifest and every source file for any other network
surface." connector-telegram §9 replaces the same sentence; if it landed
first, merge by keeping this wording and appending its GramJS clause. Run
the `humanizer` pass on the edit.

## 11. Tests

`packages/core/test/auth/helpers.ts`: `FakeTransport` (in-memory; `listen`
returns a listener whose `callback()` resolves when the test calls
`fake.redirect(query)`; `postForm` answers from a scripted queue and records
every `{ url, form }`), `fakeIo()` capturing `notify`/`openUrl` calls,
`provider()` fixture (`name: "fixture"`, `client_id: "fixture-client"`,
endpoints under `https://provider.invalid/`). No sockets anywhere in this
directory except `loopback.test.ts`. Synthetic names only (ada, grace,
linus, acme).

- `pkce.test.ts`: the RFC 7636 Appendix B vector above; `buildPkce()` verifier
  is 43 chars of `[A-Za-z0-9_-]`, two calls differ, injected `randomBytes`
  makes it deterministic.
- `oauth.test.ts`: authorization URL has exactly the seven fixed params plus
  extras and no `client_secret`; an extra overriding `state` throws; happy
  path (exchange form fields, `code_verifier` equals the verifier whose
  challenge was in the URL, `redirect_uri` equals the listener's, listener
  closed after); `notify` contains the URL and `openUrl` was called; a
  rejecting `openUrl` does not abort; an `openUrl` that never resolves does
  not block completion; state mismatch → `state_mismatch`, zero POSTs,
  listener closed; `error=access_denied` → `provider_error` mentioning
  `access_denied`; `timeoutMs: 10` with no redirect → `timeout`; token 500 →
  `provider_error`; 200 with `{}` / `null` body / `token_type: "MAC"` /
  `expires_in: 0` → `invalid_token_response`; refresh keeps the old refresh
  token when omitted, replaces it when rotated, `invalid_grant` →
  `refresh_rejected`, null refresh token → `refresh_rejected` with zero
  POSTs; `revokeToken` 200 and `invalid_token` both resolve, no
  `revocation_url` → `not_supported`; empty `client_id` → `TypeError`
  before any listener is opened.
- `redaction.test.ts`: with sentinel values (`SENTINEL-CODE`,
  `SENTINEL-ACCESS`, `SENTINEL-REFRESH`, the generated verifier and state),
  every error thrown by the flow, refresh and revoke paths (`message`,
  `String(e)`, `JSON.stringify(e)`) excludes all sentinels.
- `loopback.test.ts` (allowlisted): `redirect_uri` matches
  `^http:\/\/127\.0\.0\.1:\d+\/callback$`; `GET /other` → 404 empty;
  `POST /callback` → 404; `GET /callback?code=abc&state=xyz` → 200, body
  equals the fixed page and does not contain `abc`; `callback()` resolved
  with those params; a second GET returns the page and does not change the
  resolved URL; after `close()` a new `fetch` to the port rejects and a
  fresh `callback()` rejects with `timeout`; `postForm` against a
  `Bun.serve` fake token endpoint sends `application/x-www-form-urlencoded`
  with the exact fields and returns `{ status, body }`; a non-JSON body
  yields `body: null`.
- `state.test.ts`: encode → parse round trip from bytes and from text; wrong
  schema / other provider / missing account id / `refresh_token: 1` /
  `expires_at: "yesterday"` / an extra key → `invalid_state`; oversized →
  `RangeError`.
- `session.test.ts`: fresh token → no POST; token inside skew → one refresh;
  10 concurrent `accessToken()` → one POST; refresh persists bytes whose
  `parseOAuthState` shows the new access token and the rotated refresh
  token; persist rejection propagates while `tokens()` already holds the
  new set; `forget()` → `unauthenticated`.
- `connections.test.ts` (extend; same helpers): `rewrite` swaps bytes under
  the same `source_key`, one row, file still 0600; `rewrite` whose update
  writes nothing → `LedgerError("state rewrite did not provide connection state")`
  and old bytes intact; `rewrite` on a fabricated connection is rejected
  before staging; `rewrite` on a null-state connection is rejected;
  `createStatePersister` with two overlapping `persist` calls lands both in
  order (`current()` reflects the second); after enrollment + rewrite the raw
  SQLite file contains neither `SENTINEL-ACCESS` nor `SENTINEL-REFRESH`;
  end-to-end: a fixture connector whose `signIn` writes
  `encodeOAuthState(...)` enrolls through `enrollConnection`, the bytes read
  back through `store.read` parse, and the host resolver convention of §6
  (resolver over `store.read`, refusing any other ref) round-trips the
  envelope as text.
- `packages/connectors/test/errors.test.ts` (new): `KizukiError` imported
  from `@kizuki/connectors` `toBe` the one from `@kizuki/core`; the
  conformance fail-closed check still passes for the existing connectors.
- `scripts/verify-network.test.ts` (extend): `parseAllowlist` accepts
  comments and blank lines, rejects a line without `:` naming the line
  number, rejects a duplicate path; `applyAllowlist` separates findings from
  allowlisted ones, marks a zero-finding entry stale, marks an untracked
  path stale, marks a `packages/x/test/y.ts` entry stale unless its reason
  starts with `test:`; the tree test (`scanTrackedSources()` on this repo →
  `findings: []`, `stale: []`, `allowlisted.length === 2`).

## Non-goals

- No CLI verb, no terminal `SignInIo`, no `xdg-open` (the CLI lanes own
  `connect`/`backfill`/`sync`; they call `enrollConnection`, build
  connectors per §6 and drain with `runToCompletion` from connector-telegram §7).
- No provider definitions, no Gmail/Calendar/X/WHOOP mapping (sibling lanes).
- No `packages/core/src/app-credentials.ts` (ci-hardening §3 owns it; the
  Google lane consumes it).
- No `keychain:` scheme, no encryption at rest (host-trust stance; a
  versioned key-id seam is reserved by the architecture, not built here).
- No deletion of state files and no connection-revocation verb (see the lane
  report's open questions).
- No change to `kizuki.connector/v1`, `kizuki.event/v1`, the ledger schema
  (no migration v3), `enrollConnection`'s signature, or `runBackfill`/`runSync`.

## Acceptance

```
bun install --frozen-lockfile                                  # exit 0; lockfile unchanged
bun run typecheck                                              # exit 0
bun test                                                       # green; ≥ 575 tests (main has 515), ≥ 60 of them new under packages/core/test/auth, connections, connectors/test/errors, scripts
bun test packages/core/test/auth/pkce.test.ts                  # the RFC 7636 vector passes
bun run scripts/verify-network.ts                              # prints "network source verification passed (2 allowlisted files)", exit 0
grep -c ':' scripts/network-allowlist.txt                      # ≥ 2 (both core entries present)
bash scripts/verify.sh                                         # exit 0 (typecheck, tests, policy tests, network scan, identifier denylist over tracked text and commit messages)
git diff --stat main..HEAD -- '*/package.json' bun.lock | cat   # empty: no dependency added anywhere
grep -rn 'SENTINEL' packages/core/src                          # no output (sentinels live in tests only)
grep -rln 'Bun.serve\|fetch(' packages/core/src                # exactly packages/core/src/auth/loopback.ts
bun test packages/core/test/index.test.ts                      # public-surface list updated and green
grep -c 'zero runtime dependencies and zero network calls' README.md   # 0 (pledge sentence replaced per §10)
git status --porcelain                                         # empty
```
