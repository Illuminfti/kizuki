# Lane: connector-x — X archive import, and bounded live sync over OAuth 2.0 PKCE

New package `packages/connector-x` (workspace name `@kizuki/connector-x`),
registered in `packages/connectors/src/registry.ts`, plus one small
additive method in `packages/core/src/ledger/connection-state.ts`. Read
CONVENTIONS.md first, then:

- `docs/architecture.md` (invariants; "Sign-in, not setup"; `kizuki.connector/v1`),
  `rfcs/0000-constraints.md` §1 (ingress frozen), §8 (zero phone-home).
- `packages/core/src/contracts/connector.ts` — the real contract on main:
  `Connector.signIn?(io: SignInIo, state: ConnectionStateWriter): Promise<SignInDisplay>`,
  `Manifest.auth_modes`, `SyncBatch`, `PurgePlan`, `HealthReport`.
  There is no `secretsDir`, no `SignInResult`, no connector-chosen
  `source_key`: the host mints the key and the state file (opaque bytes,
  written once, mode 0600) and persists only the fixed envelope.
- `packages/core/src/ledger/connection-state.ts` (`ConnectionStateStore`:
  `begin/save/read/replace/recover`, `MAX_CONNECTION_STATE_BYTES`),
  `ledger/connections.ts`, `ledger/checkpoints.ts`, `ingest/run.ts`
  (`runBackfill`/`runSync` run ONE batch and save `result.cursor` only when
  `errors.length === 0`; a thrown `backfill`/`sync` leaves the checkpoint
  untouched), `contracts/event.ts`, `util/hash.ts` (what is hashed:
  `observed_at`, `attachments`, `sensitivity_hint` are NOT; `metadata` IS).
- `packages/connectors/src/conformance.ts`, `registry.ts`, `index.ts`,
  `import-chatgpt/index.ts` (the importer shape to match),
  `markdown-folder/index.ts` (the cursor shape to match),
  `packages/connectors/test/conformance.test.ts`, `packages/connectors/AGENTS.md`.
- `packages/core/test/connections.test.ts` (how the opaque store is driven
  in tests; the fake-connector helper), `packages/core/test/ingest.test.ts`.
- `scripts/verify-network.ts` — the network scanner on main scans every
  tracked file under `packages/` for `fetch`, `Bun.serve`, `node:http` …
  and has NO allowlist today (see §7).
- The design document (`workspace/kizuki-plan/ARCHITECTURE.md`): §3.1
  (protocol, "X = OAuth 2.0 PKCE", "X = API/export", graveyard importers),
  §3.2 (conformance), §2.1 (`kind` vocabulary: `post | message | …`), §10.
- Neighbouring lane specs in this directory: `oauth-signin.md` (the core
  helper this lane consumes — see §4.3), `connector-telegram.md` (same
  package shape: a thin client behind an interface, everything else tested
  with fakes), `cli-verbs.md` §3 (how the CLI builds a connector from a
  `Connection`; the "host construction contract" in §5 below is written so
  that seam can carry sign-in connectors next).

## Objective

Two honest paths from one package, both passing the shared conformance
suite with zero network:

1. **`kizuki.import-x-archive`** — an importer over the official X data
   export (zip or unzipped folder): the owner's posts (`tweets.js`), likes
   (`like.js`) and direct messages (`direct-messages.js`,
   `direct-messages-group.js`). Import, not sync: it reads files, never the
   network.
2. **`kizuki.x`** — bounded live sync over X API v2 with an OAuth 2.0
   PKCE user-context token (public client, project-owned client id compiled
   in): own posts, mentions, bookmarks, likes. Rate-limit aware, resumable
   by checkpoint, with a per-run request budget. No writes, ever
   (`tweet.read users.read bookmark.read like.read offline.access` only).

Everything the owner would want to know about what this does NOT do is in
§0 and the package README, in the same words.

## 0. Honest limits (research packet, checked 2026-09-02 against docs.x.com)

Record this packet, with the check date, in `packages/connector-x/README.md`.
Numbers and prices change; the connector hardcodes none of them.

- **Auth.** Authorization Code with PKCE. `https://x.com/i/oauth2/authorize`,
  token endpoint `https://api.x.com/2/oauth2/token`. `code_challenge_method`
  `S256` is supported; native/CLI apps are public clients (no client
  secret). Access tokens live two hours; `offline.access` yields a refresh
  token. The docs do not state whether refresh tokens are single-use; this
  lane treats them as single-use (the conservative reading that matches
  observed provider behaviour) and persists the rotated pair before using
  it (§4.6). Redirect URIs are exact-match; the loopback URI is fixed (§4.3).
- **Endpoints and scopes** (all GET, user context):
  `/2/users/me` (`users.read`); `/2/users/{id}/tweets` and
  `/2/users/{id}/mentions` (`tweet.read users.read`; `max_results` 5–100,
  `pagination_token`, `since_id`, `start_time` ≥ 2010-11-06;
  `meta.newest_id/oldest_id/next_token/result_count`);
  `/2/users/{id}/bookmarks` (`bookmark.read`; `max_results` 1–100,
  `pagination_token`; NO `since_id`); `/2/users/{id}/liked_tweets`
  (`like.read`; `max_results` 5–100, `pagination_token`; NO `since_id`).
  Rate limiting is per endpoint per 15-minute window, signalled by
  `x-rate-limit-limit / -remaining / -reset` headers and HTTP 429.
- **Pricing.** The owner's decision funds the "Basic" plan. On the check
  date docs.x.com describes pay-per-usage credits (per-resource read prices,
  a cheaper "owned reads" rate, a monthly read cap) rather than named
  tiers. The connector is plan-agnostic: it obeys headers and its own
  budget; the README states the model seen on the check date and tells the
  owner to re-verify before funding. Do not encode a plan name in code.
- **History bounds.** Timelines are bounded by the provider (recent posts
  only; the exact depth is not stated on the check-date pages and older
  docs said 3,200 posts / 800 mentions). Deeper history comes from the
  archive importer. Bookmarks and likes have no `since_id`: incremental
  sync walks newest-first until it meets the last known head (§4.8).
- **What the API does not tell us.** When a like or bookmark happened (only
  the post's `created_at` is available — recorded as `occurred_at` with
  `metadata.occurred_at_basis: "post_created_at"`); post deletions,
  un-likes, un-bookmarks (no tombstones: `capabilities.tombstones: false`);
  DMs over the API (needs `dm.read`; not in this lane).
- **What the archive does not contain.** Bookmarks; mentions; the time of a
  like (`like.js` has `tweetId`, `fullText`, `expandedUrl` only — occurred_at
  is derived from the post id's snowflake timestamp, basis
  `"post_created_at"`, or falls back to the archive's generation date /
  observation time for pre-snowflake ids); the liked post's author; whether
  the account is protected. Large archives are split (`tweets-part1.js` …)
  and may ship as several zip files or use zip64 — the importer reads split
  parts, refuses zip64 with an exact message, and reads an unzipped folder
  in every case.
- **Overlap.** Importing an archive and then backfilling live yields the
  recent posts twice (two connector ids → two ledger events, two capture
  proposals). Both paths use the same `source_record_id` grammar (§2) so a
  later normalization layer can unify them; this lane does not.

## 1. Package layout, dependencies, registration

