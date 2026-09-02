# Lane: connector-imap-ics — read-only IMAP mailbox sync and ICS calendar import, zero runtime dependencies

Packages: NEW `packages/connector-imap` (`@kizuki/connector-imap`, id
`kizuki.imap`) and NEW `packages/connector-ics` (`@kizuki/connector-ics`, id
`kizuki.ics`). Touched: `packages/connectors` (registry, conformance test,
`package.json`), `packages/core` (one small move: `KizukiError`, §2.1),
`scripts/verify-network.ts` + NEW `scripts/network-allowlist.txt` (§2.2),
root `README.md` (one sentence, §2.4). Nothing else.

Read first: CONVENTIONS.md; `docs/architecture.md` (invariants 6, 7, 8, 10;
"Sign-in, not setup"); `rfcs/0000-constraints.md`;
`packages/core/src/contracts/connector.ts` (`Connector`, `SignInIo`,
`ConnectionStateWriter`, `SecretResolver`, `SyncBatch`, `HealthReport`);
`packages/core/src/contracts/event.ts`; `packages/core/src/ledger/
connection-state.ts` and `connections.ts` (what the host persists for a
sign-in connector: a core-minted ULID `source_key`, a fixed config literal,
and one `file:connections/<ulid>.state` ref — nothing else can be stored in
SQLite, the CHECK constraints refuse it); `packages/core/src/ingest/run.ts`;
`packages/connectors/src/{conformance,registry,markdown-folder/index,
ledger,util,errors}.ts` and `packages/connectors/test/conformance.test.ts`
(the shape every connector and its tests follow); `scripts/verify-network.ts`
and its test; `.agents/skills/connector-work/SKILL.md`,
`dependency-evaluation/SKILL.md`, `security-privacy-review/SKILL.md`.
Design references: workspace plan ARCHITECTURE.md §3.1 (protocol; "IMAP =
standard", "Calendar = ICS + Google API"; decision 16 sign-in), §3.2
(conformance), §2.2 (tombstones, purge), §10 (secrets), §12 (zero-network
test, conformance per connector).

## Objective

Ship the two "standards" connectors of the 1.0 set: an IMAP-over-TLS
mailbox reader that signs in with an app password and syncs INBOX plus
owner-chosen folders with UID checkpoints and expunge tombstones, and an ICS
calendar importer that reads a file or, only when the owner configures one,
an HTTPS calendar URL. Both pass the shared conformance suite with no
network, add no runtime dependency, and keep every credential inside the
host-owned opaque state file.

## 0. Ground truth on main (`76930db`, Bun 1.3.14, probed 2026-09-02)

These facts drive the design; do not rediscover them.

- `bun test` baseline: 515 tests across 41 files, all green.
- `Bun.connect({ tls })` does NOT abort a failed certificate verification.
  With `rejectUnauthorized: true` and no matching `ca`, the `handshake(socket,
success, authorizationError)` callback fires with `success === true`,
  `socket.authorized === true`, and `authorizationError.code ===
"DEPTH_ZERO_SELF_SIGNED_CERT"`; data flows afterwards. A `serverName` that
  does not match the certificate's SAN is not detected at all
  (`authorizationError` null). The socket exposes `getPeerCertificate()` with
  `subject.CN` and `subjectaltname` ("DNS:localhost, IP Address:127.0.0.1").
  Consequence: the transport (§3.3) must treat a non-null `authorizationError`
  as fatal before any byte is sent, and must verify the hostname itself.
- `scripts/verify-network.ts` flags `Bun.connect`, `Bun.serve`, `fetch`,
  `node:tls`, `node:net`, etc. in every tracked `packages/**/*.ts` file,
  tests included, and has no allowlist. `bun run verify` runs it. §2.2 adds
  the allowlist; nothing on main provides one (`git grep allowlist` finds
  only unrelated hits).
- `connections.config` accepts exactly two JSON literals and `secret_refs`
  exactly `[]` or `["file:connections/<source_key>.state"]`. Host, port,
  username, password, folder list, calendar URL: all of it lives in the
  opaque state bytes the connector writes through `ConnectionStateWriter`
  during `signIn`, and comes back through the `SecretResolver` at `connect`.
- `runBackfill` runs ONE `connector.backfill(cursor)` batch per invocation
  and saves `result.cursor`; `runSync` passes the saved cursor to
  `connector.sync`. The in-tree precedent (`markdown-folder`) never returns a
  null cursor: the cursor is a snapshot, and `sync` diffs against it. Follow
  that precedent (§3.7); a null cursor would make `sync(null)` forget the
  walk.
- `TextDecoder` on this Bun supports utf-8, utf-16le/be, windows-1252
  (latin1/iso-8859-1/us-ascii alias to it), shift_jis, euc-jp, iso-2022-jp,
  gbk/gb2312, big5, euc-kr, ibm866; it throws `RangeError` for iso-8859-2,
  iso-8859-15, windows-1251, koi8-r, macintosh. `Intl.DateTimeFormat` with
  `timeZoneName: "longOffset"` yields `GMT+02:00`/`GMT` and accepts IANA ids
  (`Europe/Berlin`, `UTC`, `Etc/GMT+5`); Windows zone names throw
  `RangeError`. `Intl.supportedValuesOf("timeZone")` omits `Etc/UTC`, so
  validate a TZID by constructing a formatter, not by that list.

## 1. Dependency decision: zero

Evaluated per `.agents/skills/dependency-evaluation/SKILL.md` on
2026-09-02 (`npm view <pkg> version license dependencies`):

| candidate     | version / license         | verdict                                                                                                                                                                                                                                                                |
| ------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `imapflow`    | 1.7.8 / MIT               | rejected: pulls `pino` (logger), `socks` (proxy client), `nodemailer`, `iconv-lite`, `encoding-japanese`, `libmime`, `libqp`, `libbase64`, `@zone-eu/mailsplit`; a logger and a proxy client in the zero-phone-home tree are audit surface for nothing this lane needs |
| `postal-mime` | 3.0.0 / MIT-0, no deps    | evaluated as a MIME parser; rejected to hold the workspace at zero runtime dependencies — the subset needed (§3.8) is bounded and fixture-tested                                                                                                                       |
| `ical.js`     | 2.2.1 / MPL-2.0           | rejected: MPL in an MIT tree, and the parser subset needed (§4.4-4.6) is smaller than the library                                                                                                                                                                      |
| `rrule`       | 2.8.1 / BSD-3 (+ `tslib`) | rejected: same reason; the supported RRULE subset is explicit (§4.6)                                                                                                                                                                                                   |

Decision: a minimal IMAP4rev1 client over `Bun.connect` TLS sockets and a
hand-written ICS parser. Both packages declare only
`"@kizuki/core": "workspace:*"`. `@kizuki/core` stays dependency-free.
Verify with `bun install --frozen-lockfile` after committing the lockfile.

## 2. Shared plumbing

### 2.1 `KizukiError` moves to core (tiny, coordinated)

The two new packages cannot import `@kizuki/connectors` (the registry there
imports them; that is a workspace cycle). Connectors must still throw the
one error type the conformance suite recognises. Move it:

- NEW `packages/core/src/contracts/errors.ts`:

```ts
export type KizukiErrorCode =
  | "unknown_connector"
  | "parse_error"
  | "missing_secret"
  | "misconfigured"
  | "unauthenticated"
  | "unreachable"
  | "rate_limited"
  | "protocol"; // last four NEW
export class KizukiError extends Error {
  readonly code: KizukiErrorCode;
  constructor(code: KizukiErrorCode, message: string, options?: ErrorOptions);
}
```

- `packages/connectors/src/errors.ts` becomes
  `export { KizukiError } from "@kizuki/core"; export type { KizukiErrorCode } from "@kizuki/core";`
  (public surface of `@kizuki/connectors` unchanged).
- `packages/core/src/index.ts` exports both; `packages/core/test/index.test.ts`
  adds `"KizukiError"` to the sorted key list. No other core change.
- If a sibling lane already landed this move, reuse it and add only the
  missing codes.

### 2.2 Network gate allowlist (NEW `scripts/network-allowlist.txt`)

Invariant 6 allows exactly "user-configured connectors". Extend
`scripts/verify-network.ts` (keep `scanSourceText` untouched):

```ts
export interface AllowlistEntry {
  file: string;
  reason: string;
}
export function parseAllowlist(text: string): AllowlistEntry[];
// one `path:reason` per line; `#` comments and blank lines ignored; path is repo-relative;
// a line without `:` or with an empty reason throws
export function applyAllowlist(
  findings: NetworkFinding[],
  entries: AllowlistEntry[],
  trackedFiles: string[],
): {
  blocked: NetworkFinding[];
  allowed: (NetworkFinding & { reason: string })[];
  errors: string[];
};
// errors: an entry whose file is not tracked ("stale allowlist entry"), or an entry whose file
// produced zero findings ("allowlist entry without a network call") — both fail the run
```

`main()` reads `scripts/network-allowlist.txt` when it exists, prints one
`allowed: <file>:<line>:<column>: <finding reason> (<allowlist reason>)`
line per allowed finding to stderr, fails on any `blocked` finding or any
`errors` entry, and prints `network source verification passed (N allowed)`
on success. Initial file content:

```
# path:reason — every line is an invariant-6 exception: an owner-configured connector's transport.
packages/connector-imap/src/transport.ts:owner-configured IMAP connector; TLS socket to the owner's mail server
packages/connector-ics/src/fetch.ts:owner-configured ICS URL connector; HTTPS GET of the owner's calendar URL
```

Tests (`scripts/verify-network.test.ts`): `parseAllowlist` accepts
comments/blank lines and rejects a reasonless line; `applyAllowlist` moves a
finding in an allowlisted file to `allowed`, keeps others `blocked`, reports a
stale entry and an entry without findings as errors. If a sibling lane
already added an allowlist mechanism, use it and add the two lines above.

### 2.3 Registry and manifests

- `packages/connectors/package.json` gains `"@kizuki/connector-imap":
"workspace:*"` and `"@kizuki/connector-ics": "workspace:*"`.
- `packages/connectors/src/registry.ts`: `REGISTRY` gains
  `[IMAP_CONNECTOR_ID]: createImapConnector` and
  `[ICS_CONNECTOR_ID]: createIcsConnector`; `getConnector` gains the two
  overloads (`ImapConnectorConfig`, `IcsConnectorConfig`). Registry entries
  are added LAST, after conformance passes (connector-work skill step 7).
- `packages/connectors/src/index.ts` re-exports the two ids, factories, and
  config types.
- Each new package: `package.json` `{ "name", "type": "module", "module":
"src/index.ts", "exports": { ".": "./src/index.ts", "./testing":
"./src/testing/index.ts" }, "dependencies": { "@kizuki/core": "workspace:*" } }`.
  `src/testing/` holds the in-memory fakes (§3.10, §4.9) — the same
  precedent as `InMemoryLedger` living in `packages/connectors/src/ledger.ts`.
- Each package ships `README.md`: what it syncs, the sign-in walk-through,
  state on disk, dated provider limitations (check current provider
  documentation for app-password availability and record the date; several
  large providers now require OAuth for IMAP and are therefore unsupported
  by this connector — say so), and the manual smoke (§6). Claim nothing
  that does not run.

### 2.4 README sentence

Root `README.md`, "Zero phone-home" pledge: replace "Today there are zero
runtime dependencies and zero network calls anywhere in the tree; CI greps
both the dependency manifests and the source for network surface." with
"Today there are zero runtime dependencies. The only network code in the
tree is the per-connector transport listed in `scripts/network-allowlist.txt`,
one line per file naming the owner-configured connector it serves; CI fails
on any network call outside that list." (If a sibling lane already rewrote
the sentence, keep theirs if it says the same thing.)

## 3. `packages/connector-imap`

Layout (each file < 400 lines): `src/index.ts`, `src/connector.ts`,
`src/state.ts`, `src/cursor.ts`, `src/uidset.ts`, `src/transport.ts`,
`src/imap/tokenizer.ts`, `src/imap/client.ts`, `src/imap/session.ts`,
`src/imap/codes.ts`, `src/imap/utf7.ts`, `src/mime/headers.ts`,
`src/mime/rfc2047.ts`, `src/mime/transfer.ts`, `src/mime/parse.ts`,
`src/mime/html.ts`, `src/mailbox.ts`, `src/events.ts`, `src/sign-in.ts`,
`src/fixture.ts`, `src/testing/index.ts`, `src/testing/fake-imap.ts`,
`src/testing/memory-dialer.ts`.

### 3.1 Manifest

```ts
export const IMAP_CONNECTOR_ID = "kizuki.imap" as const;
// manifest(): { schema: "kizuki.connector/v1", connector_id: "kizuki.imap", version: "0.1.0",
//   kinds: ["email"], capabilities: { backfill: true, sync: true, tombstones: true, purge: true, fixture: true },
//   required_secrets: [], emits_sensitivity_hint: true, auth_modes: ["sign_in"] }
```

`required_secrets` is empty because sign-in mints the state; `connect`
still fails closed without it (§3.6).

### 3.2 Config, state, cursor

```ts
export interface ImapConnectorConfig {
  secret_ref?: string;
} // the host passes connection.secret_refs[0] after enrollment
export interface ImapConnectorDeps {
  dial?: ImapDialer;
  now?: () => Date;
} // tests inject; production uses dialTls + Date
export function createImapConnector(
  config: ImapConnectorConfig,
  deps?: ImapConnectorDeps,
): ImapConnector;

export interface ImapState {
  // src/state.ts — the opaque bytes behind file:connections/<ulid>.state
  schema: "kizuki.imap-state/v1";
  host: string; // DNS name or IP literal; also the SNI name and the hostname-verification target
  port: number; // integer 1..65535; sign-in default 993
  username: string;
  password: string; // the app password; exists only here (0600) and in memory
  folders: string[]; // wire-form mailbox names, non-empty, unique, INBOX first
  max_message_bytes: number; // default 2_097_152; larger messages are captured header-only
}
export function parseImapState(text: string): ImapState; // KizukiError("misconfigured") on wrong schema, unknown key, wrong type, empty string, port out of range; the message never echoes field values
export function serializeImapState(state: ImapState): Uint8Array;

export interface ImapFolderCursor {
  // src/cursor.ts
  uidvalidity: number;
  scan_from: number; // next UID window start; 1 at the beginning
  uidnext: number; // UIDNEXT seen at the last EXAMINE
  known: string; // IMAP sequence-set of UIDs already emitted ("1:340,342:900"; "" = none)
  done: boolean; // scan_from >= uidnext at the last step
}
export interface ImapCursor {
  schema: "kizuki.imap-cursor/v1";
  folders: Record<string, ImapFolderCursor>;
}
export function encodeCursor(cursor: ImapCursor): Cursor;
export function decodeCursor(raw: Cursor): ImapCursor; // KizukiError("parse_error") on any deviation
// src/uidset.ts — pure: parse/format sequence sets, add/remove, iterate, chunk(set, 500)
```

### 3.3 Transport (`src/transport.ts`) — the only `Bun.connect` in the package

```ts
export interface ImapConn {
  send(bytes: Uint8Array): Promise<void>;
  receive(): Promise<Uint8Array | null>; // next chunk; null at EOF
  close(): void;
}
export interface DialOptions {
  timeoutMs: number;
  ca?: string;
} // `ca` exists for loopback tests only; no owner-facing path sets it (parseImapState refuses unknown keys)
export type ImapDialer = (
  host: string,
  port: number,
  opts: DialOptions,
) => Promise<ImapConn>;
export const dialTls: ImapDialer;
export function hostnameMatches(
  host: string,
  cert: { subjectaltname?: string; subject?: { CN?: string } },
): boolean;
```

`dialTls` calls `Bun.connect({ hostname: host, port, tls: { serverName: host,
rejectUnauthorized: true, ...(ca ? { ca } : {}) }, socket })` and resolves
only from the `handshake(socket, _success, authorizationError)` callback,
in this order: (1) `authorizationError` not null/undefined → `socket.end()`,
reject `KizukiError("unreachable", "tls: <code or message>")`; (2)
`hostnameMatches(host, socket.getPeerCertificate())` false → `end()`, reject
`KizukiError("unreachable", "tls: certificate does not match host")`; (3)
resolve. Bytes received before the gate resolves (the IMAP greeting arrives
immediately) are buffered, never dropped. `success` is ignored; `authorized`
is ignored (both were `true` for an untrusted cert in the probe).
`rejectUnauthorized: false` never appears in the tree; there is no insecure
switch — a server whose certificate the system trust store does not accept
is unsupported, and the README says so. Connect + handshake timeout =
`opts.timeoutMs` (15 000 in production); reject `KizukiError("unreachable",
"connect timed out")`. `connectError`/`error` → `unreachable` with the code,
never the host's password (it has not been sent yet).

`hostnameMatches`: RFC 6125 subset — DNS-ID SANs compared case-insensitively;
a wildcard only as the entire leftmost label and only against one label
(`*.example.org` matches `mail.example.org`, not `example.org`, not
`a.b.example.org`); an IP-literal host matches only an `IP Address:` SAN;
`subject.CN` is consulted only when the certificate has no SAN at all.

### 3.4 Protocol client (`src/imap/`)

- `tokenizer.ts`: incremental line reader over `ImapConn` chunks with
  `maxLineBytes` (65 536) and literal support: `{n}` / `{n+}` followed by
  exactly n bytes; `n > maxLiteralBytes` (8 388 608) → close the connection,
  `KizukiError("protocol", "literal exceeds bound")`. Parses one response
  into `{ tag: string | "*" | "+", text: string, items: Token[] }` where
  `Token = atom | quoted | literal(bytes) | list(Token[]) | nil`.
- `client.ts` — `ImapClient`: tags `A0001`…; `send(command, args)` writes one
  line (quoted strings escaped `\` and `"`; a value containing CR, LF or
  non-ASCII is sent as a literal after the `+` continuation; a value
  containing NUL is refused with `misconfigured`); collects untagged
  responses until the tagged reply; per-command timeout `commandTimeoutMs`
  (60 000) → close + `unreachable`. Untagged `* BYE` at any time → close +
  `unreachable`. Tagged `NO`/`BAD` → `KizukiError` per `codes.ts`. No
  logging of any kind (no `console.*` in `src/`; a trace would carry the
  password).
