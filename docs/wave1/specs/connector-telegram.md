# Lane: connector-telegram — sign in with Telegram, and it just works

Reconciled against `main` @ `76930db` (2026-09-02). Every path, symbol and
flag below was grepped on that revision; anything not on main is marked NEW
with its intended location.

Package(s): NEW `packages/connector-telegram` (own workspace package, the
only one in the tree with a runtime dependency), one registry entry in
`packages/connectors/src/registry.ts`, one NEW export in
`packages/core/src/ingest/run.ts`, and two README edits. Read, in order:
`CONVENTIONS.md`; `docs/architecture.md` (the "Sign-in, not setup" paragraph
under Contracts, and invariants 6, 8, 10); `rfcs/0000-constraints.md`;
`AGENTS.md`, `packages/connectors/AGENTS.md`, `packages/core/AGENTS.md`;
`packages/core/src/contracts/connector.ts` (`Manifest`, `SignInIo`,
`SignInDisplay`, `ConnectionStateWriter`, `SecretResolver`, `HealthReport`);
`packages/core/src/ledger/connection-state.ts` (`ConnectionStateStore`,
`enrollConnection` — the host side of sign-in); `packages/core/src/ledger/
connections.ts`; `packages/core/src/ingest/run.ts`; `packages/core/src/util/
hash.ts` (which fields feed `content_hash`); `packages/connectors/src/
{registry,conformance,errors,util}.ts` and the three connectors under
`packages/connectors/src/`; `packages/core/test/connections.test.ts` (the
fixture connector shape for `signIn`); `scripts/verify.sh` and
`scripts/verify-network.ts` (the gate you must pass). Plan §3.1 and §3.2 in
`workspace/kizuki-plan/ARCHITECTURE.md` describe the intent; where they
disagree with main (they still say `signIn(io, secretsDir)`), main wins.

## Already on main (do not redo)

- `manifest.auth_modes` with `AUTH_MODES = ["none","sign_in","oauth","secret_ref"]`
  and the conformance rule that an interactive mode requires `signIn()` and
  vice versa (`packages/connectors/src/conformance.ts`).
- `SignInIo { prompt(question, { secret? }), notify(text), openUrl(url) }`.
- The opaque-state sign-in contract: `signIn(io, state: ConnectionStateWriter):
Promise<SignInDisplay>`. Core mints the `source_key` (a ULID), the state
  file name (`<control>/connections/<source_key>.state`, mode 0600, directory 0700) and the connection row; the connector gets a one-shot `write(bytes)`
  and returns only `{ display }`. `enrollConnection(db, store, connector, io)`
  and `ConnectionStateStore.replace(...)` (re-auth keeping the same source
  key) exist and are tested (`packages/core/test/connections.test.ts`).
- `connections` rows carry a fixed config envelope
  (`kizuki.connection-config/v1`, `state_ref_index: null | 0`) and
  `secret_refs = ["file:connections/<source_key>.state"]`; the CHECK
  constraints in `packages/core/src/ledger/db.ts` reject anything else.
- `checkpoints` keyed by `(connector_id, source_key)`; `runBackfill` /
  `runSync` / `runBatch` with `RunResult { stored, duplicates, errors,
proposals_created, withdrawn, retractions_filed, cursor }`.
- `bun run verify` (`scripts/verify.sh`): frozen install, typecheck, tests,
  `scripts/verify-network.ts` (AST scan of tracked files under `packages/`
  for `node:net`/`http`/… imports and `fetch`/`WebSocket`/`Bun.serve`/
  `Bun.connect` calls), a phone-home dependency grep over `package.json`
  files, and the identifier denylist over tracked text and commit messages.
- `content_hash` covers `connector_id, source_record_id, kind, occurred_at,
text, subjects, deleted, metadata` and excludes `observed_at`,
  `attachments`, `sensitivity_hint` (`packages/core/src/util/hash.ts`).

## Stale in the previous version of this spec (fixed below)

