# Lane: connector-whoop — WHOOP v2 (cycle, recovery, sleep, workout) over an owner-registered OAuth client

New package `packages/connector-whoop` (zero runtime dependencies), registered
in `packages/connectors/src/registry.ts` like the three in-tree connectors.
Read CONVENTIONS.md first, then `docs/architecture.md` (invariants 6, 8, 10;
"Sign-in, not setup"), `rfcs/0000-constraints.md` §1 and §8,
`packages/core/src/contracts/connector.ts` (`Manifest.auth_modes`,
`SignInIo`, `ConnectionStateWriter`, the optional `signIn`),
`packages/core/src/ledger/connection-state.ts` (`ConnectionStateStore`,
`enrollConnection`: the host mints the source key and owns the state file;
the connector gets a one-shot byte writer and nothing else),
`packages/core/src/ingest/run.ts` (`runBackfill`/`runSync` run exactly one
batch per call), `packages/connectors/src/conformance.ts`,
`packages/connectors/src/markdown-folder/index.ts` (style to match),
`packages/core/test/connections.test.ts` (how a `signIn` is exercised with
a fake writer), and `scripts/verify-network.ts` (the AST scan that flags
every `fetch`/`Bun.serve` under `packages/`, tests included, with no
allowlist on main at `76930db`). The fuller design is
`workspace/kizuki-plan/ARCHITECTURE.md` §3.1 (the WHOOP line: "confidential
client → an opt-in broker package or owner-registered app, stated
honestly"), §3.2, §2.1, §2.2, §10, §12.

Depends on the `oauth-core` lane: `packages/core/src/auth/oauth.ts` (NEW
there: `OAuthProvider`, `TokenSet`, `buildPkce`, `signInWithBrowser`,
`refresh`) and the network-scan allowlist it must introduce in
`scripts/verify-network.ts`. This lane re-specifies none of that; §7 lists
exactly what it consumes.

## Objective

`kizuki connect whoop` (CLI verb owned by the CLI lanes; see §9) opens the
owner's browser on WHOOP's consent screen; they click allow; the terminal
says `connected kizuki.whoop source=<display> health=ok`. Backfill walks the
member's full history of cycles, recoveries, sleeps and workouts into the
ledger as `private` events; sync keeps it current within WHOOP's limits.
Every provider limit is stated in the package README, not papered over.

## 0. Provider facts this lane is built on (checked 2026-09-02, developer.whoop.com)

- OAuth 2.0 authorization code. Authorization URL
  `https://api.prod.whoop.com/oauth/oauth2/auth`, token URL
  `https://api.prod.whoop.com/oauth/oauth2/token`. The token endpoint
  requires `client_secret`; there is no public-client (PKCE-only) flow. The
  docs: the secret "should only be used server side and should never be
  exposed in a client, web, or mobile application".
- Scopes: `read:recovery read:cycles read:sleep read:workout read:profile
read:body_measurement offline`. `offline` is what yields a refresh token.
- `state` "must be eight characters long if you need to generate it
  yourself" (treat as a minimum of 8).
- Refresh: `grant_type=refresh_token&refresh_token&client_id&client_secret&scope=offline`;
  response carries a NEW `refresh_token`, `expires_in: 3600`; the previous
  refresh token is no longer valid (rotation). A rotated token that is not
  persisted strands the owner.
- Redirect URL must match a value registered in the Developer Dashboard
  exactly. The docs show only `https://` and custom-scheme examples;
  loopback `http://localhost:<port>/...` is widely used in community
  integrations but is not documented. This lane pins one exact loopback
  redirect and tells the owner to register it verbatim (§3).
- Apps in development are limited to 10 WHOOP members until WHOOP approves
  the app. Any compiled-in project client therefore serves at most 10
  people until approval; the owner-registered client is the primary path.
- REST base `https://api.prod.whoop.com/developer`. Collections:
  `GET /v2/cycle`, `GET /v2/recovery`, `GET /v2/activity/sleep`,
  `GET /v2/activity/workout`; query `limit` (max 25), `start` (inclusive,
  records that occurred after or during), `end` (exclusive), `nextToken`;
  response `{ records: [...], next_token }`; sorted by start time
  descending. Profile `GET /v2/user/profile/basic` → `{ user_id, email,
first_name, last_name }`. Revoke `DELETE /v2/user/access`.
- Record identity: cycle `id` is an int64; sleep and workout `id` are
  UUID strings (`v1_id` is the legacy integer); recovery has no own id and
  is keyed by `cycle_id` (+ `sleep_id`). Every record carries `created_at`,
  `updated_at`, `score_state` ∈ `SCORED | PENDING_SCORE | UNSCORABLE` and,
  when scored, a `score` object.
- Rate limits: 100 requests/minute, 10,000/day; `429` with
  `X-RateLimit-Reset` (seconds until the window resets).
- Deletions are exposed ONLY through webhooks (`workout.deleted`,
  `sleep.deleted`, `recovery.deleted`), which need a public HTTPS endpoint.
  Kizuki has none. There is no polling way to learn about deletions, so
  `tombstones: false` is the honest manifest. There is no API to delete a
  member's data at WHOOP, so `purge: false` (ledger-side purge still works,
  §5).

## 1. Package layout and registration

```
packages/connector-whoop/
  package.json          # @kizuki/connector-whoop; deps: @kizuki/core, @kizuki/connectors (workspace:*); no others
  README.md             # §8
  src/index.ts          # public exports (§1.1)
  src/app-credentials.ts# compiled-in project client + placeholders (§3.1)
  src/provider.ts       # URLs, scopes, loopback redirect, OAuthProvider builder (§3.2)
  src/state.ts          # kizuki.whoop-state/v1 encode/decode (§3.3)
  src/cursor.ts         # kizuki.whoop-cursor/v1 encode/decode (§4.3)
  src/client.ts         # WhoopApi over global fetch: the ONLY file that touches the network (§2)
  src/map.ts            # record → CaptureEventInput, text renderers (§4.1, §4.2)
  src/connector.ts      # WhoopConnector (§3, §4, §5)
  src/fixture.ts        # FIXTURE_RECORDS + createFixtureWhoopApi (§6)
  test/…                # §10
```