- `codes.ts`: response-code mapping (RFC 5530): `AUTHENTICATIONFAILED |
AUTHORIZATIONFAILED | EXPIRED | PRIVACYREQUIRED` → `unauthenticated`;
  `LIMIT | INUSE` → `rate_limited`; `UNAVAILABLE` → `unreachable`; a `NO`
  to LOGIN without a code → `unauthenticated`; anything else → `protocol`.
  The error message carries the server's human text sanitised (control
  characters stripped, ≤ 200 chars) and never the command that failed.
- `session.ts` — `ImapSession` over a client: `static open(dial, state,
opts)` (greeting `* OK`/`* PREAUTH`; `* BYE` → unreachable; then
  `CAPABILITY`, then `LOGIN` unless PREAUTH), `list()` (`LIST "" "*"` →
  `{ wire: string; display: string; delimiter: string | null; attributes:
string[] }[]`, `\Noselect` entries excluded, `display` decoded from
  modified-UTF-7 by `utf7.ts`), `examine(folder)` (`EXAMINE` — read-only
  select, never `SELECT` — returns `{ uidvalidity, uidnext, exists }`;
  missing UIDVALIDITY or UIDNEXT → `protocol`), `fetchSummaries(set)` (`UID
FETCH <set> (UID INTERNALDATE RFC822.SIZE)` → `{ uid, internaldate, size
}[]` sorted by uid), `fetchBodies(uids ≤ 20, section: "" | "HEADER")`
  (`UID FETCH <set> (BODY.PEEK[<section>])` → `Map<uid, Uint8Array>`;
  `BODY.PEEK`, never `BODY`, so `\Seen` is never set), `search(criteria)`
  (`UID SEARCH …` → `number[]`, only used by `purgeSource`), `logout()`.
  Exactly these commands; no STORE, no EXPUNGE, no APPEND, no SELECT, no
  IDLE, no STARTTLS, no AUTHENTICATE (§5).