```
packages/connector-x/
  package.json          name @kizuki/connector-x, "type": "module", module src/index.ts,
                        dependencies { "@kizuki/core": "workspace:*" }   ← product code imports ONLY core
                        devDependencies { "@kizuki/connectors": "workspace:*" }  ← tests use runConformance
  README.md             §0 packet verbatim, the compile-time credential procedure, owner steps, limits
  src/
    index.ts            public exports (listed in §6)
    ids.ts              connector ids, subject/record id grammar, snowflakeTime, parseArchiveDate
    errors.ts           XConnectorError
    events.ts           the four event builders shared by both paths
    app-credentials.ts  X_CLIENT_ID (compile-time) + the refusal message
    fixture.ts          X_FIXTURE_ARCHIVE, X_FIXTURE_STATE, createFixtureXApi, X_FIXTURE_API
    archive/
      reader.ts         ArchiveReader + memoryArchive + openDirectoryArchive + openArchive
      zip.ts            zero-dependency zip reader (STORE + DEFLATE via node:zlib)
      ytd.ts            parseYtd, parseTharManifest
      parse.ts          parseXArchive: files → CaptureEventInput[]
      connector.ts      XArchiveImportConnector
    live/
      state.ts          XConnectionState encode/decode
      cursor.ts         XCursor encode/decode
      client.ts         XApi + createFetchXApi — the ONLY file in the package that calls fetch
      oauth.ts          xProvider, redirect constants, the OAuthSeam adapter over @kizuki/core auth
      streams.ts        the run loop: four streams, budget, rate limits, refresh
      connector.ts      XConnector
  test/                 see "Tests"
```

No runtime dependency outside the workspace. Zip inflation uses
`node:zlib` (`inflateRawSync`, `crc32`; verified present on Bun 1.3.14).
`@kizuki/core` stays dependency-free.

**No workspace cycle.** `packages/connectors` gains
`"@kizuki/connector-x": "workspace:*"` and registers both connectors;
therefore `packages/connector-x/src/**` must not import `@kizuki/connectors`
(a test asserts this by scanning the source). Errors are the package's own
`XConnectorError` (§1.1); the conformance suite's `KizukiError`
fail-closed check only runs for `required_secrets.length > 0`, which is
`[]` for both connectors (state is created by sign-in, not supplied up
front), so the suite's semantics are unchanged.

### 1.1 Errors (`src/errors.ts`)

```ts
export type XErrorCode =
  | "misconfigured"
  | "unauthenticated"
  | "rate_limited"
  | "unreachable"
  | "parse_error"
  | "provider_error";
export class XConnectorError extends Error {
  override name = "XConnectorError";
  readonly code: XErrorCode;
  /** RFC3339; present only for rate_limited. */
  readonly retry_at: string | undefined;
  constructor(
    code: XErrorCode,
    message: string,
    options?: ErrorOptions & { retry_at?: string },
  );
}
```

Messages never contain captured text, tokens, cursor tokens, or provider
response bodies. An archive entry name may appear in a message only if it
matches `^data/[A-Za-z0-9_./-]{1,200}$`; otherwise the message says
`<unsafe entry name>`.

## 2. Shared identity grammar and event shapes (`src/ids.ts`, `src/events.ts`)

```ts
export const X_CONNECTOR_ID = "kizuki.x" as const;
export const X_ARCHIVE_IMPORT_CONNECTOR_ID = "kizuki.import-x-archive" as const;

export function userSubjectId(userId: string): string; // `x:user:<id>`; id must match /^[0-9]{1,20}$/ else parse_error
export function conversationSubjectId(conversationId: string): string; // `x:dm:<conversation id>`
export function postRecordId(postId: string): string; // `post:<id>`
export function likeRecordId(postId: string): string; // `like:<id>`
export function bookmarkRecordId(postId: string): string; // `bookmark:<id>`
export function dmRecordId(conversationId: string, messageId: string): string; // `dm:<conversation>:<message>`
/** RFC3339 (ms) from (id >> 22) + 1288834974657; null unless id is numeric and the instant is ≥ 2010-11-04T00:00:00Z. */
export function snowflakeTime(id: string): string | null;
/** "Wed Oct 10 20:19:24 +0000 2018" → "2018-10-10T20:19:24.000Z" by explicit regex + Date.UTC; null otherwise. */
export function parseArchiveDate(value: unknown): string | null;
```

```ts
export interface SelfIdentity {
  user_id: string;
  username: string | null;
  protected: boolean;
}
export interface PostRecord {
  post_id: string;
  author_id: string;
  author_username: string | null;
  author_protected: boolean;
  text: string;
  created_at: string; // RFC3339
  in_reply_to_post_id: string | null;
  in_reply_to_user_id: string | null;
  lang: string | null;
  urls: string[]; // expanded URLs from entities, in order, deduped
  mentioned: { user_id: string; username: string | null }[];
  media: AttachmentRef[];
}
export type PostStream = "own" | "mention";
export interface LikedRecord {
  post_id: string;
  text: string;
  author_id: string | null;
  author_username: string | null;
  post_created_at: string;
  occurred_at_basis: "post_created_at" | "archive_generated_at" | "observed_at";
  expanded_url: string | null;
}
export interface DmRecord {
  conversation_id: string;
  message_id: string;
  sender_id: string;
  recipient_id: string | null;
  text: string;
  created_at: string;
  urls: string[];
  media: AttachmentRef[];
}

export function postEvent(
  connectorId: string,
  stream: PostStream,
  self: SelfIdentity,
  post: PostRecord,
  observedAt: string,
): CaptureEventInput;
export function likeEvent(
  connectorId: string,
  self: SelfIdentity,
  liked: LikedRecord,
  observedAt: string,
): CaptureEventInput;
export function bookmarkEvent(
  connectorId: string,
  self: SelfIdentity,
  post: PostRecord,
  observedAt: string,
): CaptureEventInput;
export function dmEvent(
  connectorId: string,
  self: SelfIdentity,
  message: DmRecord,
  observedAt: string,
): CaptureEventInput;
```

| kind             | source_record_id  | text                                                      | occurred_at             | subjects (in this order)                                                                              | sensitivity_hint                                | metadata (exact keys; hashed, keep stable)                                                    |
| ---------------- | ----------------- | --------------------------------------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `post` (own)     | `post:<id>`       | post text verbatim (`note_tweet.text` when present, live) | `created_at`            | `from` self; `to` `in_reply_to_user_id` if set; `about` each mentioned user (deduped, excluding self) | `personal` if `self.protected`, else `public`   | `{ stream: "own", post_id, author_id, in_reply_to_post_id, in_reply_to_user_id, lang, urls }` |
| `post` (mention) | `post:<id>`       | same                                                      | `created_at`            | `from` author; `to` self; `about` other mentioned users                                               | `personal` if `author_protected`, else `public` | `{ stream: "mention", … same keys }`                                                          |
| `bookmark`       | `bookmark:<id>`   | post text                                                 | `post_created_at`       | `from` self; `about` author                                                                           | `private`                                       | `{ post_id, author_id, post_created_at, occurred_at_basis }`                                  |
| `like`           | `like:<id>`       | post text (`""` when the archive omitted `fullText`)      | see `occurred_at_basis` | `from` self; `about` author when known                                                                | `personal`                                      | `{ post_id, author_id, post_created_at, occurred_at_basis, expanded_url }`                    |
| `message`        | `dm:<conv>:<msg>` | message text                                              | `createdAt`             | `from` sender; `to` recipient (1:1) or `about` conversation (`x:dm:<conv>`, group)                    | `private`                                       | `{ conversation_id, message_id, sender_id, recipient_id, urls, media_count }`                 |