Touches outside the package (all additive):

- `packages/connectors/package.json`: add `"@kizuki/connector-whoop": "workspace:*"`
  to `dependencies` and add the subpath export
  `"./errors": "./src/errors.ts"` (NEW). The whoop package imports
  `KizukiError` ONLY from `@kizuki/connectors/errors` (a leaf module with no
  imports) so the file-level import graph stays acyclic even though the two
  workspace packages reference each other: `connectors/src/index.ts →
registry.ts → @kizuki/connector-whoop → connectors/src/errors.ts`. Importing
  `@kizuki/connectors` (the index) from the whoop package would put
  `WHOOP_CONNECTOR_ID` in a temporal dead zone whenever a whoop test is the
  entry module; a test in §10 proves the entry order works both ways.
- `packages/connectors/src/errors.ts`: extend `KizukiErrorCode` with
  `"unauthenticated" | "rate_limited" | "unreachable"` (NEW members; existing
  callers unaffected).
- `packages/connectors/src/registry.ts`: `[WHOOP_CONNECTOR_ID]: createWhoopConnector`
  plus the `getConnector` overload
  `(id: typeof WHOOP_CONNECTOR_ID, config: WhoopConnectorConfig): Connector`.
- `packages/connectors/src/index.ts`: re-export `WHOOP_CONNECTOR_ID`,
  `WhoopConnector`, `createWhoopConnector`, `createFixtureWhoopApi` and the
  type `WhoopConnectorConfig`, matching how the other three are surfaced.
- `packages/connectors/test/conformance.test.ts`: add the whoop entry (§10).
- `bun.lock`: regenerated by `bun install`; commit it (CI runs
  `--frozen-lockfile`).