### 3.5 Sign-in (`src/sign-in.ts`)

```ts
export async function signInImap(
  io: SignInIo,
  state: ConnectionStateWriter,
  deps: Required<ImapConnectorDeps>,
): Promise<SignInDisplay>;
```

Prompts, in order (exact strings): `IMAP server host: `; `IMAP port [993]: `;
`Username (usually your email address): `; `App password: ` with
`{ secret: true }`. Validation before any network call: host non-empty,
no whitespace, no `/`, ≤ 253 chars; port integer 1..65535. Then
`ImapSession.open` (TLS gate, greeting, LOGIN) — failures surface as the
`KizukiError` from §3.3/§3.4 (e.g. `unauthenticated: … Invalid
credentials`), never echoing the password. Then `list()`;
`io.notify("Folders on the server: " + display names joined by ", ")`
(≤ 40 names, then `, +N more`); prompt `Folders to sync [INBOX]: ` — a
comma-separated list of display names, empty = `INBOX`; each name must
match a listed folder (INBOX case-insensitively per RFC 3501, others
exactly); unknown names → `KizukiError("misconfigured", "unknown folders:
a, b")` and the sign-in fails (no partial state). Map display names back to
wire names, put INBOX first, `EXAMINE` each once (a `\Noselect` or
unreadable folder fails the sign-in), `logout()`, then
`state.write(serializeImapState({...}))` exactly once, return
`{ display: username }`. A second sign-in on an existing connection goes
through `ConnectionStateStore.replace` unchanged: this is also how the
owner changes the folder list.