`display_name` on a subject is `@<username>` when the username is known,
omitted otherwise (never a guessed value). `deleted` is always `false`.
`attachments` are references only (`attachment_id`, `media_type`,
`filename?`, `byte_size?`) — nothing is downloaded or copied. `metadata`
values are strings, `null`, arrays of strings, or numbers — never nested
provider objects (the hash must not depend on provider field churn).

## 3. Archive importer

### 3.1 Reader (`src/archive/reader.ts`, `src/archive/zip.ts`)

```ts
export interface ArchiveEntry {
  name: string;
  size: number;
}
export interface ArchiveReader {
  /** Regular files under `prefix` (e.g. "data/tweets_media/"), sorted by name. */
  list(prefix: string): ArchiveEntry[];
  /** Whole entry; refuses > MAX_ENTRY_BYTES with parse_error naming the entry. */
  read(name: string): Promise<Uint8Array>;
  close(): Promise<void>;
}
export const MAX_ENTRY_BYTES = 512 * 1024 * 1024;
export function memoryArchive(files: Record<string, string>): ArchiveReader;
export async function openDirectoryArchive(
  root: string,
): Promise<ArchiveReader>;
export async function openZipArchive(path: string): Promise<ArchiveReader>;
/** Directory → directory reader; regular file starting with "PK\x03\x04" or "PK\x05\x06" → zip; anything else → misconfigured. */
export async function openArchive(path: string): Promise<ArchiveReader>;
```

Directory mode: every path is `lstat`ed; a symlink anywhere on the path
(file or `data/` directory) → `misconfigured`
`kizuki.import-x-archive: refusing symlink: <relpath>`. Only the files the
parser asks for are read; media directories are listed for names and sizes.

Zip mode (zero dependency; positional `openSync`/`readSync`, never the whole
file in memory):

- Locate the end-of-central-directory record in the last 65,557 bytes;
  absent → `parse_error` "not a zip archive". Parse the central directory
  (`0x02014b50` entries); exposed pure as
  `parseCentralDirectory(bytes: Uint8Array, offset: number, count: number): ZipEntry[]`
  for unit tests.
- Refuse (exact message, no partial read): a zip64 end-of-central-directory
  locator (`0x07064b50`) or any 32-bit size/offset field equal to
  `0xFFFFFFFF` → `misconfigured`
  `kizuki.import-x-archive: archive uses zip64; unzip it and pass the folder path`.
- Per entry: compression method must be 0 (STORE) or 8 (DEFLATE), else
  `parse_error`; general-purpose flag bit 0 (encrypted) → `parse_error`;
  sizes come from the central directory (bit 3 data descriptors are fine);
  `uncompressed_size > MAX_ENTRY_BYTES` → `parse_error`;
  `uncompressed_size > 1000 × compressed_size` (bomb guard, compressed > 0)
  → `parse_error`; the inflated byte length must equal the declared size
  and the `crc32` must match, else `parse_error`.
- Names are attacker-controlled: an entry whose name is absolute, contains
  a `..` segment, a backslash, or a NUL is ignored for listing and can never
  be `read()` (the reader only ever resolves names the parser asks for;
  nothing is extracted to disk). Two entries with the same name →
  `parse_error` "duplicate entry".
- The local file header at `local_header_offset` is parsed only for its
  variable-length name/extra sizes to find the data start.

### 3.2 YTD files (`src/archive/ytd.ts`)

```ts
/** Strips /^﻿?\s*window\.YTD\.[A-Za-z0-9_]+\.part[0-9]+\s*=\s*/ then JSON.parse; must be an array. */
export function parseYtd(source: string, label: string): unknown[];
export interface ArchiveManifest {
  account_id: string | null;
  username: string | null;
  generated_at: string | null;   // archiveInfo.generationDate normalized to RFC3339, else null
  files: Record<"tweets" | "like" | "direct_messages" | "direct_messages_group" | "account", string[]>;
}
/** Strips /^﻿?\s*window\.__THAR_CONFIG\s*=\s*/; null when the prefix is absent. */
export function parseTharManifest(source: string): ArchiveManifest | null;
```

Malformed JSON → `parse_error` "<label>: malformed JSON" (never echo the
text). Inputs above `MAX_ENTRY_BYTES` are refused before decoding.

### 3.3 Parse (`src/archive/parse.ts`)

```ts
export async function parseXArchive(
  reader: ArchiveReader,
  observedAt?: string,
): Promise<CaptureEventInput[]>;
export function locateDataFiles(
  reader: ArchiveReader,
  manifest: ArchiveManifest | null,
): Record<keyof ArchiveManifest["files"], string[]>;
```

- `data/manifest.js` when present enumerates the split files per data type
  (`dataTypes.<type>.files[].fileName`) and gives `userInfo.accountId /
userName`. Without it, `locateDataFiles` falls back to these names, sorted
  by (base, part number): `data/tweets.js`, `data/tweets-part<N>.js`,
  legacy `data/tweet.js`, `data/tweet-part<N>.js`; `data/like.js`,
  `data/like-part<N>.js`; `data/direct-messages.js`,
  `data/direct-messages-part<N>.js`; `data/direct-messages-group.js`,
  `data/direct-messages-group-part<N>.js`; `data/account.js`.
- Self identity: `data/account.js` → `account.accountId`, `account.username`
  (the file also carries the owner's email: it is read and dropped, never
  placed in metadata, events, errors or logs). Fallback: manifest
  `userInfo`. Neither → `misconfigured`
  `kizuki.import-x-archive: archive has no data/account.js; cannot attribute posts to an account`.
  `protected` is `false` (the archive does not say; README states it).