- `scripts/verify-network.ts` allowlist (mechanism from oauth-core): two
  entries, `packages/connector-whoop/src/client.ts` ("user-configured
  connector; WHOOP REST over fetch; invariant 6 exception") and
  `packages/connector-whoop/test/loopback.ts` ("test-only loopback fake of
  the provider; binds 127.0.0.1"). No other file in the package may name
  `fetch`, `Bun.serve` or a `node:` network module.

### 1.1 Public exports (`src/index.ts`)

```ts
export const WHOOP_CONNECTOR_ID = "kizuki.whoop" as const;
export const WHOOP_KINDS = ["cycle", "recovery", "sleep", "workout"] as const;
export type WhoopCollection = (typeof WHOOP_KINDS)[number];

export interface WhoopClientRefs {
  client_id_ref: string; // secret_ref URI (`env:` or `file:`), never a value
  client_secret_ref: string; // secret_ref URI
}

export interface WhoopTransport {
  /** REST seam; default `createWhoopApi()`. Tests inject a fake. */
  api?: WhoopApi;
  /** oauth-core `refresh`; default imported from `@kizuki/core`. */
  refresh?: (provider: OAuthProvider, tokens: TokenSet) => Promise<TokenSet>;
  /** oauth-core `signInWithBrowser`; default imported from `@kizuki/core`. */
  signInWithBrowser?: typeof signInWithBrowser;
}

export interface WhoopConnectorConfig {
  /** Host-lent resolver used by `signIn` for the owner client refs. `connect` uses its own argument. */
  resolve: SecretResolver;
  /** `connection.secret_refs[0]` of a saved connection; required by `connect`. */
  state_ref?: string;
  /** Owner-registered client; when absent the compiled-in project client is used (§3.1). */
  client?: WhoopClientRefs;
  /** Exact redirect registered at WHOOP; default `DEFAULT_REDIRECT_URI` (§3.2). */
  redirect_uri?: string;
  /** Host-lent, non-interactive replacement of this connection's state bytes (§3.4). */
  persist_state?: (state: Uint8Array) => Promise<void>;
  /** Loopback-only overrides for the fake provider in tests (§2.2). */
  api_base_url?: string;
  oauth_base_url?: string;
  transport?: WhoopTransport;
  now?: () => Date;
}

export class WhoopConnector implements Connector {
  constructor(config: WhoopConnectorConfig); /* §3–§6 */
}
export function createWhoopConnector(
  config: WhoopConnectorConfig,
): WhoopConnector;
export {
  createWhoopApi,
  type WhoopApi,
  type WhoopResult,
  type WhoopFailure,
  type CollectionPage,
  type BasicProfile,
} from "./client";
export { mapRecord, renderText, timeKey } from "./map";
export {
  FIXTURE_RECORDS,
  FIXTURE_USER,
  createFixtureWhoopApi,
} from "./fixture";
export {
  NO_CLIENT_MESSAGE,
  DEFAULT_REDIRECT_URI,
  WHOOP_SCOPES,
} from "./provider";
export {
  WHOOP_STATE_SCHEMA,
  decodeState,
  encodeState,
  type WhoopState,
} from "./state";
export {
  WHOOP_CURSOR_SCHEMA,
  decodeCursor,
  encodeCursor,
  type WhoopCursor,
} from "./cursor";
```

Manifest (the only manifest this connector ever returns):

```ts
{
  schema: "kizuki.connector/v1",
  connector_id: "kizuki.whoop",
  version: "0.1.0",
  kinds: ["cycle", "recovery", "sleep", "workout"],
  capabilities: { backfill: true, sync: true, tombstones: false, purge: false, fixture: true },
  required_secrets: [],          // the state ref is host-minted at sign-in, not known up front
  emits_sensitivity_hint: true,
  auth_modes: ["oauth"],
}
```

`required_secrets: []` means the shared suite skips its connect-fail-closed
probe; §10 supplies the equivalent tests in-package.

## 2. REST client (`src/client.ts`)

```ts
export const WHOOP_API_BASE_URL = "https://api.prod.whoop.com/developer";
export const COLLECTION_PATHS: Record<WhoopCollection, string> = {
  cycle: "/v2/cycle",
  recovery: "/v2/recovery",
  sleep: "/v2/activity/sleep",
  workout: "/v2/activity/workout",
};
export const PAGE_LIMIT = 25;
export const REQUEST_TIMEOUT_MS = 15_000;

export interface CollectionQuery {
  start?: string;
  end?: string;
  limit: number;
  nextToken?: string;
}
export interface CollectionPage {
  records: unknown[];
  next_token: string | null;
}
export interface BasicProfile {
  user_id: number;
  email: string;
  first_name: string;
  last_name: string;
}
export type WhoopFailure =
  | { kind: "unauthenticated" }
  | { kind: "rate_limited"; retry_after_s: number } // from X-RateLimit-Reset, default 60
  | { kind: "unreachable"; detail: string } // network error / timeout; detail is a fixed phrase, never a body
  | { kind: "provider_error"; status: number }; // 5xx after one retry, or any other unexpected status
export type WhoopResult<T> =
  { ok: true; value: T } | { ok: false; failure: WhoopFailure };

export interface WhoopApi {
  profile(accessToken: string): Promise<WhoopResult<BasicProfile>>;
  collection(
    accessToken: string,
    collection: WhoopCollection,
    query: CollectionQuery,
  ): Promise<WhoopResult<CollectionPage>>;
  revoke(accessToken: string): Promise<WhoopResult<null>>;
}
export function createWhoopApi(opts?: {
  base_url?: string;
  timeout_ms?: number;
}): WhoopApi;
```

Rules:

- Every request: `Authorization: Bearer <token>`, `Accept: application/json`,
  `AbortSignal.timeout(REQUEST_TIMEOUT_MS)`. `429` → `rate_limited` with
  `retry_after_s` parsed from `X-RateLimit-Reset` (integer seconds; missing
  or unparsable → 60). `401` → `unauthenticated`. `5xx` or a thrown fetch
  error → wait 1 s, retry exactly once; still failing → `provider_error` /
  `unreachable`. Anything else non-2xx → `provider_error`.
- Response bodies are attacker-controlled: parse as JSON, validate the
  shape (`records` array, `next_token` string or absent), and never copy a
  body or header into an error message, a `HealthReport.detail`, or a log.
  Bodies larger than 4 MiB are rejected as `provider_error`.
- The access token never appears in a URL, an error, or a `WhoopResult`.

### 2.2 Loopback-only overrides

`api_base_url` / `oauth_base_url` exist so the loopback fake can stand in
for WHOOP. `assertLoopbackOverride(url)` (in `provider.ts`) throws
`KizukiError("misconfigured", "kizuki.whoop: base URL overrides must be http://127.0.0.1:<port> or http://localhost:<port>")`
for anything else, so no config can point health data at a third host
(invariant 6).

## 3. Sign-in, state, connect, refresh

### 3.1 Client credentials (`src/app-credentials.ts`)

```ts
export const PLACEHOLDER_CLIENT_ID = "";
export const PLACEHOLDER_CLIENT_SECRET = "";
/** Read once at module load; `bun build --define process.env.KIZUKI_WHOOP_CLIENT_ID=... --define process.env.KIZUKI_WHOOP_CLIENT_SECRET=...` inlines them. */
export function compiledClient(): {
  client_id: string;
  client_secret: string;
} | null; // null when either is a placeholder
```

Resolution order in `signIn`: `config.client` refs resolved through
`config.resolve` → else `compiledClient()` → else throw
`KizukiError("misconfigured", NO_CLIENT_MESSAGE)` where

```
NO_CLIENT_MESSAGE =
"kizuki.whoop: no WHOOP client is configured. Register an app at the WHOOP Developer Dashboard with redirect URL http://127.0.0.1:48412/callback, then run: kizuki connect whoop --secret client_id=env:WHOOP_CLIENT_ID --secret client_secret=env:WHOOP_CLIENT_SECRET (or build with KIZUKI_WHOOP_CLIENT_ID and KIZUKI_WHOOP_CLIENT_SECRET set)."
```

(one line, exact; a test compares the whole string). The message is the
same regardless of which half is missing so it never reveals which
compiled-in half exists. A resolver failure for an owner ref surfaces as
`KizukiError("missing_secret", "kizuki.whoop: cannot resolve <ref>")` with
the ref string only, never a value.

### 3.2 Provider (`src/provider.ts`)

```ts
export const WHOOP_AUTHORIZATION_URL =
  "https://api.prod.whoop.com/oauth/oauth2/auth";
export const WHOOP_TOKEN_URL = "https://api.prod.whoop.com/oauth/oauth2/token";
export const WHOOP_SCOPES = [
  "read:recovery",
  "read:cycles",
  "read:sleep",
  "read:workout",
  "read:profile",
  "offline",
] as const;
export const DEFAULT_LOOPBACK_PORT = 48412;
export const DEFAULT_REDIRECT_URI = "http://127.0.0.1:48412/callback";
export function whoopProvider(
  client: { client_id: string; client_secret: string },
  opts?: { oauth_base_url?: string },
): OAuthProvider;
export function parseRedirectUri(uri: string): { port: number; path: string }; // http only; host 127.0.0.1 or localhost; explicit port; else KizukiError("misconfigured")
```

`read:body_measurement` is not requested: nothing in this lane consumes it
and the README does not claim it.

### 3.3 Connection state (`src/state.ts`) — the opaque bytes the host stores

UTF-8 JSON, written once through the host's `ConnectionStateWriter`:

```json
{
  "schema": "kizuki.whoop-state/v1",
  "user_id": 424242,
  "display_name": "Ada Example",
  "client": {
    "kind": "owner",
    "client_id_ref": "env:WHOOP_CLIENT_ID",
    "client_secret_ref": "env:WHOOP_CLIENT_SECRET"
  },
  "redirect_uri": "http://127.0.0.1:48412/callback",
  "tokens": {
    "access_token": "…",
    "refresh_token": "…",
    "expires_at": "2026-01-02T03:04:05.000Z",
    "scope": "…",
    "token_type": "bearer"
  }
}
```

`client` is either `{ kind: "owner", … refs … }` or `{ kind: "compiled_in" }`;
client values are never in the state. Tokens ARE in the state: the state
file is host-owned, `0600` inside a `0700` directory, never in SQLite (the
existing core test "raw SQLite never contains state bytes" is the model
this relies on). `decodeState` validates every field (schema literal,
integer `user_id`, RFC3339 `expires_at` via `isRfc3339`, secret_ref
grammar via `isSecretRef`) and throws `KizukiError("parse_error", "kizuki.whoop: connection state is invalid")`
without echoing content. Size cap: reject > 64 KiB.

### 3.4 `signIn(io, state)`

1. Resolve the client (§3.1). Parse `redirect_uri` (§3.2).
2. `io.notify` three lines: provider and requested access
   (`WHOOP: read cycles, recoveries, sleep and workouts (read-only)`), the
   destination (`Tokens are kept only in this vault's connection state`),
   and the cancellation path (`Ctrl-C cancels; nothing is saved until
sign-in completes`).
3. `signInWithBrowser(whoopProvider(client), io, { redirect_uri, timeoutMs: 300_000 })`
   → `TokenSet`. The request MUST send the exact `redirect_uri` string;
   `state` MUST be ≥ 8 characters; PKCE S256 is sent as oauth-core does by
   default (§11 records the live-smoke check for WHOOP's acceptance).
   `expires_at` is computed from `expires_in` by oauth-core.
4. `api.profile(access_token)` → `user_id`, names. Any failure → throw
   (`unauthenticated` → `KizukiError("unauthenticated", "kizuki.whoop: WHOOP rejected the new token")`,
   others mapped likewise); nothing is written.
5. `await state.write(encodeState(...))` exactly once.
6. Return `{ display: "<first_name> <last_name> (WHOOP member <user_id>)" }`.

A timeout while waiting for the redirect fails with
`KizukiError("misconfigured", "kizuki.whoop: no redirect arrived within 300s; the app's registered redirect URL must be exactly <redirect_uri>")`
because a redirect mismatch is shown by WHOOP in the browser and never
reaches the listener.

### 3.5 `connect(resolve)`

Requires `config.state_ref`; absent → `KizukiError("missing_secret", "kizuki.whoop: no connection state ref; run: kizuki connect whoop")`.
`resolve(state_ref)` → `decodeState`. For `client.kind === "owner"`, resolve
both refs through the `connect` resolver (failure → `missing_secret` with
the ref only); for `compiled_in`, `compiledClient()` must be non-null, else
`misconfigured` with `NO_CLIENT_MESSAGE`. Then `ensureAccessToken()`
(§3.6) and `api.profile()`; `user_id` mismatch →
`KizukiError("misconfigured", "kizuki.whoop: the signed-in WHOOP member does not match this connection")`.
`connect` never starts a browser flow.

### 3.6 Token lifecycle (`ensureAccessToken`)

- If `expires_at - now > 60 s` → use the stored access token.
- Else, if `config.persist_state` is undefined → throw
  `KizukiError("misconfigured", "kizuki.whoop: the host lent no connection-state writer; refusing to rotate the refresh token")`.
  Rotating without persisting would invalidate the only refresh token.
- Else `transport.refresh(provider, tokens)` → new `TokenSet` (WHOOP
  returns a new refresh token; if the response omits one, keep the old, as
  oauth-core's `refresh` already guarantees) → `encodeState` →
  `await persist_state(bytes)` → only then use the new access token. A
  refresh failure maps to `unauthenticated` (health) and stops the run.
- A `401` on any API call triggers one refresh + one retry of that call,
  then `unauthenticated`.
- The provider passed to `refresh` carries `client_secret` and
  `scopes: ["offline"]`; oauth-core must post `client_id`, `client_secret`
  and `scope` on refresh (§7).

### 3.7 `health()` — passive, no network

`disabled` before a successful `connect` in this process; afterwards the
state of the most recent API outcome: `ok` (`last_success_at` set),
`unauthenticated`, `rate_limited` (`detail: "retry after <n>s"`),
`unreachable`, `degraded` (`detail: "provider error <status>"`),
`misconfigured` (§3.1/§3.6 refusals). `detail` never contains a token, a
URL with a query string, or provider text.

### 3.8 `revoke()`

If connected: `api.revoke(access_token)` (`DELETE /v2/user/access`);
`unauthenticated` counts as already revoked; other failures throw with the
mapped code. Then drop in-memory tokens; `health()` → `disabled`. Removing
the row and the state file is the host's job (`disconnect` exists in core;
state-file removal does not exist on main and is not this lane's).

## 4. Events

### 4.1 Mapping (`src/map.ts`)

`mapRecord(collection, raw, { observed_at, subject })` validates `raw`
(plain object; ids; RFC3339 `start`/`end`/`created_at`/`updated_at` where
present; `score_state` in the enum) and throws
`KizukiError("parse_error", "kizuki.whoop: malformed <collection> record")`
otherwise (no record content in the message). Output:

| field              | value                                                                                             |
| ------------------ | ------------------------------------------------------------------------------------------------- |
| `connector_id`     | `kizuki.whoop`                                                                                    |
| `kind`             | the collection name                                                                               |
| `source_record_id` | `cycle:<id>` · `recovery:<cycle_id>` · `sleep:<id>` · `workout:<id>`                              |
| `occurred_at`      | `start` (cycle, sleep, workout); `created_at` (recovery)                                          |
| `observed_at`      | the batch's `now().toISOString()`                                                                 |
| `text`             | `renderText(collection, record)` (§4.2)                                                           |
| `subjects`         | `[{ subject_id: "whoop:user:<user_id>", role: "about", display_name }]` from the connection state |
| `sensitivity_hint` | `"private"` always                                                                                |
| `deleted`          | `false` always (no deletion signal exists)                                                        |
| `attachments`      | `[]`                                                                                              |
| `metadata`         | `{ api: "v2", collection, record: <raw record verbatim> }`                                        |

`updated_at` is inside `metadata.record`, so a re-scored record
(`PENDING_SCORE` → `SCORED`) or an edited workout produces a new
`content_hash` under the same `source_record_id`: the ledger stores it as an
edit (`accept` → `stored`), an unchanged record dedupes (`duplicate`).

`timeKey(collection, record)` = `start` for cycle/sleep/workout,
`created_at` for recovery; it drives the sync watermark (§4.4).

### 4.2 Text (`renderText`) — deterministic, pinned by tests

Numbers: strain, HRV, SpO2, skin temperature and respiratory rate with
`toFixed(1)`; heart rates, kJ and percentages with `Math.round`; distance
as `(distance_meter / 1000).toFixed(2)` km; durations as `<h>h<mm>m` from
`start`/`end` floored to minutes. Timestamps verbatim from the record.
Optional score fields are omitted with their label when absent.

- cycle, scored: `Cycle <start> to <end|ongoing>: strain 12.3, avg HR 70 bpm, max HR 150 bpm, 8400 kJ`; not scored: `Cycle <start> to <end|ongoing>: <score_state>`.
- recovery, scored: `Recovery for cycle <cycle_id>: 67% (RHR 52 bpm, HRV 48.5 ms, SpO2 97.2%, skin temp 33.1 C)` + ` while calibrating` when `user_calibrating`; not scored: `Recovery for cycle <cycle_id>: <score_state>`.
- sleep, scored: `Sleep <start> to <end> (7h41m): performance 88%, efficiency 93%, consistency 71%, respiratory rate 14.2` (`Nap` instead of `Sleep` when `nap`); not scored: `Sleep <start> to <end>: <score_state>`.
- workout, scored: `Workout <sport_name> <start> to <end> (0h52m): strain 10.4, avg HR 141 bpm, max HR 172 bpm, 8.12 km`; not scored: `Workout <sport_name> <start> to <end>: <score_state>`.

Changing a template is a manifest `version` bump and a fixture-hash test
change; the test in §10 asserts the exact strings so this cannot drift
silently.

### 4.3 Cursor (`src/cursor.ts`)

```json
{
  "schema": "kizuki.whoop-cursor/v1",
  "phase": "backfill",
  "collections": {
    "cycle": {
      "next_token": null,
      "exhausted": false,
      "watermark": null,
      "window_start": null
    },
    "recovery": {
      "next_token": null,
      "exhausted": false,
      "watermark": null,
      "window_start": null
    },
    "sleep": {
      "next_token": null,
      "exhausted": false,
      "watermark": null,
      "window_start": null
    },
    "workout": {
      "next_token": null,
      "exhausted": false,
      "watermark": null,
      "window_start": null
    }
  }
}
```

`phase` ∈ `backfill | sync`. `watermark` and `window_start` are RFC3339 or
null. `decodeCursor` rejects anything else with
`KizukiError("parse_error", "kizuki.whoop: malformed cursor")`. Tokens never
enter the cursor (it is persisted in SQLite `checkpoints.cursor`).

Constants: `MAX_PAGES_PER_BACKFILL_CALL = 8`, `MAX_PAGES_PER_SYNC_COLLECTION = 40`,
`SYNC_OVERLAP_DAYS = 7`, `INITIAL_SYNC_WINDOW_DAYS = 30`.

### 4.4 `backfill(cursor)` and `sync(cursor)`

Backfill (`phase: backfill`; `null` starts a fresh one): walk the
collections in the fixed order cycle → recovery → sleep → workout, newest
first (`limit=25`, `nextToken` from the cursor), consuming at most 8 pages
per call; a collection is `exhausted` when a page has no `next_token`. The
per-collection `watermark` is set from the first page (the newest
`timeKey`). Return the events of this call with the updated cursor;
return `cursor: null` only when all four are exhausted (contract: "null
once the source is exhausted"). `runBackfill` on main runs one call per
invocation; the owner re-runs `kizuki backfill` until it reports a null
cursor, or the CLI loops (owned by the CLI lanes). Package tests loop
explicitly.

Sync:

- `sync(null)`: a bounded initial pass. For each collection
  `start = now − 30 d`, page to exhaustion (≤ 40 pages), watermark = newest
  `timeKey` seen (or null). Returns a `phase: sync` cursor, never null.
- `sync(<backfill cursor>)`: continues the backfill (identical to
  `backfill(cursor)`); a finished backfill hands back null and the next
  `sync(null)` mints the sync cursor.
- `sync(<sync cursor>)`: per collection `window_start = watermark − 7 d`
  (or `now − 30 d` when the watermark is null); if the cursor already has
  `next_token`/`window_start` for that collection (a capped previous run),
  continue from them instead; page with `start=window_start` to
  exhaustion. Watermark advances to `max(old, newest timeKey)` only when
  the collection finished within the cap; a capped collection keeps its
  old watermark and stores `next_token` + `window_start` for the next run.
  Cursor never null.

Stop conditions shared by both: a `rate_limited`, `unauthenticated`
(after one refresh attempt), `unreachable` or `provider_error` result ends
the call immediately; the events collected so far are returned with a
cursor that resumes at the failed page (the failing collection's
`next_token` unchanged), and `health()` reports the state. No throw for
these, so `runBackfill`/`runSync` persist the partial progress and the
checkpoint (they save the returned cursor when `errors` is empty). A
`parse_error` from `mapRecord` DOES throw: the batch is abandoned and the
checkpoint untouched.

Ordering within a batch: events in the order fetched (collection order,
newest first). Idempotence: two calls with the same cursor and unchanged
provider data yield identical `CaptureEventInput`s except `observed_at`,
which is not hashed.

## 5. Purge

`purgeSource(subject_id)` returns
`{ subject_id, source_record_ids: [], unreachable_source_record_ids: [] }`
(no network) and the manifest says `purge: false`: the connector holds no
index of ids and WHOOP offers no deletion API. Ledger purge is unaffected:
every event carries `whoop:user:<user_id>` as an `about` subject, so
`purgeEvents(db, vaultPath, { connector_id: "kizuki.whoop", subject_handle: "whoop:user:<user_id>", source_key }, reason)`
(matches `subject_id` exactly) and
`purgeEvents(db, vaultPath, { connector_id: "kizuki.whoop" }, reason)`
(both in `packages/core/src/ledger/purge.ts`, exist on main) remove
the scoped events with receipts. Subject purges use the enrolled source key;
only legacy unbound events may omit it. See [current purge syntax](../../cli.md#purge).

## 6. Fixture (`src/fixture.ts`)

`FIXTURE_USER = { user_id: 424242, email: "ada@acme.example", first_name: "Ada", last_name: "Example" }`
and `FIXTURE_RECORDS`: 2 cycles (one `SCORED`, one `PENDING_SCORE` with
`end: null`), 2 recoveries (one calibrating), 3 sleeps (one `nap`, one
`UNSCORABLE`), 3 workouts (one without `distance_meter`) — 10 records dated
2026-01-05 … 2026-01-08, all with `user_id: 424242`, synthetic UUIDs.
`fixture()` = `FIXTURE_RECORDS` through `mapRecord` with
`observed_at: "2026-01-09T00:00:00.000Z"`; no credentials, no network.

`createFixtureWhoopApi(opts?: { records?, faults? }): WhoopApi` — an
in-memory `WhoopApi` over the records that honours `limit`, `nextToken`
(opaque page index), `start`/`end` (by `timeKey`), sorts newest first,
returns `FIXTURE_USER` for `profile`, accepts only the access token
`"fixture-access-token"` (else `unauthenticated`), and supports a scripted
`faults` queue (`rate_limited` with `retry_after_s`, `unreachable`,
`provider_error`, `unauthenticated`) consumed one per call so tests can
place a fault at an exact page. This is product code because it backs the
`fixture` capability and the registry conformance test; it contains no
real credential.

Fixture state for tests: `FIXTURE_STATE` (exported from `test/helpers.ts`,
not `src`) with `client: { kind: "owner", client_id_ref: "env:ACME_WHOOP_ID", client_secret_ref: "env:ACME_WHOOP_SECRET" }`
and tokens `fixture-access-token` / `fixture-refresh-token`; a resolver
that serves `file:connections/01ARZ3NDEKTSV4RRFFQ69G5FAV.state` → the
state JSON and the two env refs → `"acme-client-id"` / `"acme-client-secret"`.

## 7. What this lane consumes from oauth-core (and requires of it)

From `packages/core/src/auth/oauth.ts` (NEW there), exported via
`@kizuki/core`: `OAuthProvider` (with `client_secret?`), `TokenSet`
(`access_token, refresh_token?, expires_at, scope, token_type`),
`signInWithBrowser(provider, io, opts)`, `refresh(provider, tokens)`.
Requirements this connector cannot work without; each is a line in
oauth-core's acceptance, not this lane's to implement:

1. The caller can pin the exact `redirect_uri` (fixed port and path);
   WHOOP matches it byte for byte.
2. `state` ≥ 8 characters.
3. Token exchange and refresh send `client_id` and `client_secret`
   form-encoded when `client_secret` is set, plus `scope` on refresh
   (`offline`).
4. `refresh` keeps the old refresh token when the response omits one and
   returns the new one when present.
5. `scripts/verify-network.ts` gains an allowlist covering `src` and
   `test` paths with a reason per line; this lane adds its two entries.
6. A host-side, non-interactive replacement of a saved connection's state
   bytes (the `ConnectionStateStore` on main only replaces state through
   an interactive `signIn`); the CLI wraps it as `persist_state`. This lane
   consumes only the `(bytes: Uint8Array) => Promise<void>` shape.

## 8. README (`packages/connector-whoop/README.md`)

Sections, in order, each claiming only what this package does:

1. **What it syncs** — the four kinds, `private` hint, `metadata.record`
   verbatim, one `about` subject per member.
2. **Sign in with your own WHOOP app (recommended)** — Developer Dashboard
   → create app (name, contact email, privacy policy URL) → scopes
   `read:recovery read:cycles read:sleep read:workout read:profile offline`
   → redirect URL exactly `http://127.0.0.1:48412/callback` → copy Client
   ID / Client Secret → `export WHOOP_CLIENT_ID=… WHOOP_CLIENT_SECRET=…` →
   `kizuki connect whoop --secret client_id=env:WHOOP_CLIENT_ID --secret client_secret=env:WHOOP_CLIENT_SECRET`.
   State where the CLI verb lands: "the `connect` sign-in path is wired by
   the CLI lanes; until it merges, the connector is reachable through
   `@kizuki/connectors` `getConnector("kizuki.whoop", …)`" — remove that
   sentence only when the verb exists on the same branch.
3. **Limits (honest)** — WHOOP has no public-client flow: a client secret
   is unavoidable, which is why an owner-registered app is the primary
   path; a compiled-in project client, when the build provides one, is
   capped at 10 members until WHOOP approves the app and embeds a secret in
   a distributed binary (WHOOP's own guidance says not to); refresh tokens
   rotate on every refresh, so one connection per client per device (a
   second machine using the same tokens invalidates the first); deletions
   at WHOOP are not detected (webhooks only, which need a public HTTPS
   endpoint Kizuki does not run) — `tombstones: false`; edits older than
   7 days are picked up only by a fresh backfill; 100 requests/min and
   10,000/day — backfill stops cleanly on 429 and resumes; no API deletes
   data at WHOOP — `purge: false`, ledger purge by subject or connector
   still works; `read:body_measurement` is not requested; facts checked
   2026-09-02.
4. **Build-time project client** — the two env variables, `--define`
   example, and the exact refusal message when they are placeholders.
5. **Purge** — the two `kizuki purge` forms.
6. **Manual smoke** — `KIZUKI_WHOOP_SMOKE=1 bun test packages/connector-whoop/test/smoke.test.ts`
   (skipped otherwise), what it does and what it never records.

No screenshots, no claims about the daemon, notifications or webhooks.

## 9. Non-goals

- No CLI verbs or flags in this lane (`connect`, `backfill`, `sync`,
  `--secret` are the CLI lanes'); no changes under `packages/cli`.
- No `body_measurement`, no `v1` endpoints, no webhooks, no daemon
  schedule.
- No broker or hosted token exchange; no keychain secret scheme.
- No `purge: true`, no tombstones (documented absence).
- No changes to `docs/architecture.md`; no new core tables (the
  connector persists only through `checkpoints.cursor` and the host-owned
  state file).
- No runtime dependency (`npm view` was not needed: WHOOP is plain REST
  JSON over the built-in `fetch`).

## 10. Tests

All under `packages/connector-whoop/test/` unless noted; synthetic data
only; temp dirs via `mkdtempSync`; the loopback fake binds `127.0.0.1:0`.

`test/fake-api.ts` re-exports `createFixtureWhoopApi` with fault helpers;
`test/loopback.ts` is a `Bun.serve` fake implementing
`GET /oauth/oauth2/auth` (validates `client_id`, `redirect_uri`, `state`
≥ 8, records `code_challenge`; responds 302 to `redirect_uri?code&state`),
`POST /oauth/oauth2/token` (authorization_code: checks `client_secret` and
`code_verifier` against the recorded challenge; refresh_token: single-use,
rotates, `expires_in: 3600`), `GET /developer/v2/user/profile/basic`, the
four collection paths with real `limit`/`nextToken`/`start` semantics over
`FIXTURE_RECORDS`, `DELETE /developer/v2/user/access`, and scripted faults
(`429` + `X-RateLimit-Reset`, `401`, one `500`). It records every request
(path, query names, auth header presence) for assertions.

Regression tests that must exist (names are the `test()` titles):

- `conformance.test.ts` — "kizuki.whoop passes the shared conformance suite"
  (fixture api, connected via `FIXTURE_STATE`, `now` pinned to
  2026-01-20); also in `packages/connectors/test/conformance.test.ts` the
  registry entry runs through `getConnector("kizuki.whoop", { resolve, state_ref, transport: { api: createFixtureWhoopApi() }, now })`
  after `connect`, and the result list gains one `{ pass: true, failures: [] }`.
- `registry.test.ts` — "importing the whoop package first, then the
  connectors index, yields the same registry entry" (entry-order TDZ
  proof, both import orders in two isolated `Bun.spawn`ed scripts).
- `map.test.ts` — one test per collection asserting the exact `text`,
  `source_record_id`, `occurred_at`, subject, `private` hint and verbatim
  `metadata.record`; "renderText omits absent optional score fields";
  "a not-scored record renders its score_state"; "malformed records throw
  parse_error without echoing content" (the thrown message must not
  contain a string planted in the record); "fixture hashes are stable"
  (sha256 of `canonicalSerialize` for the 10 fixture events pinned as
  literals).
- `cursor.test.ts` — encode/decode round trip; "malformed cursors are
  rejected"; "a cursor never contains a token" (string search for both
  fixture tokens across every cursor produced in the file).
- `state.test.ts` — round trip; rejects wrong schema, non-integer
  `user_id`, bad `expires_at`, non-secret_ref client refs, > 64 KiB.
- `signin.test.ts` (loopback) — "signIn completes without a browser and
  writes state once" (`io.openUrl` fetches the URL itself, follows the 302
  to the connector's listener; asserts `code_verifier` reached the token
  endpoint, `redirect_uri` byte-identical, `state` ≥ 8, the writer was
  called exactly once with a state whose `client.kind` is `owner`);
  "signIn refuses placeholder credentials with the documented message"
  (env cleared, `config.client` absent, message `===` `NO_CLIENT_MESSAGE`,
  writer never called); "signIn refuses a non-loopback base URL override";
  "a profile failure after token exchange writes nothing"; "the timeout
  message names the exact redirect URI".
- `connect.test.ts` — "connect fails closed without a state ref"
  (`KizukiError`, code `missing_secret`); "connect fails closed when the
  resolver rejects" (owner client refs); "connect refuses a member id
  mismatch"; "connect never opens a browser" (`io` absent; a transport
  `signInWithBrowser` stub that throws if called); "health is disabled
  before connect and ok after".
- `backfill.test.ts` — "backfill walks all four collections newest first
  and returns null when exhausted" (loop until null, assert order and
  counts); "backfill consumes at most 8 pages per call" (30 records per
  collection → multiple calls, page counter on the fake); "double backfill
  is idempotent through the ledger" (`InMemoryLedger` from
  `@kizuki/connectors`: second pass all `duplicate`); "a re-scored record
  is stored as an edit" (mutate `updated_at`/`score_state` between passes
  → one `stored`); "backfill resumes from a mid-collection cursor".