### 3.6 `connect`, `health`, `revoke`

- `connect(resolve)`: `config.secret_ref` missing or not a `file:` ref →
  `KizukiError("missing_secret", "kizuki.imap: sign in first (kizuki connect
imap)")`; `resolve(ref)` rejection → rethrown as `missing_secret`; the
  resolved string → `parseImapState`; then a live `ImapSession.open` +
  `logout()` ("validates for real"). Success keeps the state in memory
  only; every later operation opens its own session. `connect` never
  prompts.
- `health()`: before `connect` → `disabled` ("not connected"); otherwise a
  live `open` → `examine` each folder → `logout`, mapped: all fine → `ok`;
  a folder missing from the server → `misconfigured` ("folder not found:
  <display name>"); `KizukiError` codes map 1:1 to `unauthenticated |
rate_limited | unreachable`; `protocol` → `degraded`. `detail` carries the
  sanitised server text only. `last_success_at` = the end of the last
  successful backfill/sync in this process, when there was one.
- `revoke()`: no remote credential to revoke (an app password is revoked at
  the provider by the owner); drops in-memory state; documented in the
  README. Deleting the state file is the host's job on `disconnect`.

### 3.7 Mailbox walk (`src/mailbox.ts`): backfill pages, sync, expunge, UIDVALIDITY

One algorithm, two entry points. Bounds: `WINDOW = 1000` UIDs per summary
fetch, `BATCH = 200` events per `SyncBatch`, `EXPUNGE_CHUNK = 500` UIDs per
existence check.

- `backfill(cursor)`: `cursor === null` → fresh `ImapCursor` with no
  folders; else `decodeCursor`. Open one session. For each folder of
  `state.folders` in order: `examine` → if the folder is new in the cursor,
  initialise `{ uidvalidity, scan_from: 1, uidnext, known: "", done: false }`;
  if `uidvalidity` differs from the stored one, run the reset (below); set
  `uidnext` to the fresh value and `done = scan_from >= uidnext`. While not
  done and the batch has room: `fetchSummaries("<scan_from>:<min(scan_from

* WINDOW − 1, uidnext − 1)>")`(a`n:_`form is never used for scanning;
servers answer`n:_` with the last message when n exceeds it), fetch
bodies in UID order (`""`when`size <= max_message_bytes`, else
`"HEADER"`with`metadata.body_omitted: "size"`), map to events (§3.8),
add each UID to `known`, advance `scan_from`past the window;`done`when`scan_from >= uidnext`. Stop filling when the batch reaches `BATCH`events (the cursor records exactly where to resume — mid-window resume
is by`scan_from`, so a UID is never emitted twice within one walk).
`logout()`. Return `{ events, cursor: encodeCursor(...) }`. The cursor is
NEVER null: a fully walked mailbox returns `{ events: [], cursor }`on
the next call (idempotent), and`backfill(null)`twice yields the same
first page (UID order is deterministic;`observed_at` is outside the
  content hash).

- `sync(cursor)`: `null` → `backfill(null)`. Else open, and per folder:
  `examine` (fresh `uidnext`; UIDVALIDITY reset if changed); if the walk is
  not done (including new mail: `uidnext` grew) → continue the walk exactly
  as above (one page per call); when the walk is done → expunge detection:
  for each `chunk(known, EXPUNGE_CHUNK)` run `fetchSummaries(chunk)`; UIDs
  absent from the reply are gone → emit a tombstone per UID:

  ```ts
  { schema: "kizuki.event/v1", connector_id: "kizuki.imap", source_record_id: recordId(folderWire, uidvalidity, uid),
    kind: "email", occurred_at: observedAt, observed_at: observedAt, text: "", subjects: [], deleted: true,
    attachments: [], metadata: { folder: displayName, uid, uidvalidity } }
  ```

  and remove the UID from `known`. Emission order per batch: tombstones of
  a folder before its new events; folders in configured order.

- UIDVALIDITY reset (the server re-numbered the folder): emit tombstones for
  every UID in `known` under the OLD `uidvalidity` with
  `metadata.uidvalidity_reset: true`, then reinitialise the folder cursor
  with the new `uidvalidity`, `scan_from: 1`, `known: ""`, and continue the
  walk (messages come back under new record ids; that is an honest
  re-observation, not a duplicate — dedupe is by record id + hash). The
  run's health detail reports `uidvalidity changed: <display name>` (state
  `degraded` for that report only).
- A `KizukiError` in the middle of a walk propagates (the runner records
  the error and keeps the previous checkpoint — see `runBackfill`); no
  partial cursor is returned.

### 3.8 Message → event (`src/events.ts`, `src/mime/`)

```ts
export function recordId(
  folderWire: string,
  uidvalidity: number,
  uid: number,
): string; // `${uidvalidity}:${uid}:${folderWire}` — the two numeric fields make the split unambiguous
export function messageEvent(input: {
  folderWire: string;
  folderDisplay: string;
  uidvalidity: number;
  uid: number;
  internaldate: string;
  size: number;
  raw: Uint8Array;
  section: "" | "HEADER";
  observedAt: string;
}): CaptureEventInput;
```

- `kind: "email"`; `sensitivity_hint: "personal"` for every message (the
  same label the Google lane gives Gmail; list mail is still the owner's
  inbox).
- `occurred_at`: the `Date:` header with a trailing `(comment)` stripped,
  via `Date.parse`; `NaN` or absent → INTERNALDATE (`"01-Jan-2026
10:00:00 +0000"`, parsed by a month-name table in `events.ts`); both go
  to metadata.
- `text`: decoded `Subject` (RFC 2047) + `"\n\n"` + body text, where body
  text = the first `text/plain` part (multipart/alternative preferred order:
  plain, then html → `htmlToText`), `""` for header-only captures. Decoded
  text > 262 144 code points → truncated by code points with
  `metadata.text_truncated: true`.
- `subjects`: `From` → role `from`; `To` and `Cc` → role `to`;
  `subject_id = "email:" + address.toLowerCase()`, `display_name` = the
  RFC 2047-decoded phrase (control characters stripped, ≤ 120 chars,
  omitted when empty); address must contain exactly one `@` and no
  whitespace or it is skipped; group syntax and `Reply-To` ignored;
  deduplicated by (subject_id, role); ≤ 200 subjects per message.
- `attachments`: parts with `Content-Disposition: attachment`, or any
  non-`text/*` part carrying a `filename`/`name` parameter: `attachment_id`
  = the MIME section path (`"2"`, `"1.2"`), `media_type` = lowercased type
  (`application/octet-stream` when missing or malformed), `filename` =
  RFC 2231/2047-decoded, control characters and path separators stripped,
  ≤ 255 chars, omitted when empty; `byte_size` = decoded length when the
  body was fetched, omitted for header-only captures. `message/rfc822`
  parts are attachments, never recursed into. Nothing is downloaded or
  stored; refs only.
