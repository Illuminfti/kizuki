# Lane: connector-google — Gmail + Calendar, read-only, on the core OAuth helper

Reconciled against `main` @ `76930db` (2026-09-02). Every path, symbol and
flag below was grepped on that revision; anything not on main is marked NEW
with its intended location. **Depends on `oauth-core`** (everything under
`packages/core/src/auth/`, `KizukiError` in core, `ConnectionStateStore.rewrite`,
`createStatePersister`, the network allowlist).

Package(s): NEW `packages/connector-google` (`@kizuki/connector-google`, zero
runtime dependencies beyond `@kizuki/core`), one registry entry in
`packages/connectors` (+ its `package.json` workspace link and `bun.lock`),
one allowlist line in `scripts/network-allowlist.txt`, a package README.

Read, in order: `CONVENTIONS.md`; `docs/architecture.md` ("Sign-in, not
setup", invariants 6, 7, 8, 10); `rfcs/0000-constraints.md`; `AGENTS.md`,
`packages/connectors/AGENTS.md` (contract discipline, provider research),
`.agents/skills/connector-work/SKILL.md` (the research packet you must
record in the README); `oauth-core.md` (this lane's substrate — §2 to §6);
`packages/core/src/contracts/connector.ts`; `packages/core/src/contracts/event.ts`
(`CaptureEventInput`, `SubjectRef`, `AttachmentRef`); `packages/core/src/util/hash.ts`
(what feeds `content_hash`: `connector_id, source_record_id, kind, occurred_at,
text, subjects, deleted, metadata` — so `metadata` must hold only stable
fields); `packages/core/src/ingest/run.ts` (`runBackfill`/`runSync` are
single-batch; `runToCompletion` is NEW in connector-telegram §7);
`packages/connectors/src/{registry,conformance,index,util}.ts` and
`packages/connectors/src/import-chatgpt/index.ts` (fixture constant + mapper
style); `packages/connectors/test/conformance.test.ts` (the registry case you
extend); `packages/core/test/connections.test.ts` (fixture `signIn` shape);
`connector-telegram.md` §4 (host hand-off convention) and §7; `ci-hardening.md`
§3 (`app-credentials.ts`). Plan: `workspace/kizuki-plan/ARCHITECTURE.md` §3.1
("Google = installed-app OAuth (Gmail + Calendar read-only)"), §3.2
(conformance), §2.2 (tombstones cascade), §10.

## Already on main (do not redo)

- The whole opaque-state sign-in contract (`signIn(io, state)`, core-minted
  `source_key`, `enrollConnection`, `ConnectionStateStore.read/replace`,
  connections CHECK constraints) — see oauth-core "Already on main".
- Three registry connectors and the conformance battery
  (`runConformance(connector, { backfillTwice?, tombstone? })`): manifest
  honesty, fixture round-trip through `InMemoryLedger`, backfill/sync shape,
  purge plan shape, fail-closed `connect` when `required_secrets` is
  non-empty, double-backfill dedupe, tombstone emission when
  `capabilities.tombstones` (hooks mandatory).
- `KizukiError` codes `unknown_connector | parse_error | missing_secret | misconfigured`
  (oauth-core adds `unauthenticated | rate_limited | unreachable | provider_error`
  and moves the class to core).

Stale in the previous version of this spec (fixed below): `signIn` →
`userinfo` → "`source_key` = the email" (core mints the key; the email is
the `display` and lives inside the state envelope); "tokens saved as `file:`
ref" (one opaque envelope through the writer); `src/app-credentials.ts` in
this package (ci-hardening §3 is the one door; §3 below consumes it);
`kinds` unchanged; "Gmail trash are tombstones" (only permanent deletion is
observable as a deletion; §6.6 states the honest rule); "`scripts/network-allowlist.txt`
with reasons" — still the plan, in the format oauth-core §8 fixes.

## Objective

`kizuki connect google` opens the owner's browser on Google's consent screen
(Gmail read-only, Calendar read-only, email address), they click allow, the
terminal prints `connected kizuki.google …`. No Cloud Console, no client id
pasted: the project's installed-app OAuth client is compiled into the binary
(ci-hardening §3); the owner's tokens live in one 0600 state file under
`<vault>/.kizuki/connections/` and nowhere else. Backfill walks every
message and every calendar event the account can read, incremental sync
follows Gmail history and Calendar sync tokens and emits tombstones for
permanent deletions and cancellations, refresh tokens are refreshed and
persisted through the helper, and the conformance suite runs on a synthetic
account with no network. Read-only forever: `outbound_actions` do not exist.

## 1. Package layout

```
packages/connector-google/
  package.json          # name @kizuki/connector-google, type module, module src/index.ts,
                        # exports { ".": "./src/index.ts" }, dependencies { "@kizuki/core": "workspace:*" } — nothing else
  README.md             # what it captures, sign-in steps, publishing-status caveat, limits, research packet (§9)
  src/
    index.ts            # public exports (§8)
    provider.ts         # googleProvider(credentials): OAuthProvider — endpoints + scopes (§2)
    api.ts              # GoogleApi interface, raw record types, GoogleApiError, TokenSource (§4)
    client.ts           # createGoogleApi(): the ONLY file that calls fetch (allowlisted) (§4)
    fake-api.ts         # FakeGoogleApi + GOOGLE_FIXTURE + FIXTURE_STATE: powers fixture() and every test (§7)
    cursor.ts           # kizuki.google-cursor/v1 encode/parse (§6.3)
    gmail.ts            # mapGmailMessage, parseAddressList, bodyText, stripHtml (§6.4)
    calendar.ts         # mapCalendarEvent (§6.5)
    connector.ts        # GoogleConnector: manifest/signIn/connect/health/backfill/sync/revoke/purgeSource/fixture (§5, §6)
  test/
    credentials.test.ts  signin.test.ts  connect.test.ts  health.test.ts
    gmail.test.ts  calendar.test.ts  cursor.test.ts  backfill.test.ts  sync.test.ts
    client.test.ts  revoke.test.ts  purge.test.ts  redaction.test.ts  conformance.test.ts
```

Keep every file under ~400 lines. `tsconfig.json` already includes
`packages/*/src/**/*.ts` and `packages/*/test/**/*.ts`; `bun test` at the
root discovers the new `test/` directory with no config change. Run
`bun install` once so `bun.lock` records the workspace; commit the lockfile
(CI installs with `--frozen-lockfile`).

## 2. Provider definition (`src/provider.ts`)

```ts
export const GOOGLE_SCOPES = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/calendar.readonly",
] as const;

export function googleProvider(credentials: {
  client_id: string;
  client_secret: string;
}): OAuthProvider;
// {
//   name: "google",
//   authorization_url: "https://accounts.google.com/o/oauth2/v2/auth",
//   token_url: "https://oauth2.googleapis.com/token",
//   revocation_url: "https://oauth2.googleapis.com/revoke",
//   client_id, client_secret, scopes: [...GOOGLE_SCOPES],
//   extra_authorization_params: { access_type: "offline", prompt: "consent" },
// }
```

`access_type=offline` + `prompt=consent` make Google return a refresh token on
every sign-in (it otherwise omits it on repeat consents). Endpoint constants
also live here: `USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo"`,
`GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me"`,
`CALENDAR_BASE = "https://www.googleapis.com/calendar/v3"`. The implementer
verifies all five URLs and the four scopes against Google's current OAuth,
Gmail API and Calendar API reference pages and records the check date in the
README (§9); do not copy this spec's date.

## 3. App credentials — consume the one door

`appCredentialGroup("google")` and `appCredentialRefusal("google")` from
`packages/core/src/app-credentials.ts` (NEW in ci-hardening §3, exported from
`@kizuki/core`). `values` carries `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`
when `source !== "placeholder"`; otherwise `values` is `{}` and sign-in is
refused with exactly `appCredentialRefusal("google")`:

```
google: app credentials are not compiled into this build (KIZUKI_GOOGLE_CLIENT_ID, KIZUKI_GOOGLE_CLIENT_SECRET); sign-in is refused. Set them when building (bun run build) or export them when running from source. See README: Build a binary.
```

If ci-hardening has not landed when this lane starts, implement ci-hardening
§3 verbatim (that module, its export, its surface-test entry and
`packages/core/test/app-credentials.test.ts`) as the first commit of this
lane; whichever lane lands second reconciles to one file. This package never
reads `process.env` or a build define itself. The Google "client secret" of
an installed-app client is not confidential (Google documents this) and is
still required by the token endpoint; it is compiled in like the id and
never printed.

## 4. The `GoogleApi` seam (`src/api.ts`) and the real client (`src/client.ts`)

```ts
export interface TokenSource {
  accessToken(): Promise<string>;
  refresh?(): Promise<void>;
}

export interface GmailHeader {
  name: string;
  value: string;
}
export interface GmailBody {
  size: number;
  data?: string;
  attachmentId?: string;
}
export interface GmailPart {
  mimeType: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: GmailBody;
  parts?: GmailPart[];
}
export interface GmailMessage {
  id: string;
  threadId: string;
  internalDate: string; // epoch milliseconds as a decimal string
  sizeEstimate?: number;
  payload?: GmailPart;
}
export interface GmailHistoryPage {
  history: {
    id: string;
    messagesAdded?: { message: { id: string; threadId: string } }[];
    messagesDeleted?: { message: { id: string; threadId: string } }[];
  }[];
  nextPageToken: string | null;
  historyId: string;
}
export interface CalendarListEntry {
  id: string;
  summary: string;
  accessRole: string;
  primary?: boolean;
  deleted?: boolean;
  hidden?: boolean;
}
export interface CalendarDateTime {
  dateTime?: string;
  date?: string;
  timeZone?: string;
}
export interface CalendarAttendee {
  email?: string;
  displayName?: string;
  responseStatus?: string;
  self?: boolean;
  organizer?: boolean;
}
export interface CalendarEvent {
  id: string;
  status: "confirmed" | "tentative" | "cancelled";
  summary?: string;
  description?: string;
  location?: string;
  start?: CalendarDateTime;
  end?: CalendarDateTime;
  attendees?: CalendarAttendee[];
  organizer?: { email?: string; displayName?: string; self?: boolean };
  recurringEventId?: string;
  htmlLink?: string;
}
export interface CalendarEventsPage {
  items: CalendarEvent[];
  nextPageToken: string | null;
  nextSyncToken: string | null;
}

export interface GoogleApi {
  userinfo(): Promise<{ sub: string; email: string }>;
  gmailProfile(): Promise<{ emailAddress: string; historyId: string }>;
  gmailListMessages(q: {
    pageToken: string | null;
    query?: string;
    maxResults: number;
  }): Promise<{ ids: string[]; nextPageToken: string | null }>;
  gmailGetMessage(id: string): Promise<GmailMessage>; // format=full
  gmailHistory(q: {
    startHistoryId: string;
    pageToken: string | null;
    maxResults: number;
  }): Promise<GmailHistoryPage>;
  calendarList(
    pageToken: string | null,
  ): Promise<{ items: CalendarListEntry[]; nextPageToken: string | null }>;
  calendarEvents(
    calendarId: string,
    q: {
      pageToken: string | null;
      syncToken: string | null;
      query?: string;
      maxResults: number;
    },
  ): Promise<CalendarEventsPage>;
}
export type GoogleApiFactory = (auth: TokenSource) => GoogleApi;

export class GoogleApiError extends Error {
  readonly status: number;
  readonly reason: string | null; // Google's error reason/status string, ≤ 64 chars, or null
  readonly retryAfterSeconds: number | null;
  constructor(
    status: number,
    reason?: string | null,
    retryAfterSeconds?: number | null,
  );
}
```

`src/client.ts` — `createGoogleApi(auth: TokenSource, fetchImpl: typeof fetch = fetch): GoogleApi`
— is the only file in the package that names `fetch` (allowlisted:
`packages/connector-google/src/client.ts:Gmail and Calendar REST reads for the owner's connected Google account (fetch)`).
Every call: `GET` with `Authorization: Bearer <await auth.accessToken()>`,
`accept: application/json`, `signal: AbortSignal.timeout(30_000)`,
`redirect: "error"`; query parameters through `URLSearchParams` (the query
string is never built by concatenation). Wire shapes:

- `userinfo` → `USERINFO_URL`; `gmailProfile` → `GMAIL_BASE/profile`;
  `gmailListMessages` → `GMAIL_BASE/messages?maxResults=&pageToken=&includeSpamTrash=false[&q=]`
  (`ids` = `messages[].id`, `[]` when the field is absent);
  `gmailGetMessage` → `GMAIL_BASE/messages/<id>?format=full`;
  `gmailHistory` → `GMAIL_BASE/history?startHistoryId=&historyTypes=messageAdded&historyTypes=messageDeleted&maxResults=&pageToken=`
  (`history` = `[]` when absent);
  `calendarList` → `CALENDAR_BASE/users/me/calendarList?showDeleted=false&showHidden=false&pageToken=`;
  `calendarEvents` → `CALENDAR_BASE/calendars/<encodeURIComponent(id)>/events?singleEvents=true&showDeleted=true&maxResults=&pageToken=|syncToken=[&q=]`.
  No `orderBy`, `timeMin` or `timeMax` — Google returns no `nextSyncToken`
  when those are present.
- Status handling: 401 → `await auth.refresh?.()` and retry the same request
  once; a second 401 → `GoogleApiError(401, reason)`. 429, or 403 whose
  reason is one of `rateLimitExceeded | userRateLimitExceeded | quotaExceeded | dailyLimitExceeded`
  → `GoogleApiError(status, reason, <Retry-After header as integer seconds or null>)`.
  Other non-2xx → `GoogleApiError(status, reason)`. `reason` = first of
  `body.error.errors[0].reason`, `body.error.status` that is a string, cut
  to 64 chars; never the message. A thrown `fetch` (DNS, refused, timeout)
  → `KizukiError("unreachable", "kizuki.google: Google is unreachable: <error.name>")`.
  Response text over 8 MiB, or a 2xx that is not a JSON object →
  `KizukiError("parse_error", "kizuki.google: malformed response from <endpoint name>")`.
- Nothing in this file logs, and no thrown message contains a URL query, a
  header, a token, or a body.

## 5. Connector construction, manifest, sign-in, connect, health, revoke (`src/connector.ts`)

```ts
export const GOOGLE_CONNECTOR_ID = "kizuki.google" as const;

export interface GoogleConnectorConfig {
  /** The connection's single secret_ref, `file:connections/<source_key>.state`, once signed in. */
  state_ref?: string;
  /** Host-lent persister for refreshed tokens (createStatePersister(...).persist); required with state_ref. */
  persist?: StatePersister;
}
export interface GoogleDeps {
  api: GoogleApiFactory; // createGoogleApi by default
  transport: OAuthTransport; // loopbackTransport() by default
  credentials: () => AppCredentialSet; // () => appCredentialGroup("google") by default
  now: () => Date; // () => new Date()
}
export class GoogleConnector implements Connector {
  constructor(config: GoogleConnectorConfig, deps?: Partial<GoogleDeps>);
}
export function createGoogleConnector(
  config: GoogleConnectorConfig,
): GoogleConnector; // real deps; what the registry calls
export function scriptedDeps(fake?: FakeGoogleApi): GoogleDeps; // fake api + FakeTransport + fixture credentials + fixed clock; for tests and conformance
```

`config` is validated with `isPlainObject`; a `state_ref` present but not a
string matching `^file:connections/[0-9A-HJKMNPQRSTVWXYZ]{26}\.state$`, or a
`persist` present but not a function, throws `KizukiError("misconfigured", …)`
at construction (the regex mirrors `stateRefFor` in core's
`connection-state.ts`).

### 5.1 `manifest()`

```ts
{
  schema: "kizuki.connector/v1", connector_id: "kizuki.google", version: "0.1.0",
  kinds: ["email", "calendar_event"],
  capabilities: { backfill: true, sync: true, tombstones: true, purge: true, fixture: true },
  required_secrets: [],           // the envelope is created by sign-in, not required up front
  emits_sensitivity_hint: true,
  auth_modes: ["oauth"],
}
```

### 5.2 `signIn(io, state)`

1. `creds = deps.credentials()`; `creds.source === "placeholder"` → throw
   `KizukiError("misconfigured", appCredentialRefusal("google"))` before any
   listener or network.
2. `tokens = await signInWithBrowser(googleProvider(values), io, deps.transport)`.
3. `api = deps.api({ accessToken: async () => tokens.access_token })`;
   `info = await api.userinfo()`; `info.sub` and `info.email` must be
   non-empty strings else `KizukiError("provider_error", "kizuki.google: userinfo did not identify the account")`.
4. `await state.write(encodeOAuthState({ schema, provider: "google", account: { id: info.sub, display: info.email }, tokens, written_at: now }))`
   — exactly one write, only after userinfo succeeded.
5. Return `{ display: info.email }`.

Any throw leaves nothing durable (core discards the pending state — already
tested in core). `signIn` never reads `state_ref`; a signed-in connector may
sign in again through `store.replace`, which calls this same method.

### 5.3 `connect(resolve)`

- No `state_ref` and no injected fake api → throw
  `KizukiError("unauthenticated", "kizuki.google: not signed in; run: kizuki connect google")`.
- `state_ref` without `persist` → throw
  `KizukiError("misconfigured", "kizuki.google: host did not lend a state persister; refusing to run without one")`
  (fail closed, oauth-core §6).
- `creds` placeholder → the same refusal as §5.2 (refresh needs the client id).
- `text = await resolve(state_ref)` (a resolver throw is wrapped as
  `KizukiError("unauthenticated", "kizuki.google: connection state is unavailable; run: kizuki connect google")`);
  `parsed = parseOAuthState(text, "google")` (an `OAuthError("invalid_state")`
  is re-thrown as `KizukiError("misconfigured", "kizuki.google: connection state is corrupt; run: kizuki connect google")`);
  `session = new OAuthSession({ provider, state: parsed, transport: deps.transport, persist, now: deps.now })`;
  `api = deps.api(session)`.
- `info = await api.userinfo()`; `info.sub !== session.account.id` → throw
  `KizukiError("unauthenticated", "kizuki.google: signed-in account does not match the stored connection")`.
  Stores `api`, `session`, `self = info`. Never opens a browser.
- With a fake api injected through `deps` and no `state_ref` (conformance,
  tests), `connect` skips the envelope and the account check, calls
  `userinfo()` once, and succeeds — `scriptedDeps()` is the only way to get
  there; `createGoogleConnector` always uses the real factory.

### 5.4 `health()` — never throws, always a `HealthReport`

| state             | when                                                                                               | detail                                                 |
| ----------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `disabled`        | no `state_ref` and no api                                                                          | `not signed in`                                        |
| `unauthenticated` | `connect()` not yet succeeded, or the last call raised 401 / `refresh_rejected` / account mismatch | `sign in again: kizuki connect google`                 |
| `rate_limited`    | `deps.now() < rateLimitedUntil` (set by any 429/403-quota; `Retry-After` seconds, default 60)      | `retry after <n>s`                                     |
| `unreachable`     | the probe or the last call raised `unreachable`                                                    | `Google is unreachable`                                |
| `degraded`        | the probe returned another non-2xx                                                                 | `Google returned HTTP <status>`                        |
| `ok`              | `await api.gmailProfile()` succeeded (1 quota unit)                                                | — ; `last_success_at` = last successful probe or batch |

The probe runs only in the `ok`/`degraded`/`unreachable` branches (never
while rate limited). `detail` never contains captured text, an email address,
or a token.

### 5.5 `revoke()`

If connected: `token = session.tokens().refresh_token ?? session.tokens().access_token`;
`await revokeToken(provider, token, deps.transport)` (Google's endpoint
revokes the whole grant for either token type); then `session.forget()`;
`health()` reports `unauthenticated` afterwards. `OAuthError("transport")`
is re-thrown as `KizukiError("unreachable", …)` so the host does not believe
access ended; `provider_error` → `KizukiError("provider_error", …)`. Not
connected → no-op. Removing the state file and marking the row is the host's
job (`disconnect(db, …)` marks the row; no `kizuki disconnect` verb exists
on main — see the lane report's open questions).

## 6. Backfill, sync, cursor, mapping, purge, fixture

### 6.1 Bounds

`GMAIL_PAGE = 100` (messages listed per page), `HISTORY_PAGE = 100`,
`CALENDAR_PAGE = 250`, `MAX_EVENTS_PER_CALL = 500` (a `backfill`/`sync` call
returns once its batch reaches this, cursor pointing at the next unprocessed
page), `MAX_CALENDARS = 200`, `MAX_LIST_PAGES = 20` (calendarList),
`MAX_BODY_CHARS = 256_000`, `MAX_ADDRESSES = 100` per header,
`MAX_ATTACHMENTS = 100`, `MAX_PURGE_IDS = 10_000`. All exported from
`src/connector.ts`.

### 6.2 `backfill(cursor)`

- `cursor === null` → `profile = await api.gmailProfile()`; cursor =
  `{ gmail: { phase: "backfill", page_token: null, history_id: profile.historyId, history_page_token: null }, calendar_list: { phase: "list", page_token: null }, calendars: {} }`.
  Recording `history_id` BEFORE the walk means the first `sync` catches
  everything that changed during a long backfill.
- Loop until `events.length ≥ MAX_EVENTS_PER_CALL` or nothing is left:
  1. `gmail.phase === "backfill"` → one list page (`GMAIL_PAGE`,
     `page_token`); for each id `gmailGetMessage` (a 404 skips: the message
     vanished between list and get) → `mapGmailMessage`; `page_token = nextPageToken`;
     null → `gmail.phase = "sync"`.
  2. else `calendar_list.phase === "list"` → one `calendarList` page; every
     entry with `deleted !== true` and `hidden !== true` gets
     `calendars[id] = { summary, phase: "backfill", page_token: null, sync_token: null }`
     (existing entries keep their phase; entries beyond `MAX_CALENDARS` are
     dropped and `health()` says `degraded` with `calendar limit reached (200)`
     until the next successful probe); `nextPageToken` null → `phase: "done"`.
  3. else the first calendar (ids sorted ascending as strings) with
     `phase === "backfill"` → one events page (`pageToken`, no syncToken);
     `status === "cancelled"` items are skipped during backfill (nothing to
     retract yet); others → `mapCalendarEvent`; `nextPageToken` → `page_token`;
     when the last page arrives, `sync_token = nextSyncToken`, `phase = "sync"`
     (a last page without `nextSyncToken` is `KizukiError("provider_error", "kizuki.google: calendar <n> returned no sync token")`).
  4. else stop: the cursor is terminal — return `{ events: [], cursor }`
     with the cursor string byte-identical to the input.
- `observed_at` = one timestamp per call (`deps.now().toISOString()`).
- A `backfill` cursor is therefore never `null` after the first call: a live
  source is never "exhausted"; the terminal cursor is the sync anchor.
  `runToCompletion` (connector-telegram §7) stops on the empty terminal
  batch; if it is not on main when this lane starts, add it exactly as that
  section specifies (it is the only core change either lane makes to
  `ingest/run.ts`; the second lane to land finds it and skips).
- Errors from the api propagate as thrown `KizukiError`s (§4 mapping, plus
  `GoogleApiError` 401 → `unauthenticated`, 429/403-quota → `rate_limited`
  with `rateLimitedUntil` set, other → `provider_error`; `OAuthError
("refresh_rejected")` from the session → `unauthenticated`). `runBackfill`
  then leaves the previous checkpoint in place; the in-flight page is simply
  re-fetched next time. Partial batches are never returned on error.

### 6.3 Cursor (`src/cursor.ts`)

```ts
export const GOOGLE_CURSOR_SCHEMA = "kizuki.google-cursor/v1" as const;
export interface GmailCursor {
  phase: "backfill" | "sync";
  page_token: string | null; // backfill list page in progress
  history_id: string; // sync anchor
  history_page_token: string | null; // history page in progress
}
export interface CalendarCursor {
  summary: string; // calendar title, captured text (display only)
  phase: "backfill" | "sync";
  page_token: string | null; // page in progress (full or incremental listing)
  sync_token: string | null; // present from the end of backfill on
}
export interface GoogleCursor {
  schema: typeof GOOGLE_CURSOR_SCHEMA;
  gmail: GmailCursor;
  calendar_list: { phase: "list" | "done"; page_token: string | null };
  calendars: Record<string, CalendarCursor>; // key = calendar id
}
export function encodeCursor(cursor: GoogleCursor): string; // JSON with keys sorted at every depth (byte-stable)
export function parseCursor(cursor: string): GoogleCursor; // KizukiError("parse_error") on wrong schema, extra keys, bad shapes, > MAX_CALENDARS entries
```

A cursor never holds a token, an email address or message text; `summary`
is the only captured string and is never echoed into errors.

### 6.4 Gmail mapping (`src/gmail.ts`)

`mapGmailMessage(message: GmailMessage, observed_at: string): CaptureEventInput`

| field              | value                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `source_record_id` | `` `gmail:${message.id}` ``                                                                                                                                                                                                                                                                                                                                                           |
| `kind`             | `"email"`                                                                                                                                                                                                                                                                                                                                                                             |
| `occurred_at`      | `new Date(Number(internalDate)).toISOString()`; a non-finite value → `observed_at`                                                                                                                                                                                                                                                                                                    |
| `observed_at`      | the batch timestamp                                                                                                                                                                                                                                                                                                                                                                   |
| `text`             | `` `${subject}\n\n${body}` `` where `subject` is the `Subject` header (`""` if absent) and `body` is `bodyText(payload)`                                                                                                                                                                                                                                                              |
| `subjects`         | `From` → role `from`; `To` and `Cc` → role `to`; `subject_id = email:<lowercased address>`, `display_name` when the header carried one; deduped on `(subject_id, role)`; order = header order                                                                                                                                                                                         |
| `sensitivity_hint` | `"personal"`                                                                                                                                                                                                                                                                                                                                                                          |
| `deleted`          | `false`                                                                                                                                                                                                                                                                                                                                                                               |
| `attachments`      | every leaf part with a non-empty `filename` and `body.attachmentId`: `{ attachment_id: attachmentId, media_type: mimeType, filename, byte_size: body.size }`, ≤ `MAX_ATTACHMENTS`; references only, never downloaded                                                                                                                                                                  |
| `metadata`         | `{ thread_id, message_id: <Message-ID header or null>, in_reply_to: <header or null>, references: <header split on whitespace, ≤ 50, or []>, size_estimate: <number or null>, truncated: <true only when the body was cut> }` — **no `labelIds`, `historyId`, `snippet`**: labels flip on every read/star and `historyId` moves with them; both would fork the hash on re-observation |

Helpers, exported for tests:

- `parseAddressList(header: string): { address: string; name?: string }[]` —
  splits on commas outside double quotes and angle brackets; accepts
  `Name <addr>`, `"Quoted, Name" <addr>`, `<addr>`, `addr`; `address` must
  match `^[^\s@<>"]+@[^\s@<>"]+$` after trimming and is lowercased; malformed
  items are dropped; ≤ `MAX_ADDRESSES`. Gmail's API already decodes RFC 2047
  encoded-words in `payload.headers`; group syntax is not supported (stated
  in the README).
- `bodyText(payload?: GmailPart): { text: string; truncated: boolean }` —
  depth-first over `parts`; the first leaf whose `mimeType` is `text/plain`
  with `body.data` wins (base64url-decoded as UTF-8); else the first
  `text/html` leaf through `stripHtml`; else `""`. Parts under
  `message/rfc822` are not descended. Cut at `MAX_BODY_CHARS` code points
  with `truncated: true`.
- `stripHtml(html: string): string` — drops `<script>`/`<style>` blocks and
  comments; `<br>`, `</p>`, `</div>`, `</li>`, `</tr>`, `</h1..6>` become
  newlines; every other tag is removed; decodes `&amp; &lt; &gt; &quot;
&#39; &apos; &nbsp;` and numeric `&#NNN;` / `&#xHH;`; collapses runs of
  more than two newlines and trims.
- A message whose payload cannot be parsed (missing `payload`, undecodable
  base64) still yields an event with `text: ""`, the header subjects it
  could parse, and `metadata.capture_error: "malformed"` — evidence that a
  record exists is kept, never silently dropped.

### 6.5 Calendar mapping (`src/calendar.ts`)

`mapCalendarEvent(calendar: { id: string; summary: string }, event: CalendarEvent, observed_at: string): CaptureEventInput`

| field              | value                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `source_record_id` | `` `calendar:${calendar.id}/${event.id}` ``                                                                                                                                                                                                                                                                                                                                                        |
| `kind`             | `"calendar_event"`                                                                                                                                                                                                                                                                                                                                                                                 |
| `occurred_at`      | `start.dateTime` when it passes `isRfc3339`; else `start.date` → `` `${date}T00:00:00Z` ``; else `observed_at`                                                                                                                                                                                                                                                                                     |
| `text`             | `` `${summary ?? ""}\n\n${stripHtml(description ?? "")}` `` (descriptions may be HTML)                                                                                                                                                                                                                                                                                                             |
| `subjects`         | organizer (`email:`) → `from`; every attendee with an `email` (`email:`) → `to`, `display_name` = `displayName` when present; the calendar → `about` with `subject_id = calendar:<calendar.id>`, `display_name = calendar.summary`; deduped on `(subject_id, role)`; ≤ 200 attendees                                                                                                               |
| `sensitivity_hint` | `"personal"`                                                                                                                                                                                                                                                                                                                                                                                       |
| `deleted`          | `status === "cancelled"` (§6.6)                                                                                                                                                                                                                                                                                                                                                                    |
| `attachments`      | `[]`                                                                                                                                                                                                                                                                                                                                                                                               |
| `metadata`         | `{ calendar_id, status, all_day: <boolean>, start: { date_time: string\|null, date: string\|null, time_zone: string\|null }, end: <same shape>, location: string\|null, recurring_event_id: string\|null, self_response: <responseStatus of the attendee with self === true, or null>, html_link: string\|null }` — no `etag`, `updated`, `sequence`, `iCalUID`, `created` (volatile or redundant) |

A tombstone (cancelled) carries `text: ""`, `subjects: []`, `attachments: []`
and `metadata: { calendar_id, status: "cancelled" }`.

### 6.6 `sync(cursor)`

- `null` → identical to `backfill(null)`.
- Any of `gmail.phase === "backfill"`, `calendar_list.phase === "list"`, or a
  calendar in `backfill` phase → delegate to `backfill(cursor)` (finish the
  walk before following changes).
- Gmail history: pages of `HISTORY_PAGE` from `history_id`
  (`history_page_token` resumes an interrupted pass). Per record:
  `messagesAdded` → `gmailGetMessage` (404 → skip) → `mapGmailMessage`;
  `messagesDeleted` → tombstone
  `{ source_record_id: "gmail:<id>", kind: "email", occurred_at: observed_at, text: "", subjects: [], deleted: true, attachments: [], metadata: { thread_id } }`.
  Once the last page is consumed, `history_id = page.historyId`,
  `history_page_token = null`. A 404 from `gmailHistory` (Google expired the
  history id) → `gmail = { phase: "backfill", page_token: null, history_id: (await gmailProfile()).historyId, history_page_token: null }`
  and the call returns what it has; the next call re-walks the mailbox
  (every unchanged message dedupes in the ledger). Honest rule: only
  permanent deletion is a deletion. Trashed messages stay in the ledger for
  Gmail's own 30-day window and become tombstones when Gmail purges them.
- Calendars: re-list (`MAX_LIST_PAGES`) — new ids enter in `backfill` phase
  (walked on the next call through the delegation rule); ids that vanished
  from the list are removed from the cursor without tombstones (the owner
  lost access; their events are not known to be deleted — stated in the
  README). For each calendar in `sync` phase: incremental pages
  (`syncToken` for the first page, `pageToken` for continuation pages —
  Google forbids sending both); `cancelled` → tombstone; others →
  `mapCalendarEvent`; the last page's `nextSyncToken` replaces `sync_token`.
  A 410 → `{ phase: "backfill", page_token: null, sync_token: null }` for
  that calendar (full re-walk, dedupes).
- Bound: stop at `MAX_EVENTS_PER_CALL` with the page tokens preserved; the
  next call continues. A caught-up sync returns `{ events: [], cursor }`
  with the cursor byte-identical only when nothing moved; Gmail's
  `historyId` and Calendar's `nextSyncToken` change whenever anything did.
- Errors: as in §6.2.

### 6.7 `purgeSource(subject_id)`

`subject_id` must match `^email:[^\s@<>"]+@[^\s@<>"]+$`; anything else (the
conformance suite's `conformance:subject` included) → `{ subject_id, source_record_ids: [], unreachable_source_record_ids: [] }`
with no api call. Otherwise, connected: Gmail
`gmailListMessages({ query: "from:<addr> OR to:<addr> OR cc:<addr>" })` up
to 10 pages → `gmail:<id>`; Calendar: `calendarList` then
`calendarEvents(id, { query: "<addr>", syncToken: null })` up to 4 pages per
calendar → `calendar:<id>/<eventId>`; everything (≤ `MAX_PURGE_IDS`) goes
under `unreachable_source_record_ids` and `source_record_ids` stays `[]`:
read-only scopes can see these records and cannot remove any of them at
Google. Not connected → `KizukiError("unauthenticated", …)`.

### 6.8 `fixture()`

`new GoogleConnector({}, scriptedDeps(new FakeGoogleApi(GOOGLE_FIXTURE)))`
drained through repeated `backfill` calls from `null` until the terminal
batch, with the fixed clock `2026-01-01T00:00:00.000Z` — so `fixture()` and a
real backfill share one code path, need no credentials and no network. It
yields ≥ 10 `email` events and ≥ 6 `calendar_event` events, none deleted.

## 7. The scripted account (`src/fake-api.ts`)

```ts
export interface GoogleFixtureData {
  userinfo: { sub: string; email: string };
  profile: { emailAddress: string; historyId: string };
  messages: GmailMessage[]; // newest first, like Gmail
  calendars: { entry: CalendarListEntry; events: CalendarEvent[] }[];
}
export const GOOGLE_FIXTURE: GoogleFixtureData; // owner ada@acme.example (sub "100000000000000000001"), grace@acme.example, linus@example.org, team@acme.example; 12 messages (plain, html-only, multipart with a PDF attachment, one with Cc, one malformed payload), 2 calendars (primary + team) with 7 events incl. one all-day and one recurring instance
export const FIXTURE_STATE: OAuthState; // provider "google", account { id: sub, display: "ada@acme.example" }, tokens { access "fixture-access-token", refresh "fixture-refresh-token", expires 2099 }
export class FakeGoogleApi implements GoogleApi {
  constructor(seed?: GoogleFixtureData);
  readonly calls: { method: keyof GoogleApi; args: unknown[] }[];
  addMessage(message: GmailMessage): void; // bumps historyId, records messageAdded
  deleteMessage(id: string): void; // bumps historyId, records messageDeleted; gets → 404
  upsertEvent(calendarId: string, event: CalendarEvent): void; // bumps that calendar's sync token
  cancelEvent(calendarId: string, eventId: string): void;
  addCalendar(entry: CalendarListEntry, events?: CalendarEvent[]): void;
  removeCalendar(id: string): void;
  failNext(status: number, reason?: string, retryAfterSeconds?: number): void; // next call throws GoogleApiError
  expireHistory(): void; // gmailHistory → 404 until the next gmailProfile
  expireSyncToken(calendarId: string): void; // calendarEvents with syncToken → 410 once
  unreachableNext(): void; // next call throws KizukiError("unreachable")
}
```

Deterministic ordering everywhere (list order = seed order; history and
sync deltas in mutation order). Paging honours `maxResults`/`pageToken`
exactly like the real endpoints so the bounds in §6.1 are exercised.
`scriptedDeps(fake)` also supplies a `FakeTransport` whose `postForm`
answers refresh requests with a new `fixture-access-token-<n>` (rotating the
refresh token when the test asks) and fixture credentials with
`source: "env"`.

## 8. Registry and exports

- `packages/connectors/package.json`: add `"@kizuki/connector-google": "workspace:*"`.
- `packages/connectors/src/registry.ts`: import `GOOGLE_CONNECTOR_ID`,
  `createGoogleConnector` and `GoogleConnectorConfig`; add the `REGISTRY`
  entry, a `getConnector(id: typeof GOOGLE_CONNECTOR_ID, config: GoogleConnectorConfig): Connector`
  overload and `case`. Last step, after conformance passes (connectors
  AGENTS.md).
- `packages/connectors/src/index.ts`: re-export `GOOGLE_CONNECTOR_ID`,
  `GoogleConnector`, `createGoogleConnector`, `scriptedDeps`, `FakeGoogleApi`,
  `GOOGLE_FIXTURE`, `FIXTURE_STATE`, `GoogleApiError` and the types
  `GoogleConnectorConfig`, `GoogleDeps`, `GoogleApi`, `GoogleApiFactory`,
  `GoogleCursor`.
- `packages/connector-google/src/index.ts` exports everything above plus
  `googleProvider`, `GOOGLE_SCOPES`, `createGoogleApi`, `mapGmailMessage`,
  `parseAddressList`, `bodyText`, `stripHtml`, `mapCalendarEvent`,
  `encodeCursor`, `parseCursor`, `GOOGLE_CURSOR_SCHEMA`, the bounds of §6.1,
  and the raw record types of §4.
- `scripts/network-allowlist.txt`: append the `client.ts` line from §4.

## 9. Documentation (`packages/connector-google/README.md`)

- What it captures: every message in the Gmail mailbox (all labels except
  spam and trash at list time), every event on every calendar in the
  account's calendar list; read-only; attachments as references only.
- The sign-in as the owner sees it (browser consent; the fixed "you can
  close this tab" page; `connected kizuki.google …`), and the exact refusal
  text of §3 when a build carries no credentials.
- Publishing-status caveat, stated plainly: a Google Cloud OAuth client
  whose consent screen is in "Testing" issues refresh tokens that expire
  after 7 days; Kizuki then reports `unauthenticated` and the owner runs
  `kizuki connect google` again. The project's client must be published
  (with or without Google's verification) for long-lived tokens; the
  "unverified app" interstitial is what an unpublished-verification client
  shows. Record what you verified and when.
- Where state lives (`<vault>/.kizuki/connections/<source_key>.state`, 0600,
  never in the database), that a token refresh rewrites that file (and
  bumps `connected_at`), and that `kizuki export` never includes it.
- Limits: trash is not deletion; a calendar that disappears from the list is
  dropped without tombstones; new calendars are picked up on the next sync;
  RFC 5322 group syntax unsupported; bodies cut at 256 000 characters;
  `MAX_CALENDARS`; quota behaviour (429/403 → `rate_limited`, honoured, never
  bypassed); a Testing-status client's 7-day tokens.
- Purge semantics (§6.7): the plan lists what Google still holds; nothing is
  deleted at Google.
- Research packet (connector-work skill): sanctioned auth flow (installed-app
  OAuth 2.0 with PKCE, loopback redirect), scopes, one-time project setup
  (OAuth client of type Desktop app; consent screen; restricted-scope
  verification requirement for public distribution), end-user steps, token
  custody, history/sync-token expiry behaviour, deletion semantics, quota,
  and the check date. Say "verified against Google's documentation on
  <date>" with the date you actually checked.
- Run the `humanizer` pass. No real handles, addresses or account names; no
  identifier from the denylist.

## Non-goals

- CLI verbs (`connect google`, `backfill`, `sync`, `doctor` lines) and the
  terminal `SignInIo`: the CLI lanes wire `enrollConnection`, the resolver +
  `persist` hand-off of oauth-core §6, and `runToCompletion`.
- Sending, labelling, archiving or deleting anything at Google; attachment
  downloads; Contacts/People API; shared drives; Google Chat; multiple
  accounts in one connection (each `kizuki connect google` is one
  connection; several connections coexist).
- IMAP and ICS (their own lane), Composio (deferred by the owner).
- Any change to `kizuki.event/v1`, `kizuki.connector/v1`, the connections
  schema, or `runBackfill`/`runSync` semantics.

## Tests

`packages/connector-google/test/` (bun:test, temp dirs via `mkdtempSync`,
synthetic fixtures only; every event asserted through `validateEventInput`):

- `credentials.test.ts`: `signIn` and `connect` with placeholder credentials
  throw `misconfigured` whose message equals `appCredentialRefusal("google")`,
  with zero transport `listen`/`postForm` calls and zero api calls.
- `signin.test.ts`: scripted transport + `fakeIo`: the notify text contains
  the authorization URL whose query has `access_type=offline`,
  `prompt=consent`, the four scopes and `code_challenge_method=S256`;
  the flow writes exactly one blob whose `parseOAuthState(_, "google")`
  gives `account { id: sub, display: email }` and the exchanged tokens;
  returns `{ display: "ada@acme.example" }`; userinfo failure → nothing
  written; end-to-end through `enrollConnection(db, new ConnectionStateStore(tmp), connector, io)`
  → row with `state_ref_index: 0`, 0600 file, bytes parse; `store.replace`
  keeps the source key; `readFileSync(<db>)` contains none of the token
  strings.
- `connect.test.ts`: refuses without `state_ref` (`unauthenticated`), with
  `state_ref` but no `persist` (`misconfigured`), on a throwing resolver, on
  corrupt text (`misconfigured` "corrupt"), on `sub` mismatch
  (`unauthenticated`); succeeds with the matching account and never calls
  `listen`; the resolver of oauth-core §6 (over `store.read`, refusing other
  refs) round-trips a real enrollment into a working `connect`.
- `health.test.ts`: `disabled` → `unauthenticated` (before connect) → `ok`
  with `last_success_at` → `rate_limited` "retry after 30s" after
  `failNext(429, "rateLimitExceeded", 30)` → `unreachable` after
  `unreachableNext()` → `degraded` "Google returned HTTP 500" → `unauthenticated`
  after `revoke()`; every report is a `HealthReport`; `detail` never contains
  an email address or token.
- `gmail.test.ts`: the mapping table; plain wins over html; html-only
  stripped (vectors: nested tags, entities, `<br>`/`</p>` newlines, script
  dropped); attachment refs with `byte_size`; `parseAddressList` vectors
  (`Ada <ADA@Acme.example>` lowercases, quoted comma name, bare address,
  malformed dropped, 101 addresses cut to 100); `metadata` has no
  `label_ids`/`history_id`/`snippet` keys; truncation at `MAX_BODY_CHARS`
  code points with an astral character at the boundary; malformed payload →
  `text ""` + `capture_error`.
- `calendar.test.ts`: timed and all-day `occurred_at`; organizer/attendees/
  calendar subjects and roles; html description stripped; cancelled →
  `deleted: true` with the empty shape; recurring instance carries
  `recurring_event_id`; `metadata` has no `updated`/`etag`.
- `cursor.test.ts`: round trip; byte-stable encoding (sorted keys); rejects
  wrong schema, extra keys, non-string tokens, > `MAX_CALENDARS`.
- `backfill.test.ts`: `backfill(null)` records `history_id` from the profile
  before listing; a 1 200-message seed drains as 500/500/200 then the
  terminal empty batch with a byte-identical cursor; resume from every
  intermediate cursor emits the remaining events exactly once (union equals
  the seed); calendars follow Gmail, sorted by id, cancelled skipped,
  `sync_token` captured; two full drains produce identical events;
  `runToCompletion(db, connector, "kizuki.google", "<ulid>", "backfill")`
  against a real `openLedger(":memory:")` + `initStaging` stores every
  fixture event once and saves the terminal cursor; a 404 on one message
  skips it and continues.
- `sync.test.ts`: `sync(null)` equals `backfill(null)`; a cursor mid-backfill
  delegates; `addMessage` → new event; `deleteMessage` → tombstone with the
  empty shape; the history id advances; `expireHistory()` → cursor back to
  Gmail backfill and the following backfill re-walks (all duplicates in an
  `InMemoryLedger`); `upsertEvent` → re-emitted event with a different
  `computeContentHash` and the same `source_record_id`; `cancelEvent` →
  tombstone; `expireSyncToken` → that calendar re-walks; `addCalendar` is
  discovered and walked on the next call; `removeCalendar` drops it without
  tombstones; `MAX_EVENTS_PER_CALL` bound preserves page tokens; a
  caught-up sync returns an empty batch.
- `client.test.ts` (fake `fetchImpl`, no sockets): bearer header from
  `accessToken()`; `accept: application/json`; a 401 triggers `refresh()`
  once and retries, a second 401 → `GoogleApiError(401)`; 429 with
  `Retry-After: 30` → `retryAfterSeconds 30`; 403 `userRateLimitExceeded`;
  a thrown fetch → `unreachable`; > 8 MiB → `parse_error`; a non-object 2xx
  → `parse_error`; every request URL is built with `URLSearchParams`
  (assert the `q` of `purgeSource` is percent-encoded); error messages never
  include the request URL, headers or body.
- `revoke.test.ts`: posts the refresh token to the revocation endpoint;
  `forget()` afterwards; `invalid_token` treated as success; transport
  failure → `unreachable`; not connected → no-op.
- `purge.test.ts`: `email:grace@acme.example` → every seeded message and
  event involving grace under `unreachable_source_record_ids`,
  `source_record_ids` empty, ≤ 14 api calls; `conformance:subject` → empty
  plan and zero calls; not connected → `unauthenticated`.
- `redaction.test.ts`: `JSON.stringify(manifest())`, every `health().detail`,
  every thrown `message` across the failure cases above, every cursor and
  every event's `metadata` never contain `fixture-access-token`,
  `fixture-refresh-token` or the client secret string used in the scripted
  credentials.
- `conformance.test.ts` (package-local): `runConformance(connector, { tombstone: { prepare, mutate } })`
  with `prepare` = drain backfill and return the terminal cursor, `mutate` =
  `deleteMessage` + `cancelEvent` → `{ pass: true, failures: [] }`.
- `packages/connectors/test/conformance.test.ts`: extend "all registry
  connectors pass conformance" with `new GoogleConnector({}, scriptedDeps())`
  and the tombstone hooks above (the registry factory builds real deps and
  would need a network, so the scripted account stands in for it there),
  plus a separate case asserting
  `getConnector("kizuki.google", {}).manifest().connector_id === "kizuki.google"`
  and that `getConnector("kizuki.google", { state_ref: "not-a-ref" })` throws
  `KizukiError("misconfigured")`.
- `packages/core/test/ingest.test.ts`: the four `runToCompletion` cases from
  connector-telegram §7 (only if this lane lands it).

## Acceptance

```
bun install --frozen-lockfile                                                  # exit 0 (lockfile committed with the new workspace package)
cat packages/connector-google/package.json | grep -c '"dependencies"'          # 1, and the only entry is "@kizuki/core"
bun run typecheck                                                              # exit 0
bun test                                                                       # green; ≥ 45 tests under packages/connector-google/test
bun test packages/connectors/test/conformance.test.ts                          # green; the registry case includes kizuki.google
grep -rln 'fetch(' packages/connector-google/src | sort                        # exactly packages/connector-google/src/client.ts
grep -c 'packages/connector-google/src/client.ts:' scripts/network-allowlist.txt   # 1
bun run scripts/verify-network.ts                                              # "network source verification passed (3 allowlisted files)" (2 from oauth-core + client.ts)
grep -rn 'process.env\|KIZUKI_BUILD_CREDENTIALS' packages/connector-google/src   # no output (credentials come through core's one door)
bun -e 'import { GoogleConnector, scriptedDeps } from "./packages/connector-google/src/index.ts"; const c = new GoogleConnector({}, scriptedDeps()); const f = await c.fixture(); console.log(f.length, f.filter(e => e.kind === "email").length, f.filter(e => e.kind === "calendar_event").length, f.some(e => e.deleted))'
                                                                               # prints "<n> <e> <c> false" with e ≥ 10 and c ≥ 6, and no network (run it with the network down if you can)
bun -e 'import { GoogleConnector, scriptedDeps } from "./packages/connector-google/src/index.ts"; const c = new GoogleConnector({}, { ...scriptedDeps(), credentials: () => ({ group: "google", source: "placeholder", values: {} }) }); try { await c.signIn({ prompt: async () => "", notify: () => {}, openUrl: async () => {} }, { write: async () => {} }); } catch (e) { console.log(e.message); }'
                                                                               # prints exactly the appCredentialRefusal("google") text from §3
bash scripts/verify.sh                                                         # exit 0 (typecheck, tests, policy test, network scan, dependency grep, identifier denylist over tracked text and commit messages)
git ls-files packages/connector-google | grep -c README.md                     # 1
grep -c 'verified against' packages/connector-google/README.md                 # ≥ 1 (research packet carries a check date)
git status --porcelain                                                         # empty
```