- `sync.test.ts` — "sync(null) fetches the initial window and mints a sync
  cursor" (`now` pinned, `start` query equals `now − 30 d`); "sync uses a
  7-day overlap and advances the watermark"; "a capped sync keeps its
  watermark and resumes next run"; "sync on an unfinished backfill cursor
  continues the backfill"; "sync never returns a null cursor".
- `faults.test.ts` — "429 stops the call, keeps the cursor at the failed
  page and reports rate_limited with retry_after" (fake and loopback);
  "401 triggers one refresh, persists the rotated state before retrying,
  then succeeds" (asserts `persist_state` called with bytes whose
  `refresh_token` is the new one, and that the old refresh token is
  rejected by the loopback afterwards); "expired token without
  persist_state refuses to refresh" (`misconfigured`, no token request
  made); "refresh failure reports unauthenticated and stops"; "5xx retries
  once then reports degraded"; "network failure reports unreachable";
  "a 4 MiB+ body is rejected as provider_error".
- `revoke.test.ts` — "revoke calls DELETE /v2/user/access and disables
  health"; "revoke treats 401 as already revoked".
- `redaction.test.ts` — with the loopback returning bodies that contain a
  planted marker string and both fixture tokens: assert none of
  `manifest()`, `JSON.stringify(health())`, any thrown `Error.message`,
  any cursor, any event `text`/`metadata` (except `metadata.record`,
  which is the provider record by contract) and `fixture()` contain the
  access token, the refresh token, the client secret or the marker; assert
  the access token never appears in a request URL recorded by the loopback.