- `metadata` (persisted verbatim, part of the hash — so it holds only
  stable facts): `{ folder, uid, uidvalidity, message_id, in_reply_to,
references: string[], date_header, internaldate, size, has_html,
list_id?, body_omitted?: "size", text_truncated?: true,
charset_fallback?: string[], header_truncated?: true }`. Each header value
  ≤ 4 096 chars. IMAP flags are NOT captured anywhere: `\Seen` toggles
  would fork ledger rows on every re-observation.
- MIME subset (`src/mime/`): `headers.ts` — unfold CRLF/LF + WSP, ≤ 65 536
  header bytes and ≤ 200 fields (`header_truncated`), names lowercased,
  repeated fields kept in order; `rfc2047.ts` — `=?charset?B|Q?…?=`,
  adjacent encoded words merged without the intervening whitespace,
  underscore = space in Q, malformed words left verbatim; `transfer.ts` —
  `base64`, `quoted-printable` (soft line breaks, `=XX`, trailing WSP),
  `7bit`/`8bit`/`binary` identity; `parse.ts` — `Content-Type` with RFC 2231
  continuations (`filename*0*=`) and `charset`; multipart walk with
  boundary matching, depth ≤ 10, parts ≤ 200; charset decoding through
  `new TextDecoder(label, { fatal: false })`, `RangeError` → windows-1252
  with the label appended to `charset_fallback`; `html.ts` — drop
  `<script>`/`<style>` bodies, `<br>`, `</p>`, `</div>`, `</li>`, `</tr>`,
  `</h1..6>` → newline, strip remaining tags, decode `&amp; &lt; &gt; &quot;
&#39; &apos; &nbsp;` and numeric `&#N;`/`&#xH;`, collapse runs of three or
  more newlines to two, trim. All of it is pure and table-tested (§6).

### 3.9 `purgeSource(subject_id)`