- `signIn(io, secretsDir)` and "session written to `<secretsDir>/telegram/
<source_key>.session`" — the connector no longer sees a path; it writes
  opaque bytes once through `ConnectionStateWriter` (§4).
- "`source_key` = the account's numeric user id" and "`config: { user_id }`"
  — `source_key` is core-minted and `config` is a fixed envelope; the user id
  lives inside the opaque state blob (§4).
- "`telegram` is already installed on this branch" — it is not; no
  `packages/connector-telegram` exists on main or any remote branch (§1).
- `scripts/network-allowlist.txt` and `scripts/check-no-network.sh` — neither
  exists; the gate is `scripts/verify-network.ts` (§1, §10).
- "the ingest runner loops until `cursor` is null" — a Telegram cursor is
  never null (it must survive into `sync`), so draining needs an
  empty-batch stop, added as NEW `runToCompletion` (§7).
- Secret chats: not reachable through the MTProto client API from a
  non-native client; removed from the mapping (§6).

## Objective

The owner types `kizuki connect telegram` (CLI wiring is another lane; this
lane ships everything under it), enters their phone number, the code
Telegram sends, and their two-step password if they have one, and is done.
No developer console, no keys pasted, no export files. The project ships its
own app credentials compiled in at build time; the owner never sees them.
The account's own dialogs (private chats, groups, channels) backfill into
the ledger as `message` events with honest sensitivity hints, resume across
FloodWait and interruption, and re-emit edits. Everything except the one
file that talks to Telegram is unit-tested against a scripted in-memory
account, and the conformance suite runs on it with no network.

## 1. Dependency: `telegram` (GramJS) — the single runtime dependency

Verified 2026-09-02 with `npm view telegram`: latest is `2.26.22`
(published 2026-07-14; `dist-tags.latest = 2.26.22`, `next = 2.24.9` is
older — ignore it). Under Bun 1.3.14, `import { TelegramClient, Api, Logger }
from "telegram"`, `import { StringSession } from "telegram/sessions/index.js"`,
`import { LogLevel } from "telegram/extensions/Logger.js"` and
`import { FloodWaitError } from "telegram/errors/index.js"` resolve, and a
`TelegramClient` constructs. CI pins Bun `1.3.10` (`.github/workflows/
ci.yml`); repeat the probe under that version before building on it:

```
bun -e 'import { TelegramClient, Logger } from "telegram"; import { StringSession } from "telegram/sessions/index.js"; import { LogLevel } from "telegram/extensions/Logger.js"; const c = new TelegramClient(new StringSession(""), 1, "x", { connectionRetries: 0, baseLogger: new Logger(LogLevel.NONE) }); console.log(typeof c.start, typeof c.getMe, typeof c.iterDialogs, typeof c.iterMessages)'
# expected: function function function function   (and NO gramJS banner line)
```

Facts an implementer must respect:

- `packages/connector-telegram/package.json` pins `"telegram": "2.26.22"`
  (exact, no caret) and `"@kizuki/core": "workspace:*"`. Nothing else.
  `bun install` at the root updates `bun.lock` (46 transitive packages);
  commit the lockfile — CI installs with `--frozen-lockfile`. One transitive
  package (`es5-ext`) has a postinstall that Bun blocks by default; leave it
  blocked (do not add `trustedDependencies`); the library works without it.
- The default GramJS logger prints `[Running gramJS version …]` to the
  console at client construction. Every client is built with
  `baseLogger: new Logger(LogLevel.NONE)`. (The banner reports `2.26.21`
  for the `2.26.22` package; cosmetic upstream mismatch, do not "fix" it.)
- `scripts/verify-network.ts` flags imports of `net`/`http`/`tls`/`dns`/…
  and calls to `fetch`/`WebSocket`/`Bun.serve`/`Bun.connect` in tracked
  source. Importing `telegram` is not flagged (the sockets live inside
  `node_modules`). This lane adds none of the flagged names anywhere; the
  only file importing `telegram` is `src/client.ts`, and it does so with a
  dynamic `await import("telegram")` inside `createRealApi()` so the
  registry, `fixture()` and the conformance suite never load MTProto code
  (connectors AGENTS.md: network absent from fixture/conformance paths).
- Root `README.md` currently pledges "Today there are zero runtime
  dependencies and zero network calls anywhere in the tree". That sentence
  becomes false with this lane; §9 replaces it.
- `@kizuki/core` stays dependency-free. `@kizuki/connectors` gains only the
  workspace link `"@kizuki/connector-telegram": "workspace:*"`.

## 2. Package layout

```
packages/connector-telegram/
  package.json          # name @kizuki/connector-telegram, type module, module src/index.ts,
                        # exports { ".": "./src/index.ts" }, deps: @kizuki/core workspace:*, telegram 2.26.22
  README.md             # what it does, the build-time credential step, the manual smoke, limits (§9)
  src/
    index.ts            # public exports (§8)
    app-credentials.ts  # compiled-in app id/hash + placeholder refusal (§3)
    state.ts            # opaque state blob encode/parse (§4)
    api.ts              # TelegramApi interface + normalized record types + TelegramConnectorError (§5)
    client.ts           # the ONLY file that imports "telegram"; createRealApi() (§5)
    cursor.ts           # cursor schema, parse/encode, bounds (§6.5)
    map.ts              # TelegramMessage → CaptureEventInput, subjects, hints, attachments (§6.4)
    connector.ts        # TelegramConnector: manifest/signIn/connect/health/backfill/sync/revoke/purgeSource/fixture (§6)
    scripted.ts         # ScriptedTelegramApi + FIXTURE_ACCOUNT: powers fixture() and every test (§6.9)
  test/
    app-credentials.test.ts  sign-in.test.ts  connect.test.ts  health.test.ts
    backfill.test.ts  sync.test.ts  map.test.ts  cursor.test.ts  purge.test.ts
    redaction.test.ts  client.smoke.test.ts (skipped unless KIZUKI_TELEGRAM_SMOKE=1)
```

Keep every file under ~400 lines. `tsconfig.json` already includes
`packages/*/src/**/*.ts` and `packages/*/test/**/*.ts`; `bun test` at the
root discovers `packages/connector-telegram/test` with no config change.

## 3. App credentials (`src/app-credentials.ts`)

```ts
export interface AppCredentials {
  api_id: number; // positive integer
  api_hash: string; // non-empty
}

/** Build-time inlined by `bun build --env 'KIZUKI_TELEGRAM_*'`; placeholders otherwise. */
const COMPILED_API_ID: string = process.env.KIZUKI_TELEGRAM_API_ID ?? "0";
const COMPILED_API_HASH: string = process.env.KIZUKI_TELEGRAM_API_HASH ?? "";

export const PLACEHOLDER_CREDENTIALS_MESSAGE =
  "kizuki.telegram: app credentials are not compiled in; build with KIZUKI_TELEGRAM_API_ID and KIZUKI_TELEGRAM_API_HASH set (see packages/connector-telegram/README.md)";

/** `null` when either value is still a placeholder; `source` exists for tests only. */
export function appCredentials(
  source: { api_id: string; api_hash: string } = {
    api_id: COMPILED_API_ID,
    api_hash: COMPILED_API_HASH,
  },
): AppCredentials | null;
```

Rules:

- The two `process.env.KIZUKI_TELEGRAM_*` reads are literal member
  expressions at module top level. That is what makes both
  `bun build --env 'KIZUKI_TELEGRAM_*'` and
  `bun build --define 'process.env.KIZUKI_TELEGRAM_API_ID="…"'` inline them
  (verified on Bun 1.3.14 for `--env`, `--define` and `--compile --env`).
  Reading them through an `env[...]` indirection defeats inlining — tested
  and it does not substitute. At development time (`bun packages/cli/src/