- Posts (`tweet` objects): `id_str` (or `id`), `full_text` (or `text`),
  `created_at` via `parseArchiveDate` (unparseable → `parse_error` naming
  the record id), `in_reply_to_status_id_str`, `in_reply_to_user_id_str`,
  `lang`, `entities.urls[].expanded_url`, `entities.user_mentions[]`
  (`id_str`, `screen_name`), media from `extended_entities.media` or
  `entities.media` matched to files listed under `data/tweets_media/` whose
  name starts with `<post_id>-` (attachment_id = file basename, media_type
  by extension: jpg/jpeg → `image/jpeg`, png → `image/png`, gif →
  `image/gif`, webp → `image/webp`, mp4 → `video/mp4`, mov →
  `video/quicktime`, other → `application/octet-stream`; `filename` =
  entry name; `byte_size` = entry size). Retweets stay verbatim (`RT @…`).
  A record without `id_str`/`id` or without text is skipped and counted
  (the count is in the connector's health detail, not an error).
- Likes (`like` objects): `tweetId` required (else skipped), `fullText`
  (absent → `""`), `expandedUrl`. `occurred_at` = `snowflakeTime(tweetId)`
  (basis `post_created_at`), else manifest `generated_at`
  (`archive_generated_at`), else `observedAt` (`observed_at`).
- Direct messages (`dmConversation` objects): only `messageCreate` entries
  become events; `joinConversation`, `participantsJoin`, `participantsLeave`,
  `conversationNameUpdate` and unknown entries are skipped. `recipientId`
  is `null` in group files; media matched by `<message_id>-` prefix under
  `data/direct_messages_media/` and `data/direct_messages_group_media/`.
- Output order is deterministic: sort by `occurred_at`, then
  `source_record_id` (code-unit order).

### 3.4 Connector (`src/archive/connector.ts`)

```ts
export interface XArchiveImportConfig {
  path: string;
}
export class XArchiveImportConnector implements Connector {
  readonly path: string;
  constructor(config: XArchiveImportConfig); // non-empty string path else misconfigured (same message shape as import-chatgpt)
}
export function createXArchiveImportConnector(
  config: XArchiveImportConfig,
): XArchiveImportConnector;
```

Manifest: `connector_id: "kizuki.import-x-archive"`, `version: "0.1.0"`,
`kinds: ["post", "like", "message"]`, capabilities
`{ backfill: true, sync: true, tombstones: false, purge: false, fixture: true }`,
`required_secrets: []`, `emits_sensitivity_hint: true`, `auth_modes: ["none"]`.
`health()`: `ok` when `path` is a directory or a regular zip file the
reader opens; `misconfigured` with the reason otherwise; never reads data
files. `connect()` is a no-op (no credentials exist). `backfill(_)` returns
every event with `cursor: null` (whole-file import, like `import-chatgpt`);
`sync(cursor)` = `backfill(cursor)`. `revoke()` no-op. `purgeSource(id)`
returns the empty plan. `fixture()` parses `memoryArchive(X_FIXTURE_ARCHIVE)`
with a fixed `observedAt` — no filesystem, no network.

## 4. Live connector

### 4.1 Compiled credentials (`src/app-credentials.ts`)

```ts
/** Compile-time: `bun build --define 'process.env.KIZUKI_X_CLIENT_ID="…"'`; dev: the env var at load. */
export const X_CLIENT_ID: string =
  process.env["KIZUKI_X_CLIENT_ID"] ?? X_CLIENT_ID_PLACEHOLDER;
export const X_CLIENT_ID_PLACEHOLDER = "";
export const X_CLIENT_ID_MISSING =
  "kizuki.x: this build carries no X app client id; rebuild with KIZUKI_X_CLIENT_ID set (see packages/connector-x/README.md)";
export function hasAppCredentials(): boolean; // X_CLIENT_ID !== X_CLIENT_ID_PLACEHOLDER
```

X is a public client: there is no secret to compile in. `signIn` and
`health` refuse with `X_CLIENT_ID_MISSING` (code `misconfigured`) while the
placeholder is in place; nothing user-facing ever asks for a client id.
The README documents the one-time project step (register the app as a
native/public client with the exact redirect URI of §4.3) and the build
command.

### 4.2 Connection state (`src/live/state.ts`) — the opaque bytes

```ts
export const X_STATE_SCHEMA = "kizuki.connector-x.state/v1" as const;
export const X_REQUIRED_SCOPES = [
  "bookmark.read",
  "like.read",
  "offline.access",
  "tweet.read",
  "users.read",
] as const;
export interface XConnectionState {
  schema: typeof X_STATE_SCHEMA;
  user_id: string; // numeric X id; the stable identity of this connection
  username: string | null; // at sign-in; display only
  protected: boolean; // at sign-in; drives the own-post hint
  granted_scopes: string[]; // sorted
  tokens: TokenSet; // from @kizuki/core auth (oauth-signin lane); refresh_token required
}
export function encodeState(state: XConnectionState): Uint8Array; // JSON, UTF-8, keys sorted
export function decodeState(bytes: Uint8Array): XConnectionState; // TextDecoder fatal; exact key set; refuses a missing refresh_token, unknown keys, non-RFC3339 expires_at → unauthenticated "kizuki.x: stored session is invalid; run: kizuki connect x"
```

Written only through the host's `ConnectionStateWriter` (sign-in) or the
host's `persistState` callback (rotation, §4.6). Never in SQLite, the
manifest, the cursor, an event, an error message, or a log line. The
encoded size is far below `MAX_CONNECTION_STATE_BYTES`.

### 4.3 Sign-in (`src/live/oauth.ts`, `signIn`)

Depends on lane **oauth-signin** (NEW on main; not present today): from
`@kizuki/core` `signInWithBrowser(provider, io, opts)`, `refresh(provider, tokens)`,
`OAuthProvider`, `TokenSet`. Isolate them behind one seam so a signature
change lands in one file:

```ts
export const X_LOOPBACK_PORT = 18477;
export const X_REDIRECT_URI = `http://127.0.0.1:${X_LOOPBACK_PORT}/callback`;
export function xProvider(clientId: string): OAuthProvider;
// name "x", authorization_url "https://x.com/i/oauth2/authorize", token_url "https://api.x.com/2/oauth2/token",
// client_id, no client_secret, scopes [...X_REQUIRED_SCOPES], extra_authorization_params {}
export interface OAuthSeam {
  signInWithBrowser: (
    provider: OAuthProvider,
    io: SignInIo,
    opts: { port: number; timeoutMs: number },
  ) => Promise<TokenSet>;
  refresh: (provider: OAuthProvider, tokens: TokenSet) => Promise<TokenSet>;
}
export const coreOAuth: OAuthSeam; // the real @kizuki/core functions
```

`signIn(io, state)`:

1. `hasAppCredentials()` false → throw `X_CLIENT_ID_MISSING`; no prompt, no
   listener, no state write.
2. `tokens = await oauth.signInWithBrowser(xProvider(X_CLIENT_ID), io, { port: X_LOOPBACK_PORT, timeoutMs: 300_000 })`.
   The port is fixed because X validates redirect URIs by exact match; a
   busy port surfaces as the core helper's error, unchanged (no fallback
   port — that would silently break the exact match).
3. Granted scopes = `tokens.scope.split(" ")`; any of `X_REQUIRED_SCOPES`
   missing → throw `unauthenticated`
   `kizuki.x: sign-in did not grant required scopes: <missing, sorted, space-separated>`
   — no state written (fail closed), so the stored session can never lack a
   scope the streams need.
4. `GET /2/users/me?user.fields=id,username,protected` with the access
   token (1 request) → `user_id`, `username`, `protected`.
5. `await state.write(encodeState({...}))` exactly once; return
   `{ display: "@<username>" }` (or `user <id>` when the username is
   empty). The display string is ephemeral by contract.

### 4.4 Client (`src/live/client.ts`) — the only network file

```ts
export interface XApiRequest {
  method: "GET" | "POST";
  path: string; // "/2/users/me", "/2/users/1001/tweets", "/2/oauth2/revoke"
  query?: Record<string, string>;
  form?: Record<string, string>; // POST bodies (revoke only)
  access_token?: string; // Bearer; absent for revoke
}
export interface XApiResponse {
  status: number;
  headers: Record<string, string>; // lower-cased names; only x-rate-limit-*, content-type, retry-after are kept
  body: unknown; // parsed JSON, or null when not JSON
}
export interface XApi {
  request(req: XApiRequest): Promise<XApiResponse>;
}
export function createFetchXApi(opts?: {
  base_url?: string;
  timeout_ms?: number;
}): XApi;
// base_url default "https://api.x.com"; timeout default 30_000 via AbortSignal.timeout; a thrown fetch error or timeout →
// XConnectorError("unreachable", "kizuki.x: <base host> unreachable") with the cause attached, never the URL query
```

`fetch` appears here and nowhere else in the package (test-enforced). The
core helper's token endpoint traffic lives in core's `auth/oauth.ts`
(oauth-signin lane).

### 4.5 Cursor (`src/live/cursor.ts`) — opaque to the spine, versioned by us

```ts
export const X_CURSOR_SCHEMA = "kizuki.connector-x.cursor/v1" as const;
export type StreamName = "own" | "mentions" | "bookmarks" | "likes";
export interface SinceStream {
  // own, mentions (since_id-capable)
  phase: "backfill" | "sync";
  page: string | null; // pagination_token of the next page of an in-progress walk
  newest_id: string | null; // highest post id fully walked; since_id for sync
  pending_newest_id: string | null; // newest id seen by the in-progress walk; promoted when the walk completes
  paused_until: string | null; // RFC3339 from x-rate-limit-reset / 429
}
export interface HeadStream {
  // bookmarks, likes (no since_id)
  phase: "backfill" | "sync";
  page: string | null;
  head_id: string | null; // first post id of the last completed walk
  pending_head_id: string | null;
  paused_until: string | null;
}
export interface XCursor {
  schema: typeof X_CURSOR_SCHEMA;
  own: SinceStream;
  mentions: SinceStream;
  bookmarks: HeadStream;
  likes: HeadStream;
  paused_until: string | null; // global (monthly cap)
}
export function initialCursor(): XCursor;
export function encodeCursor(cursor: XCursor): string;
export function decodeCursor(cursor: string): XCursor; // parse_error "kizuki.x: malformed cursor" on any deviation, including another schema value
```

Contains pagination tokens and post ids only — never credentials.

### 4.6 The run loop (`src/live/streams.ts`)

```ts
export interface XLimits {
  max_requests_per_run: number; // default 40 — every API request in a run counts, refreshes excluded
  max_pages_per_stream: number; // default 10
  page_size: number; // default 100 (clamped to each endpoint's documented range)
}
export const DEFAULT_LIMITS: XLimits;
export interface LiveContext {
  api: XApi;
  oauth: OAuthSeam;
  limits: XLimits;
  now: () => Date;
  state: XConnectionState;
  persistState: ((bytes: Uint8Array) => Promise<void>) | null;
}
/** One bounded run over the four streams; the same function backs backfill and sync. */
export async function advance(
  ctx: LiveContext,
  cursor: XCursor,
): Promise<SyncBatch>;
```

Requests (exact):

- `GET /2/users/{id}/tweets` and `GET /2/users/{id}/mentions`:
  `max_results`, `tweet.fields=id,text,created_at,author_id,in_reply_to_user_id,referenced_tweets,entities,attachments,lang,note_tweet`,
  `expansions=author_id,attachments.media_keys,entities.mentions.username`,
  `user.fields=id,username,protected`, `media.fields=media_key,type`, plus
  `pagination_token` (walk in progress) or `since_id` (sync).
- `GET /2/users/{id}/bookmarks`, `GET /2/users/{id}/liked_tweets`: same
  field sets, `pagination_token` only.
- Responses: `data[]` (absent when `meta.result_count` is 0),
  `includes.users[]`, `includes.media[]`, `meta.next_token`,
  `meta.newest_id`. Media → `AttachmentRef { attachment_id: media_key,
media_type: photo → "image/*", video → "video/*", animated_gif → "image/gif" }`.

Algorithm, per run:

1. `if (cursor.paused_until && now < paused_until)` → throw
   `rate_limited` with `retry_at` (message
   `kizuki.x: rate limited by the provider until <RFC3339>`; the runner keeps
   the checkpoint; the CLI prints it and exits 1 — a wait is a fact the
   owner should see).
2. Token freshness: `tokens.expires_at ≤ now + 60s` → `refreshTokens()`
   (below) before the first request.
3. Streams in order `own, mentions, bookmarks, likes`. For each: skip when
   `paused_until > now`; otherwise fetch pages while `requests_left > 0`
   and `pages < max_pages_per_stream`:
   - **Since streams.** `phase backfill`: walk newest→oldest with
     `pagination_token`; on the first page record
     `pending_newest_id = meta.newest_id`; when `next_token` is absent →
     `newest_id = pending_newest_id`, `page = null`, `phase = "sync"`.
     `phase sync`: request with `since_id = newest_id` (no `since_id` when
     null); paginate the same way; `pending_newest_id` = max id seen;
     promote on completion. A walk interrupted by the page cap or budget
     keeps `page` and `pending_newest_id` and resumes next run — a partial
     walk never advances `newest_id`, so nothing is skipped.
   - **Head streams.** `phase backfill`: walk all pages; `pending_head_id`
     = first id of the first page; completion → `head_id`. `phase sync`:
     walk from the first page; stop after the page that contains `head_id`
     (items after it on that page are not emitted); if the walk exhausts
     without meeting `head_id` (removed, or more new items than pages)
     continue next run from `page`; on completion `head_id = pending_head_id`.
   - Every fetched item becomes one event (`postEvent` own/mention,
     `bookmarkEvent`, `likeEvent` with basis `post_created_at`). A page
     that repeats ids already emitted in this run is deduped in-run; across
     runs the ledger dedupes.
4. Response handling: `200` → as above; `401` → `refreshTokens()` once per
   run then retry the same request once, a second `401` (or a failed
   refresh) → throw `unauthenticated`
   `kizuki.x: the provider rejected the session; run: kizuki connect x`;
   `429` → the stream's `paused_until = x-rate-limit-reset` (unix seconds →
   RFC3339; header absent → now + 15 min), the stream keeps its `page`, the
   run moves to the next stream; a `429` whose body `title` is
   `UsageCapExceeded` → `cursor.paused_until = now + 24h` and the run ends;
   `x-rate-limit-remaining: 0` on a `200` → set the stream's `paused_until`
   from the reset header and move on (do not spend the last request into a
   429); `400` whose body `errors[].parameters` names `pagination_token` →
   reset that stream's `page` (the walk restarts; ledger dedupe makes it
   idempotent) and continue; any other `4xx` → throw `provider_error`
   `kizuki.x: provider returned <status> <title-or-empty>`; `5xx` or a
   thrown `unreachable` → rethrow. A throw abandons the run: the runner
   keeps the previous checkpoint, and the next run refetches at most
   `max_requests_per_run` pages.
5. Return `{ events, cursor: encodeCursor(next) }`. The cursor is never
   `null`: a live source is never exhausted. When no stream could make
   progress because all four are paused → throw `rate_limited` with the
   earliest `paused_until` (nothing to save).

`refreshTokens()`: `oauth.refresh(xProvider(X_CLIENT_ID), state.tokens)` →
`next = { ...state, tokens }`; **persist before use**:
`ctx.persistState === null` → throw `misconfigured`
`kizuki.x: credentials rotated but the host supplied no persistState; refusing to continue`
(the in-memory tokens are dropped; the on-disk session stays whatever it
was); otherwise `await ctx.persistState(encodeState(next))`, then swap
`ctx.state = next`. Only after the callback resolves may the new access
token be sent. A refresh is attempted at most once per run.

### 4.7 Connector (`src/live/connector.ts`)

```ts
export interface XConnectorConfig {
  /** The opaque bytes the host read with ConnectionStateStore.read(); null before sign-in. */
  state: Uint8Array | null;
  /** Host-supplied durable writer for rotated credentials (§5); absent in tests and before sign-in. */
  persistState?: (state: Uint8Array) => Promise<void>;
  api?: XApi; // default createFetchXApi()
  oauth?: OAuthSeam; // default coreOAuth
  limits?: Partial<XLimits>;
  now?: () => Date;
}
export class XConnector implements Connector {
  constructor(config: XConnectorConfig);
  manifest(): Manifest;
  health(): Promise<HealthReport>;
  connect(resolve: SecretResolver): Promise<void>;
  signIn(io: SignInIo, state: ConnectionStateWriter): Promise<SignInDisplay>;
  backfill(cursor: Cursor | null): Promise<SyncBatch>;
  sync(cursor: Cursor | null): Promise<SyncBatch>;
  revoke(): Promise<void>;
  purgeSource(subject_id: string): Promise<PurgePlan>;
  fixture(): Promise<CaptureEventInput[]>;
}
export function createXConnector(config: XConnectorConfig): XConnector;
```

- Manifest: `connector_id: "kizuki.x"`, `version: "0.1.0"`,
  `kinds: ["post", "bookmark", "like"]`, capabilities
  `{ backfill: true, sync: true, tombstones: false, purge: false, fixture: true }`,
  `required_secrets: []`, `emits_sensitivity_hint: true`, `auth_modes: ["oauth"]`.
- `connect(_resolve)`: `state === null` → throw `unauthenticated`
  `kizuki.x: not signed in; run: kizuki connect x`; else `decodeState`
  (its own refusal message) and verify `granted_scopes ⊇ X_REQUIRED_SCOPES`
  (missing → the §4.3 scopes message). No network. The resolver is unused:
  this connector declares no `required_secrets`.
- `health()`: placeholder client id → `misconfigured` (`X_CLIENT_ID_MISSING`);
  `state === null` → `disabled`; undecodable state → `unauthenticated`;
  otherwise one `GET /2/users/me` (with the §4.6 401/refresh rule): `200`
  whose `data.id` equals `state.user_id` → `ok` with `last_success_at`;
  a different id → `misconfigured` "signed-in account differs from the
  stored identity"; `401` after refresh → `unauthenticated`; `429` →
  `rate_limited` with `detail: "retry after <RFC3339>"`; network →
  `unreachable`. `detail` never carries tokens or body text.
- `backfill(cursor)` and `sync(cursor)` both: `connect`-level validation,
  then `advance(ctx, cursor === null ? initialCursor() : decodeCursor(cursor))`.
  (`backfill(null)` starts the four walks; `sync(null)` is identical —
  the cursor, not the verb, carries the phase.)
- `revoke()`: best effort `POST /2/oauth2/revoke` with form
  `{ token: refresh_token, token_type_hint: "refresh_token", client_id }`
  (one request; any failure becomes the return value's absence of effect —
  it is logged nowhere and thrown nowhere), then drop the in-memory state.
  The host disconnects the row; the README states that the on-disk state
  file remains until the owner purges the connection (no delete API on the
  store today — open question).
- `purgeSource(subject_id)`: the empty plan (`purge: false` is honest: read
  scopes cannot delete at the source and the connector keeps no record
  index; subject-keyed purge works on the ledger through
  `purgeEvents(db, vaultPath, { connector_id: "kizuki.x", subject_handle, source_key }, reason)`;
  the source key is required for source-bound evidence).
- `fixture()`: `advance` over `createFixtureXApi()` with `X_FIXTURE_STATE`
  and a fixed clock, until the cursor's four streams are in `phase: "sync"`;
  returns the accumulated events (deterministic, no network).

### 4.8 Fixtures (`src/fixture.ts`)

- `X_FIXTURE_ARCHIVE: Readonly<Record<string, string>>` — `data/manifest.js`,
  `data/account.js` (account 1001 `ada`, a synthetic email that is asserted
  absent from every event), `data/tweets.js` (5 posts: a plain post, a
  reply to grace 1002, a retweet of linus 1003 kept verbatim, a post with
  one media entry matched to `data/tweets_media/<id>-fixture.jpg`, a post
  mentioning grace and linus), `data/like.js` (3 likes: a snowflake id, a
  pre-snowflake id, one without `fullText`), `data/direct-messages.js` (3
  messages ada↔grace), `data/direct-messages-group.js` (one `messageCreate`
  and one `participantsJoin`), plus the media file entry. Parsed count: 12
  events (5 post, 3 like, 4 message).
- `X_FIXTURE_STATE: Uint8Array` — `encodeState` of user 1001 `ada`,
  unprotected, all scopes, tokens
  `{ access_token: "fixture-access-token-not-a-credential", refresh_token: "fixture-refresh-token-not-a-credential", expires_at: "2099-01-01T00:00:00.000Z", scope: "<required scopes>", token_type: "bearer" }`.
- `createFixtureXApi(overrides?: Partial<FixtureScript>): XApi` — scripted
  from `X_FIXTURE_API`: `/2/users/me` → ada; own timeline two pages (3 + 2
  posts, `next_token` on page one, `newest_id`); mentions one page (2 posts,
  one by a protected grace → `personal`); bookmarks one page (2); likes one
  page (2). Backfill total: 11 events. Every response carries
  `x-rate-limit-*` headers. Overrides let tests script 401/429/400/5xx,
  header values and extra pages.

## 5. Core seam (NEW, additive): rotated credentials, and the host construction contract

### 5.1 `ConnectionStateStore.rotate` (`packages/core/src/ledger/connection-state.ts`)

X refresh tokens are treated as single-use (§0): after a refresh the stored
session must be replaced without an interactive sign-in. The store today
offers only `replace(db, connection, connector, io)`, which runs `signIn`.
Add the non-interactive sibling and refactor `replace` onto the shared
guards:

```ts
/**
 * Non-interactive re-key for credential rotation (single-use refresh
 * tokens). Same guards and durability path as replace(): recover(db); the
 * persisted row must equal `connection` field-for-field; the row must be
 * state-bearing (state_ref_index === 0) with its file present; then
 * beginFor(source_key) → write(state) → save(): journal, rollback, atomic
 * rename, connected_at strictly monotonic. On any failure the previous
 * state file is intact. Throws LedgerError.
 */
rotate(db: Database, connection: Connection, state: Uint8Array): Connection;
```

Implementation: extract the guard block of `replace()` into a private
`assertReplaceable(db, connection): Connection`; `replace` = guards →
`signIn` → save; `rotate` = guards → `writer.write(state)` → save. No
public export changes (`packages/core/test/index.test.ts` stays as is).

### 5.2 Host construction contract (documented here; wired by the CLI sign-in lane)

For `auth_modes: ["none"]` connectors the CLI decodes its own host envelope
and calls `getConnector(id, { path })` (cli-verbs §3). For this connector
the host passes the raw bytes and a persist callback:

```ts
const bytes = store.read(connection); // Uint8Array | null
const connector = getConnector(X_CONNECTOR_ID, {
  state: bytes,
  persistState: async (next) => {
    store.rotate(db, connection, next);
  },
});
await connector.connect(refuseSecrets);
```

A host that omits `persistState` gets a connector that fails closed the
moment a refresh is needed (§4.6) — never a silently broken session.
Sign-in itself is `enrollConnection(db, store, connector, io)` with
`createXConnector({ state: null })`, unchanged core API.

## 6. Registration and public surface

`packages/connectors/src/registry.ts`: import
`X_ARCHIVE_IMPORT_CONNECTOR_ID, createXArchiveImportConnector, X_CONNECTOR_ID, createXConnector`
and their config types from `@kizuki/connector-x`; add both to `REGISTRY`
and two `getConnector` overloads. `packages/connectors/package.json` adds
the workspace dependency; `bun install` refreshes `bun.lock` (commit it).
`packages/connectors/src/index.ts` is unchanged (consumers import X
symbols from `@kizuki/connector-x`).

`packages/connector-x/src/index.ts` exports exactly: `X_CONNECTOR_ID`,
`X_ARCHIVE_IMPORT_CONNECTOR_ID`, `XConnectorError`, `XArchiveImportConnector`,
`createXArchiveImportConnector`, `parseXArchive`, `openArchive`,
`memoryArchive`, `XConnector`, `createXConnector`, `createFetchXApi`,
`encodeState`, `decodeState`, `encodeCursor`, `decodeCursor`,
`initialCursor`, `X_FIXTURE_ARCHIVE`, `X_FIXTURE_STATE`, `createFixtureXApi`,
`X_CLIENT_ID_MISSING`, `X_REDIRECT_URI`, `X_REQUIRED_SCOPES`,
`DEFAULT_LIMITS`, and the types `XArchiveImportConfig`, `XConnectorConfig`,
`XConnectionState`, `XCursor`, `XLimits`, `XApi`, `XApiRequest`,
`XApiResponse`, `OAuthSeam`, `ArchiveReader`, `XErrorCode`.

`packages/connectors/test/conformance.test.ts` ("all registry connectors
pass conformance") gains both: the archive connector over a temp folder
written from `X_FIXTURE_ARCHIVE`, and
`getConnector(X_CONNECTOR_ID, { state: X_FIXTURE_STATE, api: createFixtureXApi() })`.
The `expect(results).toEqual([...])` list grows by two `{ pass: true, failures: [] }`.

## 7. Network allowlist

`scripts/verify-network.ts` on main scans all of `packages/**` and has no
allowlist, so `packages/connector-x/src/live/client.ts` (one `fetch`) fails
the gate as the tree stands. Lane **oauth-signin** introduces the
allowlist mechanism (its own `auth/oauth.ts` needs `fetch` and `Bun.serve`;
the ci-hardening spec names `scripts/network-allowlist.txt` with
`path:reason` lines). This lane adds exactly one line to that file:
`packages/connector-x/src/live/client.ts:user-configured connector (invariant 6 exception)`.
If the mechanism has not landed when this lane starts, the lane is blocked
on it — do not edit the scanner's logic here and do not wrap `fetch` to
evade it.

## 8. README (`packages/connector-x/README.md`)

Sections, in order: what the two connectors are (import vs live, one
sentence each); the §0 packet with the check date; owner steps (`kizuki
import import-x-archive --source <zip|folder>` once the CLI import verb
exists on the branch; `kizuki connect x` once the CLI sign-in lane lands —
state which of the two is wired on the branch you are on, honestly); the
one-time project step (register a native/public client, redirect URI
`http://127.0.0.1:18477/callback`, build with `KIZUKI_X_CLIENT_ID`); event
shapes (the §2 table); limits (no tombstones, no DMs live, no media
downloads, zip64 refused, overlap between the two paths, like/bookmark
times are post times, request budget defaults); the smoke test
(`KIZUKI_X_SMOKE=1 bun test packages/connector-x/test/smoke.test.ts`,
skipped by default, needs a signed-in state file path in `KIZUKI_X_STATE`).
No product, vendor or person names beyond "X"; the file is under the
`bash scripts/verify.sh` identifier gates.

## Non-goals

- Any write scope or write endpoint (`tweet.write`, `like.write`,
  `bookmark.write`, `dm.write`): never, in any lane.
- Live direct messages (`dm.read`, `/2/dm_events`); `following`/`followers`;
  lists, spaces, communities; long-form `note-tweet.js` from the archive;
  `data/profile.js`, `data/follower.js` and the other archive files.
- Media downloads or blob storage (refs only). Tombstones (`tombstones: false`).
- zip64 archives, multi-zip discovery, encrypted zips (all refused or
  documented; folder mode is the universal path).
- Cross-connector identity (archive `post:<id>` vs live `post:<id>` is the
  same grammar; unification is a later layer's job).
- CLI verbs and the sign-in wiring in the CLI (`connect x`): the CLI
  sign-in lane, on the §5.2 contract. Daemon scheduling.
- Any dependency: none added. No change to `docs/architecture.md`.

## Tests

`packages/connector-x/test/` (synthetic fixtures only; temp dirs via
`mkdtempSync`, cleaned in `afterEach`; no network anywhere — a fake `XApi`
records every request):

- `ids.test.ts`: `snowflakeTime` for a 2018 id, `null` for a pre-snowflake
  id and for non-numeric input; `parseArchiveDate` happy path, a `-0700`
  offset, garbage → null; `userSubjectId` refuses a non-numeric id;
  record-id grammar for all five shapes.
- `archive-ytd.test.ts`: `parseYtd` strips `part0` and `part12` prefixes
  and a BOM; refuses a missing prefix, a non-array, malformed JSON (the
  error never contains the source text); `parseTharManifest` returns
  files per data type and `userInfo`; oversized input refused.
- `archive-zip.test.ts` (zips built in-test with `deflateRawSync` and a
  local `buildZip(files, { method })` helper in `test/helpers.ts`): STORE
  and DEFLATE entries read back byte-exact; `list("data/tweets_media/")`
  sorted; wrong CRC → `parse_error`; declared/actual size mismatch →
  `parse_error`; encrypted flag → `parse_error`; a zip64 locator and a
  `0xFFFFFFFF` size → the exact zip64 message; `../`, absolute and
  backslash names are invisible to `list` and unreadable; duplicate name
  → `parse_error`; bomb ratio → `parse_error`; a non-zip file → "not a zip
  archive"; `MAX_ENTRY_BYTES` refusal by declared size (no allocation).
- `archive-parse.test.ts`: the fixture parses to exactly 12 events, sorted
  by `(occurred_at, source_record_id)`; every event passes
  `validateEventInput`; per-kind subjects, hints and metadata keys match
  §2; the reply carries `to` grace; the retweet text is verbatim; the media
  post carries one attachment with `byte_size` from the listing; likes:
  snowflake basis, pre-snowflake → `archive_generated_at`, missing
  `fullText` → `""`; group DM emits only `messageCreate`; the account
  email string appears in no event (JSON.stringify of the whole batch);
  missing `account.js` and no manifest → the exact message; a record
  without an id is skipped; legacy `data/tweet.js` fallback is located;
  split `tweets-part1.js` is read after `tweets.js`.
- `archive-connector.test.ts`: `runConformance` passes in folder mode and
  in zip mode; the two modes yield identical event batches; second
  backfill → all duplicates through `InMemoryLedger`; `health()` is
  `misconfigured` for a missing path and `ok` for both modes; a symlinked
  `tweets.js` in folder mode → the exact symlink refusal; `manifest()` is
  honest (`tombstones: false`, `purge: false`, `auth_modes: ["none"]`, no
  `signIn`).
- `live-state.test.ts`: encode/decode round trip with sorted keys; refuses
  unknown keys, a missing `refresh_token`, a bad `expires_at`, another
  schema, invalid UTF-8; the encoded size is under `MAX_CONNECTION_STATE_BYTES`.
- `live-cursor.test.ts`: `initialCursor` shape; round trip; refuses
  malformed JSON, a foreign schema, a missing stream; a cursor never
  contains the sentinel token strings after a full fixture run.
- `live-streams.test.ts` (fake API, fixed clock): own-post backfill walks
  two pages newest→oldest, records `pending_newest_id` on page one and
  promotes it on completion with `phase: "sync"`; sync sends `since_id`
  and advances `newest_id` to the max id seen; a walk cut by
  `max_pages_per_stream: 1` keeps `page` and does not advance `newest_id`;
  bookmarks/likes head rule (stop on the page containing `head_id`, items
  after it not emitted; head not found → continue next run); a page
  with `x-rate-limit-remaining: 0` pauses that stream from the reset header
  and the next stream still runs; `429` pauses with `page` kept; a `429`
  `UsageCapExceeded` pauses globally for 24h and ends the run; all four
  paused → `rate_limited` thrown with the earliest `retry_at`;
  `cursor.paused_until` in the future → thrown before any request;
  `400` naming `pagination_token` restarts the walk; other `4xx` →
  `provider_error` with status only; `5xx` → `unreachable` thrown and no
  cursor returned; the request budget counts every request and stops the
  run with a resumable cursor; `note_tweet.text` preferred; protected
  mention author → `personal`; media expansions → attachment refs;
  every emitted event passes `validateEventInput`; the exact query
  strings of §4.6 are sent.
- `live-refresh.test.ts`: expired `expires_at` → refresh before the first
  request, `persistState` awaited with bytes that decode to the new tokens
  BEFORE the next request is made (order asserted through the fake's
  call log); `401` → one refresh + persist + retry; second `401` →
  `unauthenticated`; refresh failure → `unauthenticated`; no
  `persistState` → the exact `misconfigured` message and zero further
  requests; at most one refresh per run.
- `live-connector.test.ts`: manifest honesty; `runConformance` passes with
  `X_FIXTURE_STATE` + fixture API and `fixture()` returns 11 events;
  `connect` with `state: null` → exact message; `signIn` with the
  placeholder client id → `X_CLIENT_ID_MISSING`, `io` never called, `state`
  never written; `signIn` happy path through a fake `OAuthSeam` → `users/me`
  called once, `state.write` called once with decodable bytes, display
  `@ada`; a consent missing `bookmark.read` → the scopes message and no
  write; `health()` matrix: `misconfigured` (placeholder), `disabled`
  (null state), `unauthenticated` (garbage state; 401 twice), `ok` with
  `last_success_at`, id mismatch → `misconfigured`, `429` → `rate_limited`
  with `retry after`, thrown fetch error → `unreachable`; `revoke` posts to
  `/2/oauth2/revoke` with the refresh token and swallows a failure;
  `purgeSource` returns the empty plan.
- `redaction.test.ts`: with sentinel tokens
  (`SENTINEL-ACCESS-…`, `SENTINEL-REFRESH-…`) in the state, none of: the
  manifest, `health().detail`, any thrown message across the matrix above,
  any event (`JSON.stringify`), any encoded cursor, contains a sentinel.
- `client.test.ts`: `createFetchXApi` builds `<base_url><path>?<query>`
  with a Bearer header and a form body for POST, lower-cases headers and
  keeps only the allowed names, returns `body: null` for non-JSON, maps a
  thrown fetch/timeout to `unreachable` without the query string in the
  message (drive it by injecting a fake global `fetch` via
  `globalThis.fetch = …` restored in `afterEach`; no sockets).
- `no-cycle.test.ts`: scans `src/**/*.ts` and asserts no import of
  `@kizuki/connectors`, and that the string `fetch(` occurs only in
  `src/live/client.ts`.
- `smoke.test.ts`: `test.skipIf(!process.env.KIZUKI_X_SMOKE)` — the real
  client against the real API with a state file named by `KIZUKI_X_STATE`;
  asserts `health()` is `ok` and one `sync` returns a cursor. Documented
  in the README; never runs in CI.

`packages/core/test/connections.test.ts` (extend): `rotate` replaces the
bytes atomically (read back equals the new bytes), keeps `source_key`,
bumps `connected_at`; refuses a connection whose row differs from the
persisted one, a disconnected row, a row without state, and bytes over
`MAX_CONNECTION_STATE_BYTES`; a failure injected between journal and
rename leaves the previous bytes readable after `recover(db)`; `replace`
still behaves exactly as its existing tests assert.

`packages/connectors/test/conformance.test.ts` (extend): both X connectors
in the registry battery; `registry.test.ts` unchanged.

## Acceptance

```
bun install                                                   # bun.lock gains @kizuki/connector-x (workspace); commit it
bun run typecheck                                             # exit 0
bun test                                                      # green; ≥ 90 new tests across packages/connector-x/test, packages/core/test/connections.test.ts, packages/connectors/test/conformance.test.ts
bun test packages/connectors/test/conformance.test.ts         # "all registry connectors pass conformance" covers 5 connectors, all { pass: true, failures: [] }
bun test packages/connector-x/test/no-cycle.test.ts           # passes: no @kizuki/connectors import in src; fetch( only in src/live/client.ts
grep -rn '"@kizuki/connectors"' packages/connector-x/src      # no output
grep -rln 'fetch(' packages/connector-x/src                   # exactly: packages/connector-x/src/live/client.ts
grep -c . scripts/network-allowlist.txt && grep -n 'packages/connector-x/src/live/client.ts' scripts/network-allowlist.txt   # one allowlist line for the client (mechanism from lane oauth-signin)
bun run scripts/verify-network.ts                             # "network source verification passed" (with the allowlist mechanism in place)
T=$(mktemp -d) && cd packages/connector-x && bun -e 'import { X_FIXTURE_ARCHIVE } from "./src"; import { mkdirSync, writeFileSync } from "node:fs"; import { dirname, join } from "node:path"; for (const [n, b] of Object.entries(X_FIXTURE_ARCHIVE)) { mkdirSync(dirname(join(process.argv[1], n)), { recursive: true }); writeFileSync(join(process.argv[1], n), b); }' "$T" && cd -
cd packages/connector-x && bun -e 'import { createXArchiveImportConnector } from "./src"; const c = createXArchiveImportConnector({ path: process.argv[1] }); const h = await c.health(); const b = await c.backfill(null); console.log(h.state, b.events.length, b.cursor)' "$T"; cd -   # ok 12 null
cd packages/connector-x && bun -e 'import { createXConnector, X_FIXTURE_STATE, createFixtureXApi } from "./src"; const c = createXConnector({ state: X_FIXTURE_STATE, api: createFixtureXApi() }); await c.connect(async (r) => { throw new Error(r); }); const b = await c.backfill(null); console.log((await c.health()).state, b.events.length, b.cursor === null)' ; cd -   # ok 11 false
cd packages/connector-x && bun -e 'import { createXConnector } from "./src"; const c = createXConnector({ state: null }); await c.connect(async (r) => { throw new Error(r); }).catch((e) => console.log(e.code, e.message))'; cd -   # unauthenticated kizuki.x: not signed in; run: kizuki connect x
cd packages/connector-x && KIZUKI_X_CLIENT_ID= bun -e 'import { createXConnector } from "./src"; const io = { prompt: async () => "", notify: () => {}, openUrl: async () => {} }; await createXConnector({ state: null }).signIn(io, { write: async () => { throw new Error("must not write"); } }).catch((e) => console.log(e.code))'; cd -   # misconfigured
bash scripts/verify.sh                                        # exit 0: typecheck, tests, policy tests, network scan, identifier denylist over tracked text and reachable commit messages
git status --porcelain                                        # empty
```