The connector is read-only: it can never remove mail at the source, so
`source_record_ids` is always `[]`. When connected and `subject_id` starts
with `email:`: per configured folder, `examine` then `search(`OR OR FROM
"<addr>" TO "<addr>" CC "<addr>"`)` (address quoted per §3.4; an address
containing CR/LF/NUL/`"`/`\` yields an empty plan instead of a query),
mapping each UID to `recordId(...)` into `unreachable_source_record_ids`
(≤ 10 000 per folder). Not connected, or a non-`email:` subject
(`conformance:subject` included) → both lists empty. The plan never claims
remote deletion; the README says the owner deletes at the provider.

### 3.10 Fixture and fakes

- `fixture()` (`src/fixture.ts`): ≥ 12 synthetic RFC 5322 messages run
  through the REAL `messageEvent` path (so the fixture exercises the
  parser), between `ada@acme.example`, `grace@acme.example`,
  `linus@example.org` and a list `team@acme.example` with `List-Id`:
  plain 7bit; html-only; multipart/alternative; base64 utf-8 body with
  emoji; quoted-printable windows-1252 body; RFC 2047 `Subject` (B and Q,
  two charsets); a reply chain (`In-Reply-To`/`References`); a PDF
  attachment ref; an inline image with `Content-ID`; a message with an
  unsupported charset label; a header-only capture (`body_omitted`); a
  message whose `Date:` is unparsable (INTERNALDATE fallback). Deterministic
  `observed_at` `2026-03-01T00:00:00.000Z`.
- `src/testing/fake-imap.ts` — `FakeImapServer`: scripted in-memory IMAP
  subset (greeting, CAPABILITY, LOGIN with configurable credentials and
  failure codes, LIST with modified-UTF-7 names, EXAMINE, UID FETCH for
  ranges/sets/`*`, UID SEARCH, LOGOUT), a `received: string[]` log of the
  raw lines it got (passwords included — this object lives in tests only,
  never in a fixture file), and mutation hooks: `expunge(folder, uid)`,
  `append(folder, raw)`, `resetUidValidity(folder)`, `delayNext(ms)`,
  `oversizedLiteralNext()`, `byeNext()`. `src/testing/memory-dialer.ts`
  — `memoryDialer(server): ImapDialer` (a duplex over in-memory queues, no
  sockets). `src/testing/index.ts` exports both plus `fixtureState()`
  (`ImapState` for the fake) and `fixtureMailbox()` (the §3.10 messages as
  raw bytes for seeding the server).

### 3.11 Redaction rules (tested)

The password and the username never appear in: `manifest()`, any
`KizukiError.message`, any `HealthReport.detail`, any event field, the
cursor, or thrown TLS/timeout errors. The state bytes never touch SQLite
(the host guarantees that; the test in §6 re-asserts it end to end with
`ConnectionStateStore`).

## 4. `packages/connector-ics`

Layout: `src/index.ts`, `src/connector.ts`, `src/state.ts`,
`src/cursor.ts`, `src/fetch.ts`, `src/unfold.ts`, `src/parse.ts`,
`src/datetime.ts`, `src/rrule.ts`, `src/events.ts`, `src/sign-in.ts`,
`src/fixture.ts`, `src/testing/index.ts`, `src/testing/memory-fetch.ts`.

### 4.1 Manifest

```ts
export const ICS_CONNECTOR_ID = "kizuki.ics" as const;
// manifest(): { schema, connector_id: "kizuki.ics", version: "0.1.0", kinds: ["calendar_event"],
//   capabilities: { backfill: true, sync: true, tombstones: true, purge: false, fixture: true },
//   required_secrets: [], emits_sensitivity_hint: true, auth_modes: ["none", "sign_in"] }
```

`none` = a file the owner points at with `--source` (config `{ path }`,
like `markdown-folder`; nothing is persisted in SQLite for it on main).
`sign_in` = URL mode: the owner types the calendar URL in the terminal and
the host persists it as opaque state — private calendar URLs embed a
capability token, so they are treated as a credential: never in SQLite, a
log line, an error, or `metadata`.

### 4.2 Config, state, cursor

```ts
export type IcsConnectorConfig =
  { path: string } | { secret_ref: string } | Record<string, never>;
export interface IcsConnectorDeps {
  fetch?: IcsFetcher;
  now?: () => Date;
}
export function createIcsConnector(
  config: IcsConnectorConfig,
  deps?: IcsConnectorDeps,
): IcsConnector;
export interface IcsState {
  schema: "kizuki.ics-state/v1";
  url: string;
} // https only (webcal:// normalised at sign-in)
export function parseIcsState(text: string): IcsState; // misconfigured on anything else; message never echoes the URL
export interface IcsCursor {
  schema: "kizuki.ics-cursor/v1";
  records: Record<string, string>; // source_record_id → first 16 hex chars of core computeContentHash(event)
  etag?: string;
  last_modified?: string; // URL mode conditional GET
}
```

### 4.3 Fetch (`src/fetch.ts`) — the only `fetch` in the package

```ts
export interface IcsFetchResult {
  status: number;
  etag: string | null;
  last_modified: string | null;
  text: string;
}
export type IcsFetcher = (
  url: string,
  conditional: { etag?: string; last_modified?: string },
) => Promise<IcsFetchResult>;
export function makeFetcher(fetchImpl: typeof fetch): IcsFetcher;
export const fetchIcs: IcsFetcher; // = makeFetcher(fetch)
```

Policy inside `makeFetcher` (unit-tested with an in-memory `fetchImpl`
returning `Response` objects; no server): `https:` only (else
`misconfigured`); `redirect: "manual"`, follow ≤ 3 redirects, each must be
`https:` (else `misconfigured`); `AbortSignal.timeout(30_000)`; headers
`Accept: text/calendar, text/plain;q=0.5` plus `If-None-Match` /
`If-Modified-Since` when the cursor has them; no cookies, no credentials
mode; the body is read as a stream and aborted past 16 MiB
(`misconfigured`, "calendar exceeds 16 MiB"); `304` → `text: ""`; `401/403`
→ `unauthenticated`; `404/410` → `misconfigured`; `429` → `rate_limited`;
other non-2xx and network errors → `unreachable`. Error messages carry the
status, never the URL.

### 4.4 Parser subset (`src/unfold.ts`, `src/parse.ts`) — pure

Input normalisation: strip a UTF-8 BOM; split on CRLF or LF; unfold lines
continued by a leading space or tab; bounds: 8 MiB of text, 50 000 content
lines, 20 000 components, nesting ≤ 8 (`parse_error` beyond). Content line
grammar `NAME(;PARAM=VALUE(,VALUE)*)*:VALUE` with quoted parameter values,
case-insensitive names and parameter names, RFC 5545 text unescaping
(`\n`, `\N`, `\,`, `\;`, `\\`). Components: `VCALENDAR` (`X-WR-CALNAME`,
`PRODID`, `METHOD`), `VTIMEZONE` (`TZID`, `STANDARD`/`DAYLIGHT` with
`TZOFFSETTO`), `VEVENT` (`UID`, `DTSTART`, `DTEND`, `DURATION`, `SUMMARY`,
`DESCRIPTION`, `LOCATION`, `ORGANIZER`, `ATTENDEE*`, `STATUS`, `CLASS`,
`SEQUENCE`, `CREATED`, `LAST-MODIFIED`, `URL`, `RRULE`, `RDATE*`, `EXDATE*`,
`RECURRENCE-ID`, `ATTACH*`, `X-*` ignored); every other component
(`VTODO`, `VJOURNAL`, `VFREEBUSY`, `VALARM`) is skipped. Output:
`{ calendar: { name: string | null; prodid: string | null }, zones:
Map<string, ZoneInfo>, events: RawVEvent[] }`.

### 4.5 Date-time and TZID (`src/datetime.ts`) — pure

```ts
export type IcsInstant =
  | { kind: "utc"; iso: string }
  | { kind: "date"; date: string } // YYYY-MM-DD (VALUE=DATE)
  | { kind: "floating"; local: string } // YYYYMMDDTHHMMSS, no zone
  | { kind: "zoned"; local: string; tzid: string };
export function parseDateTime(
  value: string,
  params: Record<string, string>,
): IcsInstant; // parse_error on malformed
export interface ZoneResolver {
  offsetMinutes(tzid: string, utcGuessMs: number): number | null;
}
export const intlZones: ZoneResolver; // try/catch new Intl.DateTimeFormat("en-US", { timeZone: tzid, timeZoneName: "longOffset" }); parse "GMT±HH:MM" / "GMT"
export function vtimezoneFixedOffset(zone: ZoneInfo | undefined): number | null; // STANDARD TZOFFSETTO as minutes; null without one
export type TzApproximation =
  "none" | "floating" | "vtimezone-fixed-offset" | "unresolved";
export function toUtc(
  instant: IcsInstant,
  zones: ZoneResolver,
  file: Map<string, ZoneInfo>,
): { iso: string; approximation: TzApproximation };
```

`zoned` resolution: two-pass `local − offset(guess)` through `intlZones`
(this handles DST correctly: a 10:00 Berlin start stays 10:00 local on both
sides of the transition) → else `vtimezoneFixedOffset` from the file's
matching `VTIMEZONE` (`"vtimezone-fixed-offset"`) → else treat as floating
(`"unresolved"`). `floating` → interpreted as UTC with `"floating"`.
`date` → `<date>T00:00:00.000Z` with `metadata.all_day: true`. The
approximation always lands in `metadata.tz`. The floor never invents an
offset silently.

### 4.6 Recurrence (`src/rrule.ts`) — pure, bounded

```ts
export interface RecurrenceRule {
  freq: "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";
  interval: number;
  count?: number;
  until?: IcsInstant;
  byday?: { ordinal: number | null; weekday: 0 | 1 | 2 | 3 | 4 | 5 | 6 }[];
  bymonthday?: number[];
  bymonth?: number[];
  wkst: 0 | 1 | 2 | 3 | 4 | 5 | 6;
}
export function parseRrule(
  value: string,
): { rule: RecurrenceRule } | { unsupported: string };
export function expand(
  rule: RecurrenceRule,
  dtstart: LocalDateTime,
  opts: {
    windowEnd: LocalDateTime;
    maxInstances: number;
    exdates: Set<string>;
    rdates: LocalDateTime[];
    maxSteps: number;
  },
): { instances: LocalDateTime[]; truncated: boolean };
```

Supported: the four FREQ values; `INTERVAL`; `COUNT`; `UNTIL` (UTC or
date); `BYDAY` (WEEKLY: weekday list; MONTHLY/YEARLY: ordinal weekdays like
`2MO`, `-1FR`); `BYMONTHDAY` (positive and negative); `BYMONTH` (YEARLY);
`WKST`; `EXDATE` (multiple values, DATE or DATE-TIME, matched on local
start); `RDATE` (added, deduplicated). Anything else (`BYSETPOS`,
`BYYEARDAY`, `BYWEEKNO`, `BYHOUR/MINUTE/SECOND`, `FREQ=HOURLY|MINUTELY|
SECONDLY`, a `RANGE=THISANDFUTURE` override) → `{ unsupported }` and the
master is emitted once with `metadata.recurrence.expanded: false`.
Expansion runs in local civil time and each instance is converted with
§4.5 using the DTSTART zone. Window: `[DTSTART, min(UNTIL/COUNT end,
now + 365 days)]`; `maxSteps` 100 000 candidate iterations; `maxInstances`
1 000 — when exceeded keep the LAST 1 000 (most recent) and set
`truncated`, which lands as `metadata.recurrence.truncated: true` on every
emitted instance of that master. A `VEVENT` with `RECURRENCE-ID` replaces
the instance whose local start it names (matched by `UID` + local start);
an override that names no generated instance is emitted as its own
instance. Test vectors: RFC 5545 §3.8.5.3 examples for each supported
feature, with exact expected local starts.

### 4.7 Event mapping, tombstones, hints (`src/events.ts`)

- `source_record_id`: `<UID>` for a non-recurring event; `<UID>#<local
start compact>` (`abc@acme.example#20260301T100000`, all-day
  `…#20260301`) for each instance. Missing `UID` → `sha256(DTSTART + "\n" +
SUMMARY)` hex prefix (16) with `metadata.uid_synthesized: true`. Two
  `VEVENT`s with the same id (no `RECURRENCE-ID`) → the last wins,
  `metadata.duplicate_uid: true`.
- `kind: "calendar_event"`; `occurred_at` = start instant; `text` =
  `SUMMARY` (or `(no title)`) + `"\n\n"` + `DESCRIPTION` +
  (`"\n\nLocation: " + LOCATION` when present); the same 262 144 code-point
  cap as §3.8.