main.ts …`) the same two lines read the live environment, so a developer
  exports the variables in their shell.
- `appCredentials()` returns `null` for `"0"`/`""`, a non-integer, a
  non-positive id, or an empty hash. `signIn` and `connect` call it and
  throw `TelegramConnectorError("placeholder_credentials",
PLACEHOLDER_CREDENTIALS_MESSAGE)` when it is `null`. No fallback, no fake
  success, no prompt asking the owner for an api id (connectors AGENTS.md:
  never ask an end user to paste project credentials).
- The registered values are never committed. The package README documents
  the release step verbatim:
  `KIZUKI_TELEGRAM_API_ID=… KIZUKI_TELEGRAM_API_HASH=… bun build packages/cli/src/main.ts --compile --env 'KIZUKI_TELEGRAM_*' --outfile kizuki`
  (a release lane owns the actual binary; this lane proves the mechanism
  on `app-credentials.ts` alone, see Acceptance).

## 4. Opaque state and the host contract (`src/state.ts`)

The connector persists exactly one blob through the writer core lends it:

```ts
export const TELEGRAM_STATE_SCHEMA = "kizuki.telegram-state/v1" as const;
export interface TelegramState {
  schema: typeof TELEGRAM_STATE_SCHEMA;
  user_id: string; // Telegram user id as a decimal string (BigInteger.toString())
  session: string; // GramJS StringSession.save() output — the credential
}
export function encodeState(state: TelegramState): Uint8Array; // UTF-8 JSON
export function parseState(bytes: Uint8Array | string): TelegramState; // throws TelegramConnectorError("corrupt_state") on anything else
```

`session` is the credential. It must never appear in `manifest()`, any
`HealthReport.detail`, any thrown message, the cursor, event metadata, or a
log line (`redaction.test.ts` asserts this against a recognizable fake
token). Core stores the bytes at `<vault>/.kizuki/connections/<source_key>
.state` (0600) and records only `file:connections/<source_key>.state` in
SQLite — never the bytes (`packages/core/test/connections.test.ts` "raw
SQLite never contains state bytes" already proves the host side).

How the connector gets the session back later — the host contract every
caller (CLI lanes) must satisfy, and what `TelegramConnectorConfig` is for:

```ts
export interface TelegramConnectorConfig {
  /** The connection's single secret_ref, `file:connections/<source_key>.state`, once signed in. */
  state_ref?: string;
}
```

- Before sign-in the host builds the connector with `{}`; after sign-in it
  builds it with `{ state_ref: connection.secret_refs[0] }` from the row
  returned by `enrollConnection` / `getConnection`.
- `connect(resolve)` calls `resolve(state_ref)` and expects the
  UTF-8 text of the state file. The host's `SecretResolver` therefore maps
  a `file:connections/…` ref to `new TextDecoder().decode(store.read(
connection))` using `ConnectionStateStore.read` — it must not read the
  path itself; `store.read` re-validates the ref against the row. (`file:`
  refs pointing anywhere else are the host's problem to refuse; the
  connector only ever asks for the ref it was given.)
- The connector never receives a filesystem path, never chooses a name,
  never returns durable config. Re-authentication is
  `ConnectionStateStore.replace(db, connection, connector, io)`, which calls
  the same `signIn` and swaps the file atomically.
- Alignment with the CLI lanes (`packages/cli/src/connections.ts`, NEW in
  cli-verbs, extended by cli-wave2 §2). The host-authored envelope
  (`kizuki.host-connection/v1` / `kizuki.cli.connection-state/v1` with a
  `connector_id` key) applies to `none`/`secret_ref` connectors only; this
  blob carries no `connector_id` key and a different `schema`, so
  cli-wave2's `connectorFor` classifies it as connector-authored opaque
  state and follows its stated convention — `getConnector(id, { state_ref:
connection.secret_refs[0] })`, then `connect(stateResolver)` where the
  resolver answers exactly that ref with the UTF-8 decoded
  `store.read(connection)` bytes and throws for any other ref. The
  `state_ref` field name below is that convention; do not rename it.
  cli-verbs' `connect` prints `sign-in for <id> is not wired yet` until
  cli-wave2 §4 lands `enrollConnection` / `store.replace` on the terminal
  `SignInIo`; nothing in this lane waits for either.

## 5. The `TelegramApi` seam (`src/api.ts`) and the real client (`src/client.ts`)

All network I/O sits behind one small interface over plain records so the
connector logic is testable without GramJS types anywhere else:

```ts
export type PeerType = "user" | "group" | "channel";

export interface TelegramUser {
  id: string; // decimal string
  username?: string; // without "@"
  first_name?: string;
  last_name?: string;
  bot: boolean;
}
export interface TelegramDialog {
  peer_id: string; // GramJS marked peer id via utils.getPeerId(peer, true): users "9", basic groups "-42", channels/supergroups "-100777"
  peer_type: PeerType; // Dialog.isUser / isGroup (incl. megagroups) / isChannel (broadcast)
  title: string; // utils.getDisplayName(entity)
  public: boolean; // channel with a public username (Api.Channel.username or usernames[]); false otherwise
  top_message_id: number; // Dialog.message?.id ?? 0
}
export interface TelegramAttachment {
  attachment_id: string; // Document.id / Photo.id as decimal string
  media_type: string; // Document.mimeType; "image/jpeg" for photos
  filename?: string; // DocumentAttributeFilename.fileName
  byte_size?: number; // Document.size when it fits Number.isSafeInteger
}
export interface TelegramMessage {
  peer_id: string;
  id: number;
  date: number; // unix seconds
  text: string; // CustomMessage.message (caption for media); "" for media-only
  out: boolean; // sent by the signed-in account
  from?: { id: string; display: string; kind: "user" | "chat" }; // fromId resolved; absent for anonymous channel posts
  post_author?: string; // CustomMessage.postAuthor (channel signature)
  reply_to?: number; // replyTo.replyToMsgId
  forward_from?: { id?: string; name?: string; date?: number }; // fwdFrom fromId / fromName / date
  edit_date?: number; // unix seconds
  grouped_id?: string; // album id
  service: boolean; // Api.MessageService (joins, pins, …): skipped by the mapper
  attachment?: TelegramAttachment;
  media_kind?: string; // className of unsupported media (geo, poll, contact, webpage, …)
}
export interface SignInFlow {
  phone: string;
  code(): Promise<string>;
  password(hint?: string): Promise<string>;
  /** Return true to abort; called on wrong code / wrong password with the RPC error name only. */
  onError(errorName: string): Promise<boolean>;
}
export interface MessagesQuery {
  min_id: number; // exclusive lower bound (0 = from the start)
  max_id?: number; // exclusive upper bound; undefined = no bound
  limit: number; // ≤ 500, always set
}
export interface TelegramApi {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isAuthorized(): Promise<boolean>;
  start(flow: SignInFlow): Promise<void>;
  me(): Promise<TelegramUser>;
  saveSession(): string;
  dialogs(limit: number): AsyncIterable<TelegramDialog>;
  /** Oldest → newest, ids strictly ascending, never more than `limit` items. */
  messages(
    peer_id: string,
    query: MessagesQuery,
  ): AsyncIterable<TelegramMessage>;
  logOut(): Promise<void>;
}
export type TelegramApiFactory = (
  session: string,
  credentials: AppCredentials,
) => TelegramApi;