- `client.test.ts` — header set, timeout via `AbortSignal`, `X-RateLimit-Reset`
  parsing (present, missing, garbage), `records`/`next_token` shape
  validation, base-URL override restriction.
- `smoke.test.ts` — `test.skipIf(!process.env.KIZUKI_WHOOP_SMOKE)`: real
  sign-in against WHOOP using `WHOOP_CLIENT_ID`/`WHOOP_CLIENT_SECRET` from
  the environment, one page per collection, prints counts only. Never runs
  in CI.

Target: ≥ 45 new tests in the package plus the two registry-level ones.

## Acceptance

```
cd <worktree>
bun install                                             # regenerates bun.lock with the new workspace package; commit it
bun install --frozen-lockfile                           # exit 0 on the committed lockfile
bun run typecheck                                       # exit 0
bun test packages/connector-whoop                       # green; ≥ 45 tests
bun test packages/connectors                            # green; conformance list includes the whoop result
bun test                                                # green
bun run scripts/verify-network.ts                       # "network source verification passed" with exactly the two whoop allowlist entries
bun run verify                                          # exit 0 (identifier denylist, attribution, lockfile, network scan, full tests)
bun -e 'const m = await import("./packages/connector-whoop/src/index.ts"); const c = m.createWhoopConnector({ resolve: async () => { throw new Error("none"); } }); console.log(JSON.stringify(c.manifest()))'
                                                        # prints the manifest of §1.1 verbatim (kinds, capabilities, required_secrets [], auth_modes ["oauth"])
KIZUKI_WHOOP_CLIENT_ID= KIZUKI_WHOOP_CLIENT_SECRET= bun -e 'const m = await import("./packages/connector-whoop/src/index.ts"); const c = m.createWhoopConnector({ resolve: async () => { throw new Error("none"); } }); try { await c.signIn({ prompt: async () => "", notify() {}, openUrl: async () => {} }, { write: async () => {} }); console.log("WRONG: signed in"); } catch (e) { console.log(e.message === m.NO_CLIENT_MESSAGE ? "REFUSED_AS_DOCUMENTED" : "WRONG: " + e.message); }'
                                                        # prints REFUSED_AS_DOCUMENTED
bun -e 'const m = await import("./packages/connector-whoop/src/index.ts"); const c = m.createWhoopConnector({ resolve: async () => { throw new Error("none"); } }); const f = await c.fixture(); console.log(f.length, f.every(e => e.sensitivity_hint === "private" && e.connector_id === "kizuki.whoop"))'
                                                        # prints: 10 true
git grep -n -E 'fetch\(|Bun\.serve|node:http|node:net' -- packages/connector-whoop
                                                        # hits only in src/client.ts and test/loopback.ts
git grep -n -E 'fixture-access-token|fixture-refresh-token|acme-client-secret' -- packages/connector-whoop/src
                                                        # hits only in src/fixture.ts (the fixture api's accepted token); no secret value anywhere else in src
git diff --stat main..HEAD -- 'packages/*/package.json' bun.lock | cat
                                                        # exactly packages/connector-whoop/package.json (new), packages/connectors/package.json, bun.lock
git status --porcelain                                  # empty
```

## 11. Open items recorded for the implementer (not blockers for the tests)

- WHOOP's docs do not state that loopback redirect URLs are accepted by
  the Developer Dashboard, nor that `code_challenge` is accepted on the
  authorization request. The manual smoke (`KIZUKI_WHOOP_SMOKE=1`) is the
  proof; if the dashboard rejects `http://127.0.0.1:48412/callback`, the
  README switches the registered value to `http://localhost:48412/callback`
  (already accepted by `parseRedirectUri`) and, if PKCE is rejected,
  oauth-core needs a per-provider `pkce: false` switch — record the outcome
  in the README's "facts checked" line.