- `subjects`: `ORGANIZER` → `from`; each `ATTENDEE` → `to`; both as
  `email:<lowercased address>` from a `mailto:` value (case-insensitive
  scheme), `display_name` from `CN` (sanitised ≤ 120); non-`mailto:` values
  skipped; plus `about` = `calendar:<slug>` where slug is `X-WR-CALNAME`
  lowercased with `[^a-z0-9._-]` → `-`, ≤ 64 chars, else the file's base
  name without extension (file mode) or the URL hostname (URL mode).
- `sensitivity_hint`: `CLASS:PUBLIC` → `public`; `CLASS:PRIVATE` or
  `CONFIDENTIAL` → `private`; otherwise `personal`.
- `attachments`: each `ATTACH` → `{ attachment_id: "attach-<n>", media_type:
FMTTYPE ?? "application/octet-stream", filename?: last URI path segment
(sanitised) }`; inline `ENCODING=BASE64` values contribute `byte_size`
  and are never stored.
- `metadata`: `{ uid, sequence, status, location, ends_at: iso | null,
all_day, ends_on?, duration?, tz: { tzid?, approximation }, recurrence?: {
rrule, instance_of, recurrence_id?, expanded, truncated? }, created?,
last_modified?, url?, calendar_name?, uid_synthesized?, duplicate_uid? }`.
- Backfill: `STATUS:CANCELLED` events are skipped. Sync: an id in the
  cursor snapshot that is now absent or cancelled → tombstone (`deleted:
true`, `text: ""`, `subjects: []`, `metadata: { uid, recurrence_id? }`,
  `occurred_at = observed_at`); an id whose hash changed → the event is
  re-emitted (the ledger stores an edit); unchanged → nothing. Order:
  tombstones first, then events sorted by `source_record_id`. `backfill`
  always returns the full snapshot cursor (never null); `backfill(cursor)`
  ignores the cursor and re-emits everything (dedupe makes it a no-op) —
  same contract as `markdown-folder`.

### 4.8 Sign-in (URL mode, `src/sign-in.ts`)

Prompt `Calendar URL (https:// or webcal://): `; `webcal://` is rewritten
to `https://`; anything else (`http://` included) →
`KizukiError("misconfigured", "kizuki.ics: only https:// calendar URLs are
supported")`. Fetch through `deps.fetch`, parse (§4.4; a document without a
`VCALENDAR` → `parse_error`), `state.write(serialize({ url }))` once, return
`{ display: <calendar name or URL hostname, control characters stripped,
≤ 80 chars> }`.

### 4.9 `connect` / `health` / `revoke` / `purgeSource` / fixture / fakes

- File mode `connect`: no-op; `health`: `ok` when `path` is a readable
  regular file, else `misconfigured` (same shape as `pathHealth`).
  URL mode `connect`: `secret_ref` required (`missing_secret` otherwise),
  resolve → `parseIcsState` → one conditional-free fetch + parse
  ("validates for real"); `health` before `connect` → `disabled`, after →
  a bounded fetch mapped through §4.3 codes. Empty config `{}`: `signIn`,
  `manifest`, `fixture`, `purgeSource` work; `health` → `disabled`;
  `backfill`/`sync` → `missing_secret`.