export type TelegramErrorCode =
  | "placeholder_credentials"
  | "missing_session"
  | "corrupt_state"
  | "invalid_phone"
  | "sign_in_aborted"
  | "identity_mismatch"
  | "unauthenticated"
  | "flood_wait"
  | "unreachable"
  | "parse_error"
  | "limit_exceeded";
export class TelegramConnectorError extends Error {
  readonly code: TelegramErrorCode;
  /** Seconds Telegram asked us to wait; set only for flood_wait. */
  readonly retry_after?: number;
  constructor(
    code: TelegramErrorCode,
    message: string,
    options?: { retry_after?: number; cause?: unknown },
  );
}
```

`TelegramConnectorError` lives here (not `KizukiError` from
`@kizuki/connectors`): `@kizuki/connectors` will depend on this package for
the registry entry, so importing the other way would be a cycle. Messages
never embed captured text, phone numbers, codes, passwords or the session.

`src/client.ts` — `createRealApi: TelegramApiFactory` — is the only module
allowed to import `telegram`, via `await import("telegram")`,
`await import("telegram/sessions/index.js")`, `await import("telegram/
extensions/Logger.js")` inside the factory (the factory returns an object
whose methods await a lazily created client). It:

- builds `new TelegramClient(new StringSession(session), api_id, api_hash,
{ connectionRetries: 3, requestRetries: 3, timeout: 10, autoReconnect:
false, floodSleepThreshold: 0, useWSS: false, deviceModel: "Kizuki",
appVersion: <manifest version>, langCode: "en", systemLangCode: "en",
baseLogger: new Logger(LogLevel.NONE) })`. `floodSleepThreshold: 0` so
  GramJS never sleeps silently; the connector surfaces every FloodWait.
- `start(flow)` → `client.start({ phoneNumber: flow.phone, phoneCode:
flow.code, password: flow.password, onError: (err) => flow.onError(
rpcName(err)) })`; `me()` → `client.getMe()` mapped (`id.toString()`,
  `username`, `firstName`, `lastName`, `bot === true`); `saveSession()` →
  `(client.session as StringSession).save()` (the factory keeps the
  `StringSession` instance it constructed, so no cast); `isAuthorized()` →
  `client.checkAuthorization()`; `logOut()` → `client.invoke(new
Api.auth.LogOut())`; `dialogs(limit)` → `client.iterDialogs({ limit })`
  mapped as in §5's comments; `messages(peer_id, q)` →
  `client.iterMessages(peer_id, { reverse: true, offsetId: q.min_id, minId:
q.min_id, maxId: q.max_id ?? 0, limit: q.limit, waitTime: 1 })` (GramJS:
  in reverse mode `minId` is the exclusive start and results ascend).
- normalizes errors: `FloodWaitError` (`errors/index.js`) →
  `TelegramConnectorError("flood_wait", "telegram asked us to wait Ns",
{ retry_after: seconds })`; RPC errors whose `errorMessage` is one of
  `AUTH_KEY_UNREGISTERED | AUTH_KEY_INVALID | SESSION_REVOKED |
SESSION_EXPIRED | USER_DEACTIVATED | USER_DEACTIVATED_BAN` →
  `unauthenticated`; `PHONE_NUMBER_INVALID` → `invalid_phone`; socket /
  timeout / DNS failures (anything that is not an `RPCError`) →
  `unreachable`; everything else re-thrown as `parse_error` with the RPC
  name only.
- passes the identifier denylist and `verify-network.ts` by construction:
  no `fetch`, no `net`, no `WebSocket` names in this file.

## 6. Connector behavior (`src/connector.ts`)

```ts
export const TELEGRAM_CONNECTOR_ID = "kizuki.telegram" as const;
export interface TelegramDeps {
  api: TelegramApiFactory; // createRealApi by default
  credentials: () => AppCredentials | null; // appCredentials by default
  now: () => number; // Date.now
  sleep: (ms: number) => Promise<void>; // Bun.sleep
}
export class TelegramConnector implements Connector {
  constructor(config: TelegramConnectorConfig, deps?: Partial<TelegramDeps>);
  // manifest / health / connect / backfill / sync / revoke / signIn / purgeSource / fixture
}
export function createTelegramConnector(
  config: TelegramConnectorConfig,
): TelegramConnector; // real deps; what the registry calls
```

`config` is validated with `isPlainObject` from `@kizuki/core`; a
`state_ref` that is present but not a string matching
`^file:connections/[0-9A-HJKMNPQRSTVWXYZ]{26}\.state$` throws
`TelegramConnectorError("corrupt_state", …)` at construction (fail closed;
the regex mirrors `stateRefFor` in `connection-state.ts`).

### 6.1 `manifest()`

```ts
{
  schema: "kizuki.connector/v1", connector_id: "kizuki.telegram", version: "0.1.0",
  kinds: ["message"],
  capabilities: { backfill: true, sync: true, tombstones: false, purge: true, fixture: true },
  required_secrets: [],           // the session is created by sign-in, not required up front
  emits_sensitivity_hint: true,
  auth_modes: ["sign_in"],
}
```

`tombstones: false` is honest: deletions are only visible through the
update stream, which this lane does not consume.

### 6.2 `signIn(io, state)`

1. `deps.credentials()` → `null` ⇒ throw `placeholder_credentials` with
   `PLACEHOLDER_CREDENTIALS_MESSAGE` before any prompt or network.