- `revoke`: no-op (nothing is held remotely); documented.
- `purgeSource`: `capabilities.purge: false`; returns the empty plan (the
  file is the owner's; purge is ledger-side).
- `fixture()` (`src/fixture.ts`): one synthetic calendar (`X-WR-CALNAME:
Acme team`) with ≥ 8 events through the real parser: a UTC timed event;
  a `TZID=Europe/Berlin` event; an all-day event; a weekly `RRULE` with
  `COUNT=5`, one `EXDATE` and one `RECURRENCE-ID` override; a
  `CLASS:PRIVATE` event; an event with an organizer and three attendees; an
  event with an `ATTACH`; a cancelled event (skipped in backfill); an event
  with a `TZID` that only the file's `VTIMEZONE` knows (`Acme Standard
Time`, fixed-offset approximation). `now` fixed to `2026-03-01T00:00:00Z`.
- `src/testing/memory-fetch.ts` — `memoryFetcher(routes: Record<string,
IcsFetchResult | (() => IcsFetchResult)>): IcsFetcher` and `fixtureIcsText()`.

## 5. Non-goals (say so in the READMEs)

STARTTLS on port 143 (implicit TLS only), `AUTHENTICATE`/XOAUTH2/OAuth
providers, plaintext IMAP, IDLE/push, attachment download, flag or label
capture, sending or moving mail, Sieve, NNTP/POP3; ICS `VTODO`/`VJOURNAL`,
`VALARM`, `METHOD:REQUEST` scheduling semantics, CalDAV, HTTP calendar
URLs, non-IANA zone rules beyond a fixed-offset approximation, `RRULE`
features outside §4.6. CLI verbs are owned by the CLI lanes; this lane wires
none. The ingest runner is not modified (see open question in the result).

## 6. Tests

Baseline 515. Add ≥ 90 tests. Every test uses synthetic data, temp dirs,
the in-memory fakes, and no network except the loopback TLS test below.

`scripts/verify-network.test.ts`: the four allowlist cases in §2.2.

`packages/core/test/index.test.ts`: `KizukiError` in the export list;
`packages/connectors/test/registry.test.ts`: unchanged behaviour still
passes with the moved class (`instanceof KizukiError` from `../src`).

`packages/connectors/test/conformance.test.ts` (extend the existing "all
registry connectors pass conformance" test): `kizuki.imap` built with
`memoryDialer(new FakeImapServer(fixtureMailbox()))`, `connect` with a
resolver returning `JSON.stringify(fixtureState())`, tombstone hooks
`prepare = backfill(null).cursor`, `mutate = server.expunge("INBOX", uid)`;
`kizuki.ics` twice — file mode on a temp file (mutate = rewrite the file
without one VEVENT) and URL mode via `memoryFetcher` (mutate = swap the
route). All three results `{ pass: true, failures: [] }`.

`packages/connector-imap/test/`:

- `state.test.ts`: round-trip; refusal of unknown key, wrong schema, port
  0/65536/"993", empty folders, duplicate folder; error messages contain no
  field value.
- `uidset.test.ts`: parse/format/add/remove/chunk vectors incl. `"1:3,5"`,
  single UIDs, merging adjacent ranges.
- `tokenizer.test.ts`: atoms, quoted with escapes, parenthesised lists,
  NIL, literal across chunk boundaries, `{n+}`, line over 64 KiB →
  `protocol`, literal over 8 MiB → `protocol`.
- `client.test.ts`: tag correlation with interleaved untagged responses;
  continuation `+` for a literal argument; a password with `"` and a
  non-ASCII password sent as a literal; NUL refused; `* BYE` →
  `unreachable`; command timeout → `unreachable` and the connection closed;
  RFC 5530 code table → exact `KizukiError.code` per row; sanitised detail
  (≤ 200 chars, control characters stripped).
- `transport.test.ts` (skipped with a reason when `Bun.which("openssl")` is
  null): generate an ephemeral EC key + self-signed cert for
  `localhost`/`127.0.0.1` into a temp dir with `openssl req -x509 …`, run
  `Bun.listen({ tls })` on 127.0.0.1 serving a scripted greeting: (a) no
  `ca` → rejects `unreachable` with `tls: DEPTH_ZERO_SELF_SIGNED_CERT`, and
  the server's received-line log is empty (no LOGIN was ever sent); (b)
  `ca` + host `localhost` → greeting delivered; (c) `ca` + host
  `mail.example.invalid` connecting to the same port → rejected with
  `certificate does not match host`, nothing sent; (d) a server that
  accepts and never speaks → `connect timed out` within `timeoutMs`.
  `hostnameMatches` table: the wildcard, case, IP-literal and CN-fallback
  rows of §3.3.
- `utf7.test.ts`: `&AOk-` → `é`, `&-` → `&`, plain names unchanged,
  malformed → left verbatim.
- `mime/*.test.ts`: header unfolding + caps; RFC 2047 B/Q, merged adjacent
  words, unknown charset fallback; quoted-printable and base64 vectors incl.
  soft breaks and CRLF; `Content-Type` params with RFC 2231 continuation
  and a quoted boundary; multipart nesting, depth/part caps, `alternative`
  preference, `message/rfc822` as attachment; `htmlToText` vectors
  (script/style removal, entities, block newlines, collapse).
- `events.test.ts`: every fixture message → exact `source_record_id`,
  `occurred_at`, `subjects`, `attachments`, `metadata` (snapshot the
  eleven fixture events as literal expectations); `Date:` comment stripping
  and INTERNALDATE fallback; `text_truncated`; no `flags` key anywhere.
- `mailbox.test.ts` (fake server): backfill of 450 messages in pages of
  200/200/50 with resume from each cursor and no UID emitted twice;
  `backfill(cursor)` after completion → empty batch, cursor unchanged;
  second folder walked after the first; sync sees new mail (`uidnext`
  grew) and pages it; expunge detection emits one tombstone per missing
  UID and shrinks `known`; UIDVALIDITY reset emits tombstones for the old
  ids (`uidvalidity_reset: true`) then re-emits under the new ids; a
  mid-walk `NO` propagates a `KizukiError` and the caller's previous cursor
  stays valid; header-only capture for a message above
  `max_message_bytes`; `BODY.PEEK` (assert no `BODY[` without `.PEEK` and
  no `SELECT`/`STORE` in the received log).
- `sign-in.test.ts` (scripted `SignInIo` + fake server + a real
  `ConnectionStateStore` + `enrollConnection` in a temp dir): the happy
  path writes exactly one 0600 state file whose bytes parse to the typed
  answers and returns `{ display: <username> }`; a wrong password →
  `unauthenticated` and no state file, no row; an unknown folder name →
  `misconfigured` listing it, no state; port `70000` → refused before any
  connection (server log empty); folder re-selection via
  `ConnectionStateStore.replace` keeps the `source_key`; the raw SQLite
  bytes never contain the password (`readFileSync` after `db.close()`).
- `connector.test.ts`: `connect` without `secret_ref` → `missing_secret`;
  resolver rejection → `missing_secret`; malformed state → `misconfigured`;
  `health` before connect `disabled`, after connect `ok`, with a missing
  folder `misconfigured`, with LOGIN refused `unauthenticated`, with
  `[LIMIT]` `rate_limited`, with `* BYE` `unreachable`; `purgeSource` for
  `email:ada@acme.example` lists the two fixture records as unreachable
  and `source_record_ids: []`; for `conformance:subject` both empty; the
  redaction rule of §3.11 asserted on every error/detail produced in this
  file with a password like `pw-with-quote"-and-ünïcode`.
- `smoke.test.ts`: runs only when `KIZUKI_IMAP_SMOKE_HOST`, `_PORT`,
  `_USERNAME`, `_PASSWORD` are all set (otherwise `test.skip` with the
  variable names); `connect` from an in-memory resolver, `health().state
=== "ok"`, one `backfill(null)` page validates through
  `validateEventInput`; prints nothing.

`packages/connector-ics/test/`:

- `unfold.test.ts` / `parse.test.ts`: folding (space and tab), CRLF/LF,
  BOM, quoted params, multi-value params, escapes, unknown components
  skipped, bounds → `parse_error`.
- `datetime.test.ts`: all four `IcsInstant` forms; `Europe/Berlin` summer
  and winter, `Asia/Kolkata`, `Asia/Kathmandu`, a DST-gap local time; a
  Windows zone name resolved through `VTIMEZONE` fixed offset with
  `"vtimezone-fixed-offset"`; unknown zone without `VTIMEZONE` →
  `"unresolved"`; `UNTIL` in UTC vs DATE.
- `rrule.test.ts`: the RFC 5545 §3.8.5.3 vectors for every supported
  feature (exact local starts); `EXDATE`/`RDATE`; `RECURRENCE-ID`
  override replaces one instance; unsupported → `{ unsupported }`; window
  end and `maxInstances` truncation keep the last 1 000; `maxSteps` guard.
- `events.test.ts`: the fixture calendar → literal expectations for every
  emitted event (ids, `occurred_at`, subjects, hint from `CLASS`,
  `metadata.tz`, `metadata.recurrence`); cancelled skipped in backfill;
  synthesized uid; duplicate uid; `about` slug for name/file/URL.
- `fetch.test.ts` (in-memory `fetchImpl`): https-only, http redirect
  refused, 4th redirect refused, `304` handling with etag/last-modified
  round-trip, 16 MiB cap aborts, timeout wiring (`AbortSignal.timeout`
  present on the request), status → code table, error messages never
  contain the URL.
- `connector.test.ts`: file mode backfill/sync/tombstone/edit via a temp
  file; URL mode through `memoryFetcher` incl. `304` → empty batch with the
  cursor preserved; `{}` config behaviour; `health` states; `sign-in` via
  `enrollConnection` (webcal rewrite, http refused before fetch, state file
  0600, display sanitised, the URL absent from SQLite bytes and from every
  error).

## Acceptance

```
bun install --frozen-lockfile                                     # exit 0 (lockfile committed with the two workspace packages, no new registry packages)
bun run typecheck                                                 # exit 0
bun test                                                          # green; ≥ 605 tests (515 baseline + ≥ 90)
bun test packages/connectors/test/conformance.test.ts             # kizuki.imap, kizuki.ics (file), kizuki.ics (url) all { pass: true, failures: [] }
bun test packages/connector-imap/test packages/connector-ics/test # green
bun run scripts/verify-network.ts                                 # exit 0; stderr shows exactly two "allowed:" file groups: packages/connector-imap/src/transport.ts and packages/connector-ics/src/fetch.ts
bun run verify                                                    # exit 0 (policy tests, network gate, dependency grep, identifier denylist over tracked text AND commit messages)
grep -rn 'rejectUnauthorized: *false' packages/                   # no output
grep -rn 'console\.' packages/connector-imap/src packages/connector-ics/src   # no output
grep -rlE 'BEGIN (EC |RSA )?PRIVATE KEY' packages/ scripts/       # no output (test certificates are generated at test time)
grep -c '"@kizuki/core": "workspace:\*"' packages/connector-imap/package.json packages/connector-ics/package.json   # 1 and 1; no other dependencies key in either file
grep -rnE '"(SELECT|STORE|EXPUNGE|APPEND)\b' packages/connector-imap/src --exclude-dir=testing   # no output (read-only: EXAMINE and BODY.PEEK only; the fake server under src/testing may name them to reject them)
git status --porcelain                                            # empty
```