2. `phone = (await io.prompt("Telegram phone number (international format, e.g. +15551234567): ")).trim()`;
   must match `^\+\d{6,15}$` else throw `invalid_phone` ("phone number
   must be in international format") — the number itself is not echoed.
3. `api = deps.api("", creds)`; `await api.connect()`; `await api.start({
phone, code: () => io.prompt("Code Telegram sent you: "), password:
(hint) => io.prompt(hint ? \`Two-step verification password (hint: ${hint}): \` : "Two-step verification password: ", { secret: true }),
   onError })`where`onError`counts attempts, calls`io.notify("that code/password was not accepted, try again")`and
returns`true`(abort) on the third failure ⇒ throw`sign_in_aborted`.
   The hint is Telegram-provided text shown once in the terminal and never
   persisted.
4. `flood_wait` from `start` with `retry_after ≤ 60` ⇒
   `io.notify(\`Telegram asked us to wait ${n}s\`)`, `await deps.sleep(n * 1000)`, retry `start`once; a second`flood_wait`, or any with
`retry_after > 60`, is re-thrown (the seconds are in the message).
5. `me = await api.me()`; `session = api.saveSession()`; `await
state.write(encodeState({ schema, user_id: me.id, session }))` — exactly
   one write, only after `me()` succeeded; `await api.disconnect()`.
6. Return `{ display }` where `display` is `@username` when present, else
   `first_name last_name` trimmed, else `user <id>`.

Nothing durable is written by the connector; on any throw the host discards
the pending state (already tested in core).

### 6.3 `connect(resolve)`, `health()`, `revoke()`

- `connect`: no `state_ref` ⇒ throw `missing_session` ("kizuki.telegram:
  not signed in; run: kizuki connect telegram"). Otherwise `text = await
resolve(state_ref)` (a resolver throw is wrapped as `missing_session`),
  `state = parseState(text)`, `creds` check as in §6.2 step 1, `api =
deps.api(state.session, creds)`, `await api.connect()`, `if (!await
api.isAuthorized())` ⇒ disconnect and throw `unauthenticated`; `me =
await api.me()`; `me.id !== state.user_id` ⇒ disconnect and throw
  `identity_mismatch` ("signed-in account does not match the stored
  connection"). Never triggers a login flow. Stores `api`, `self = me`.
- `health()` never throws. `disabled` when `state_ref` is absent;
  `unauthenticated` with detail `"connect() has not been called"` when
  `connect` has not succeeded; `rate_limited` with detail `"retry after
<n>s"` while `deps.now() < floodUntil` (set by any `flood_wait`);
  otherwise `await api.isAuthorized()` ⇒ `ok` (with `last_success_at` = the
  last successful `me()`/batch time) or `unauthenticated`; `unreachable`
  when the probe throws `unreachable`; `degraded` with detail
  `"dialog limit reached (5000); newest dialogs only"` when the last
  dialog listing hit `MAX_DIALOGS`. Every report is a `HealthReport`
  instance (constructor validation) and `detail` never contains captured
  text or the session.
- `revoke()`: if connected, `await api.logOut()` (invalidates the session at
  Telegram), then `await api.disconnect()`; swallow `unauthenticated`
  (already revoked) but re-throw `unreachable` so the host does not believe
  access ended. Removing the state file and marking the row is the host's
  job (`disconnect(db, …)` in core marks the row; a `kizuki disconnect`
  verb is not on main — see open questions). After `revoke`, `health()`
  reports `unauthenticated`.

### 6.4 Event mapping (`src/map.ts`)

`mapMessage(message, dialog, self, observed_at): CaptureEventInput | null`
(`null` for `service: true` messages, which are skipped and counted in
`RunResult`-visible terms only through fewer events).

| field              | value                                                                                                                                                                                                                                                                                                             |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `source_record_id` | `` `${peer_id}:${id}` ``                                                                                                                                                                                                                                                                                          |
| `kind`             | `"message"`                                                                                                                                                                                                                                                                                                       |
| `occurred_at`      | `new Date(date * 1000).toISOString()`                                                                                                                                                                                                                                                                             |
| `observed_at`      | one timestamp per batch (`new Date(deps.now()).toISOString()`)                                                                                                                                                                                                                                                    |
| `text`             | `message.text` (caption included; `""` for media-only)                                                                                                                                                                                                                                                            |
| `subjects`         | table below; every subject carries `display_name`                                                                                                                                                                                                                                                                 |
| `sensitivity_hint` | `user` → `private`; `group` → `personal`; `channel` → `public` when `dialog.public`, else `personal`                                                                                                                                                                                                              |
| `deleted`          | `false` always (§6.1)                                                                                                                                                                                                                                                                                             |
| `attachments`      | `[attachment]` when present, else `[]` (refs only — no downloads)                                                                                                                                                                                                                                                 |
| `metadata`         | `{ peer_id, peer_type, message_id: id, out, reply_to: number\|null, forward_from: {…}\|null, edit_date: number\|null, grouped_id: string\|null, media_kind: string\|null, post_author: string\|null }` — **no `views`/`forwards`**: metadata is hashed, and volatile counters would fork history on every re-scan |

Subjects (`SubjectRef { subject_id, role, display_name }`; ids are
`telegram:user:<id>` and `telegram:chat:<marked peer id>` so the staging
`handleOf` yields `<id>` / `<marked id>`, which never collide because chat
marks are negative):

| peer_type | `from`                                                                                       | `to`                                                 | `about`                                         |
| --------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ----------------------------------------------- |
| user      | sender: self when `out`, else the peer user                                                  | the other party (self on incoming, peer on outgoing) | —                                               |
| group     | sender (`message.from`); absent ⇒ the chat                                                   | —                                                    | `telegram:chat:<peer_id>` with the dialog title |
| channel   | `message.from` when present, else the channel (display = `post_author` when set, else title) | —                                                    | `telegram:chat:<peer_id>` with the title        |

Display names are captured text: they are copied verbatim into
`display_name` and nowhere else (never into error messages or health
detail).

### 6.5 Cursor (`src/cursor.ts`)

```ts
export const TELEGRAM_CURSOR_SCHEMA = "kizuki.telegram-cursor/v1" as const;
export interface DialogCursor {
  peer_type: PeerType;
  last_id: number;
  exhausted: boolean;
}
export interface TelegramCursor {
  schema: typeof TELEGRAM_CURSOR_SCHEMA;
  dialogs: Record<string, DialogCursor>; // key = peer_id; iteration order = keys sorted ascending as strings
  phase: "backfill" | "synced";
  edit_watermark: number; // unix seconds; edits with edit_date > this are re-emitted
  pass: { started_at: number; next_peer: string | null } | null; // an in-flight sync pass
}
export function parseCursor(cursor: string): TelegramCursor; // TelegramConnectorError("parse_error") on any deviation, incl. > MAX_DIALOGS entries or non-integer ids
export function encodeCursor(cursor: TelegramCursor): string; // JSON with dialogs keys sorted
export const BATCH_LIMIT = 500; // events per SyncBatch
export const MAX_DIALOGS = 5000; // dialogs listed per run
export const EDIT_WINDOW = 200; // most recent messages re-read per dialog for edits
```

The cursor holds ids and flags only — no titles, no text, no session.

### 6.6 `backfill(cursor)`

Requires a successful `connect` (else `missing_session`). `cursor === null`:
list `api.dialogs(MAX_DIALOGS)`, seed `dialogs[peer_id] = { peer_type,
last_id: 0, exhausted: top_message_id === 0 }`, `phase: "backfill"`.
Otherwise `parseCursor`. Then walk dialogs in sorted key order, skipping
`exhausted`; for each, `api.messages(peer_id, { min_id: last_id, limit:
BATCH_LIMIT - collected })`, map, push, set `last_id` to the highest id
seen; a dialog that yields fewer than requested is `exhausted`. Stop when
`collected === BATCH_LIMIT`. When every dialog is exhausted set `phase:
"synced"`, `edit_watermark: floor(deps.now()/1000)`. Return `{ events,
cursor: encodeCursor(c) }` — **never `null`**: the cursor must survive into
`sync`. On `flood_wait` mid-walk: set `floodUntil`, return what was collected
with the cursor reflecting exactly those events (ids advanced only for
messages included in the batch), so a durable checkpoint never runs ahead of
the ledger. A `phase: "synced"` cursor makes `backfill` a no-op
`{ events: [], cursor }`. Dialog listing that reaches `MAX_DIALOGS` sets the
`degraded` health detail; the connector still processes what it listed.

### 6.7 `sync(cursor)`

`cursor === null` ⇒ behave as `backfill(null)` (same as the markdown-folder
precedent). Otherwise: if `pass === null`, list dialogs again, add unknown
peers with `last_id: 0` (they are walked from the beginning, bounded by
`BATCH_LIMIT`), and start `pass = { started_at: now, next_peer: first key }`.
For each dialog from `next_peer` in sorted order: (a) new messages
`{ min_id: last_id, limit }`; (b) edits: re-read `{ min_id: max(0, last_id -
EDIT_WINDOW), max_id: last_id + 1, limit: EDIT_WINDOW }` and emit only
messages with `edit_date > edit_watermark` — same `source_record_id`, new
`text`/`metadata.edit_date` ⇒ new `content_hash` ⇒ the ledger stores the
edit as a new row. Advance `next_peer` after each dialog. When the batch
fills, return with `pass` still set; when the pass completes, set
`edit_watermark = pass.started_at`, `pass = null`. A completed sync with no
new or edited messages returns `{ events: [], cursor }` — the drained
signal §7 relies on. FloodWait behaves as in §6.6.

### 6.8 `purgeSource(subject_id)`

`purge: true` means a precise plan of what this connector knows, not remote
deletion (the connector never performs outbound actions). During
`backfill`/`sync` the connector records, per `subject_id` it emitted, the
`source_record_id`s of that batch in memory (`Map<string, Set<string>>`,
capped at 10 000 ids per subject; beyond the cap the newest are kept and
the plan is still honest because ledger purge is subject-keyed on its own —
`purgeEvents(db, vault, { subject_handle }, reason)` in core). The plan is
`{ subject_id, source_record_ids: [], unreachable_source_record_ids:
[...sorted ids] }`: Telegram's copy stays, Kizuki's copy is what purge
removes. Unknown subject ⇒ both arrays empty. Never touches the network.

### 6.9 `fixture()` and the scripted account (`src/scripted.ts`)

```ts
export interface ScriptedAccount {
  me: TelegramUser;
  authorized: boolean;
  dialogs: TelegramDialog[];
  messages: Record<string, TelegramMessage[]>; // per peer_id, ascending ids
  flood?: { after_calls: number; seconds: number }; // the Nth messages() call throws flood_wait once
}
export class ScriptedTelegramApi implements TelegramApi {
  constructor(account: ScriptedAccount);
  readonly calls: { method: keyof TelegramApi; args: unknown[] }[];
  edit(peer_id: string, id: number, text: string, edit_date: number): void;
  append(peer_id: string, message: TelegramMessage): void;
  revoke(): void; // subsequent isAuthorized() false, me() throws unauthenticated
  disconnectNetwork(): void; // subsequent calls throw unreachable
}
export function scriptedDeps(
  account?: ScriptedAccount,
  session = FIXTURE_SESSION,
): Partial<TelegramDeps>;
export const FIXTURE_SESSION = "fixture-session-token-not-a-real-credential";
export const FIXTURE_ACCOUNT: ScriptedAccount; // self = ada (id "1001"); private chat with grace ("1002");
// group "-42" (acme planning: ada, grace, linus); public channel "-100777" (acme news)
// ≥ 12 messages total, ≥ 3 per dialog, one media-only with a document attachment,
// one reply, one forward, one edited, one service message, fixed dates in 2026
```

`fixture()` returns `FIXTURE_ACCOUNT` mapped with the fixed
`observed_at = "2026-01-01T00:00:00.000Z"` and no API instance — it needs no
credentials and no network, so the conformance suite's fixture round-trip
runs cold. Two consecutive `backfill(null)` calls against a scripted API
yield identical events (`observed_at` is outside the hash), which is what
the suite's double-backfill check needs.

## 7. Core: drain a bounded-batch connector (NEW in `packages/core/src/ingest/run.ts`)

`runBackfill`/`runSync` stay single-batch (their tests, e.g. "backfill
resumes from the stored composite checkpoint", depend on it). Add:

```ts
export interface RunToCompletionOptions {
  /** Upper bound on batches per call; exceeding it is an error, not a silent stop. Default 10_000. */
  maxBatches?: number;
  /** Passed through to runBackfill/runSync. `RunHooks` is NEW in cli-wave2 §1.3;
   *  include this field only if that seam exists on your branch, else omit it. */
  hooks?: RunHooks;
}
/**
 * Repeats runBackfill/runSync until the connector returns an empty batch,
 * a null cursor, or an error. Each batch and its checkpoint are committed
 * before the next call, so an interruption resumes from the last durable
 * checkpoint. A non-empty batch that leaves the cursor unchanged is a
 * connector bug and stops with the error "run made no progress".
 */
export async function runToCompletion(
  db: Database,
  connector: Connector,
  connector_id: string,
  source_key: string,
  mode: "backfill" | "sync",
  opts?: RunToCompletionOptions,
): Promise<RunResult>; // sums stored/duplicates/proposals_created/withdrawn/retractions_filed, concatenates errors, cursor = last
```

Empty batch = `stored + duplicates + errors.length === 0` for that batch.
Export from `packages/core/src/index.ts` next to `runBackfill`. Tests in
`packages/core/test/ingest.test.ts` (same `FixtureConnector` style): drains
three scripted batches and saves the last cursor; stops on the first batch
with an error and keeps the previous cursor; unchanged cursor with a
non-empty batch ⇒ error; `maxBatches` exceeded ⇒ error naming the bound.
The CLI `backfill`/`sync` verbs (other lane) should call this; it is the
only core change in this lane.

## 8. Registry and exports

- `packages/connectors/package.json`: add `"@kizuki/connector-telegram": "workspace:*"`.
- `packages/connectors/src/registry.ts`: import `TELEGRAM_CONNECTOR_ID,
createTelegramConnector` and the config type from
  `@kizuki/connector-telegram`; add the `REGISTRY` entry and a
  `getConnector(id: typeof TELEGRAM_CONNECTOR_ID, config: TelegramConnectorConfig): Connector`
  overload and `case`. Last step, after conformance passes (connectors
  AGENTS.md).
- `packages/connectors/src/index.ts`: re-export `TELEGRAM_CONNECTOR_ID`,
  `TelegramConnector`, `createTelegramConnector`, `TelegramConnectorError`,
  `ScriptedTelegramApi`, `scriptedDeps`, `FIXTURE_ACCOUNT`, `FIXTURE_SESSION`
  and the types `TelegramConnectorConfig`, `TelegramDeps`, `TelegramApi`,
  `TelegramApiFactory`, `TelegramDialog`, `TelegramMessage`, `TelegramUser`,
  `TelegramState`, `TelegramCursor`.
- `packages/connector-telegram/src/index.ts` exports everything above plus
  `appCredentials`, `PLACEHOLDER_CREDENTIALS_MESSAGE`, `encodeState`,
  `parseState`, `TELEGRAM_STATE_SCHEMA`, `parseCursor`, `encodeCursor`,
  `TELEGRAM_CURSOR_SCHEMA`, `BATCH_LIMIT`, `MAX_DIALOGS`, `EDIT_WINDOW`,
  `mapMessage`, `createRealApi`.

## 9. Documentation

- Root `README.md`, Pledges → "Zero phone-home": replace the sentence
  "Today there are zero runtime dependencies and zero network calls anywhere
  in the tree; CI greps both the dependency manifests and the source for
  network surface." with: "Core has zero runtime dependencies. The only
  package that opens a socket is the Telegram connector, through the
  `telegram` (GramJS) library, and only after you sign in; CI scans every
  package manifest and every source file for any other network surface."
- `packages/connector-telegram/README.md`: what it captures (your own
  dialogs: private chats, groups, channels — not a bot), the sign-in steps
  as the owner sees them, the build-time credential step from §3 (with the
  exact placeholder refusal message), where state lives
  (`<vault>/.kizuki/connections/`, 0600, never in the database), limits
  stated plainly (no deletion detection; edits re-checked within the last
  200 messages per dialog; service messages skipped; media as references
  only, no downloads; up to 5000 dialogs; FloodWait pauses honored, never
  bypassed; secret chats not reachable), purge semantics (§6.8), the manual
  smoke (`KIZUKI_TELEGRAM_SMOKE=1 KIZUKI_TELEGRAM_API_ID=… KIZUKI_TELEGRAM_API_HASH=… bun test packages/connector-telegram/test/client.smoke.test.ts`,
  which signs in interactively and lists one dialog; skipped by default
  and never run in CI), and the provider-facts check date (2026-09-02:
  user sign-in via phone code + optional two-step password through the
  MTProto client API, app id/hash registered once per project).
- Run the `humanizer` pass on both README edits; no identifier from the
  denylist, no real handles, phone numbers or account names anywhere.

## Non-goals

- CLI verbs (`connect telegram`, `disconnect`, `backfill`, `sync`) and the
  terminal `SignInIo`; the CLI lanes wire `enrollConnection`,
  `ConnectionStateStore.read`, the resolver from §4 and `runToCompletion`.
- Deletion tombstones (update-stream consumption), media downloads,
  outbound actions of any kind, bot accounts, QR-code login, secret chats.
- Keychain-backed state, encryption at rest (RFC seam reserved in core).
- Any change to `kizuki.event/v1`, `kizuki.connector/v1`, the connections
  schema, or `runBackfill`/`runSync` semantics.

## Tests

`packages/connector-telegram/test/` (bun:test, temp dirs via `mkdtempSync`,
synthetic names only — ada, grace, linus, acme):

- `app-credentials.test.ts`: `null` for placeholders, `"0"`, `"12"` +
  `""`, `"abc"`, `"-5"`; credentials for `"12345"` + `"cafe"`; `signIn` and
  `connect` throw `placeholder_credentials` with exactly
  `PLACEHOLDER_CREDENTIALS_MESSAGE` and make no API call (`calls` empty).
- `sign-in.test.ts` (scripted `SignInIo` with a prompt queue): happy path
  writes one state blob whose `parseState` gives `user_id "1001"` and the
  scripted session, returns `@ada`; password prompted only when the script
  asks, with `{ secret: true }`; phone validation refuses `"5551234"` before
  connecting; third wrong code ⇒ `sign_in_aborted` and no `state.write`;
  FloodWait 30s ⇒ one sleep(30000) and success; FloodWait 120s ⇒
  `flood_wait` with `retry_after 120` and no sleep; end-to-end through
  core's `enrollConnection(db, new ConnectionStateStore(tmp), connector,
io)` produces a row with `state_ref_index: 0` and a 0600 file whose bytes
  parse; `store.replace` re-runs sign-in and keeps the source key; the
  state bytes never reach SQLite (`readFileSync(db)` does not contain
  `FIXTURE_SESSION`).
- `connect.test.ts`: refuses without `state_ref` (`missing_session`), on
  a throwing resolver, on corrupt state (`corrupt_state`), on
  `authorized: false` (`unauthenticated`), on `me.id !== user_id`
  (`identity_mismatch`, and `disconnect` was called); succeeds with the
  matching account and never calls `start`.
- `health.test.ts`: `disabled` → `unauthenticated` (not connected) → `ok`
  → `rate_limited` with "retry after Ns" after a flood → `unreachable`
  after `disconnectNetwork()` → `unauthenticated` after `revoke()`;
  `degraded` when the dialog listing hits `MAX_DIALOGS`; every report is
  a `HealthReport`.
- `backfill.test.ts`: first batch seeds every dialog; batches never exceed
  `BATCH_LIMIT` (account with 1200 messages ⇒ 500/500/200 then empty);
  cursor resume mid-dialog replays nothing already emitted and misses
  nothing (union of batches equals the account's non-service messages);
  FloodWait mid-walk returns the partial batch with a cursor that
  resumes exactly after the last emitted id; `phase: "synced"` cursor ⇒
  no-op; two `backfill(null)` calls produce identical events.
- `sync.test.ts`: new messages after `append`; an `edit` inside the window
  re-emits with the same `source_record_id`, a different
  `computeContentHash`, and `metadata.edit_date` set; an edit older than
  `edit_watermark` is not re-emitted; a newly appeared dialog is walked;
  a partial pass resumes at `next_peer`; a caught-up sync returns an empty
  batch; `sync(null)` equals `backfill(null)`.
- `map.test.ts`: the subjects/hint table for user (incoming and outgoing),
  group, public channel, private channel; media-only message ⇒ `text ""`
  plus one attachment ref with `media_type`, `filename`, `byte_size`;
  photo ⇒ `image/jpeg`; unsupported media ⇒ `metadata.media_kind`; service
  message ⇒ `null`; `metadata` has no `views`/`forwards` key; every event
  passes `validateEventInput`.
- `cursor.test.ts`: round-trip; rejects wrong schema, non-integer
  `last_id`, unknown `peer_type`, `> MAX_DIALOGS` entries, extra keys;
  encoding sorts keys.
- `purge.test.ts`: after a backfill, `purgeSource("telegram:user:1002")`
  lists every record id from the grace dialog under
  `unreachable_source_record_ids`, `source_record_ids` empty, no API call;
  unknown subject ⇒ empty plan; the 10 000 cap holds.
- `redaction.test.ts`: `JSON.stringify(manifest())`, every `health().detail`,
  every thrown `message` across the failure cases above, every cursor and
  every event's `metadata` never contain `FIXTURE_SESSION`, the phone
  number, the code, or the password used in the sign-in script.
- `client.smoke.test.ts`: `test.skipIf(process.env.KIZUKI_TELEGRAM_SMOKE !== "1")`
  — the only test that touches `createRealApi`; documented in the README.
- `packages/connectors/test/conformance.test.ts`: extend "all registry
  connectors pass conformance" with
  `new TelegramConnector({ state_ref: "file:connections/<any ULID>.state" }, scriptedDeps())`
  after `await connector.connect(async () => encodeState(...) as text)`,
  expecting `{ pass: true, failures: [] }`; add a case that the registry
  builds `kizuki.telegram` via `getConnector`.
- `packages/core/test/ingest.test.ts`: the four `runToCompletion` cases
  from §7.

## Acceptance

```
cd packages/connector-telegram && grep -c '"telegram": "2.26.22"' package.json                       # 1
bun install --frozen-lockfile                                                                         # exit 0 (lockfile committed with the new workspace)
bun -e 'import { TelegramClient, Logger } from "telegram"; import { StringSession } from "telegram/sessions/index.js"; import { LogLevel } from "telegram/extensions/Logger.js"; new TelegramClient(new StringSession(""), 1, "x", { connectionRetries: 0, baseLogger: new Logger(LogLevel.NONE) }); console.log("quiet-ok")'
                                                                                                      # prints exactly one line: quiet-ok
grep -rl 'from "telegram' packages/connector-telegram/src | sort                                      # exactly packages/connector-telegram/src/client.ts
grep -c 'await import("telegram' packages/connector-telegram/src/client.ts                            # ≥ 1 (no static import of the library)
bun run typecheck                                                                                     # exit 0
bun test                                                                                              # green; ≥ 545 tests (main has 515), ≥ 30 in packages/connector-telegram/test
bun test packages/connectors/test/conformance.test.ts                                                 # green; the registry case includes kizuki.telegram
bun test packages/core/test/ingest.test.ts                                                            # green; runToCompletion cases present
bun run scripts/verify-network.ts                                                                     # prints "network source verification passed"
KIZUKI_TELEGRAM_API_ID=12345 KIZUKI_TELEGRAM_API_HASH=cafe bun build packages/connector-telegram/src/app-credentials.ts --env 'KIZUKI_TELEGRAM_*' --outfile "$TMPDIR/creds.js" && grep -c 12345 "$TMPDIR/creds.js"
                                                                                                      # 1 (build-time inlining works on the real module)
env -u KIZUKI_TELEGRAM_API_ID -u KIZUKI_TELEGRAM_API_HASH bun -e 'import { appCredentials } from "./packages/connector-telegram/src/app-credentials.ts"; console.log(appCredentials())'
                                                                                                      # null
bun run verify                                                                                        # exit 0 (typecheck, tests, policy test, network scan, dependency grep, identifier denylist over tracked text and commit messages)
git ls-files packages/connector-telegram | grep -c README.md                                          # 1
grep -c 'zero runtime dependencies and zero network calls' README.md                                  # 0 (pledge sentence replaced per §9)
git status --porcelain                                                                                # empty
```
