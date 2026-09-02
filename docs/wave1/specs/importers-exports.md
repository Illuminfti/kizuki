> **Superseded owner-gate framing, 2026-09-02.** Importers emit evidence.
> They do not feed an owner review queue. See
> `rfcs/0002-autonomous-canon.md`.

# Lane: importers-exports — WhatsApp chat export, Pocket CSV, Omnivore export folder as three `auth_modes: ["none"]` importers

## Decision-log deltas (2026-09-02)

- "it has no author and would only add a capture note per notice to the
  review queue" is superseded. There is no review queue (D10). The reason to
  skip a system notice is that it carries no author and no claim worth
  writing; the cost it avoids is canon write budget and index volume, not a
  person's attention (D9, RFC 0002 §4.3).
- Importers emit evidence into the append-only ledger. Extraction, claims and
  the receipted writer sit downstream and run on the daemon's schedule
  (D9, D15; RFC 0002 §4).
- Every importer manifest must declare `default_sensitivity` and
  `sensitivity_floor`; a `sensitivity_hint` is honored only upward, and
  unknown resolves to `private` (D11, RFC 0002 §8.2).
- An export importer is never described as live sync, and its honest limits
  stay in public documentation. That rule is unchanged.

Reconciled against `main` @ `76930db` (2026-09-02; `bun test` = 515 pass /
41 files; bun 1.3.14 locally, CI pins 1.3.10). Every path, symbol, table and
flag below was grepped on that revision; anything not on main is marked NEW
with its intended location.

Package(s): `packages/connectors` only — three NEW directories under
`src/` (`import-whatsapp/`, `import-pocket/`, `import-omnivore/`), NEW
helpers appended to `src/util.ts`, three entries in `src/registry.ts`,
re-exports in `src/index.ts`, NEW `packages/connectors/README.md`, and
tests under `packages/connectors/test/`. No change to `packages/core`,
`packages/cli`, `packages/tui`, `scripts/` or `docs/`. Read, in order:
`CONVENTIONS.md`; `docs/architecture.md` (Contracts → `kizuki.event/v1`,
`kizuki.connector/v1`, "Sign-in, not setup"; invariants 4, 5, 6, 7, 8, 10);
`rfcs/0000-constraints.md` (§1 ingress frozen, §6 provenance total, §7
append-only); `AGENTS.md` (Data, privacy, and external research: "never
describe an export importer as live sync"); `packages/connectors/AGENTS.md`
(archives and export files are hostile input); `.agents/skills/
connector-work/SKILL.md` and `.agents/skills/security-privacy-review/
SKILL.md`; then every file under `packages/connectors/src` and
`packages/connectors/test` (the two JSON importers are the precedent for
shape, the markdown-folder connector for a cursor and for tombstones you
must NOT copy); `packages/core/src/contracts/{connector,event}.ts`;
`packages/core/src/util/hash.ts` (which fields feed `content_hash`);
`packages/core/src/staging/producers.ts` (`proposalsForEvent`, `handleOf`,
`cascadeTombstone` — what a `deleted: true` event triggers, hence why an
importer must never emit one); `packages/core/src/ingest/run.ts`
(`runBackfill`, `runSync`, `runBatch`); `packages/core/test/ingest.test.ts`
(the `FixtureConnector` style and the `openLedger(":memory:")` +
`initStaging` database helper you will reuse in the tombstone-semantics
proof). Plan §3.1 and §3.2 in `workspace/kizuki-plan/ARCHITECTURE.md`
("Graveyard importers ship as connectors too", the conformance list) and
§2.2 (queue semantics: tombstones propagate) describe the intent; where the
plan disagrees with main (`AsyncIterable` sweeps, `role: "self"`, `handle`

- `namespace` on subjects), main wins.

## Already on main (compose; do not redo)

- `Connector` = `manifest / health / connect / backfill / sync / revoke /
purgeSource / fixture` (+ optional `signIn`, not used here).
  `Manifest.capabilities = { backfill, sync, tombstones, purge, fixture }`,
  `required_secrets: string[]` (secret_ref URIs), `emits_sensitivity_hint`,
  `auth_modes` non-empty. `SyncBatch = { events: CaptureEventInput[];
cursor: Cursor | null }`; `PurgePlan = { subject_id, source_record_ids,
unreachable_source_record_ids }`; `HealthReport` validates at
  construction (`packages/core/src/contracts/connector.ts`).
- `runConformance(connector, opts)` (`packages/connectors/src/conformance.ts`)
  checks: manifest shape; interactive-mode ⇔ `signIn`; `fixture()` non-empty
  and every event valid with the manifest's `connector_id` and a declared
  `kind`; `backfill(null)` and `sync(null)` return a `SyncBatch`;
  `purgeSource("conformance:subject")` returns the plan shape; fixture
  round-trip through `InMemoryLedger` (first accept all `stored`, second all
  `duplicate`); a rejecting `SecretResolver` makes `connect` throw a
  `KizukiError` when `required_secrets` is non-empty; two `backfill(null)`
  calls yield equal counts and the second is entirely duplicate;
  `tombstones: true` without hooks FAILS. With `tombstones: false` no hooks
  are needed — which is what the three importers declare (§0.3).
- `KizukiError` with codes `unknown_connector | parse_error |
missing_secret | misconfigured` (`src/errors.ts`). `src/util.ts`:
  `requirePathConfig`, `pathHealth(path, "file" | "directory")`,
  `readUtf8`, `parseJsonArray`, `normalizedDate` (silent fallback — not
  used by this lane, see §0.5), `errorMessage`, `compareStrings`.
- `InMemoryLedger` (`src/ledger.ts`), `REGISTRY` + `getConnector` overloads
  (`src/registry.ts`), the re-export barrel (`src/index.ts`).
- Precedents: `kizuki.import-chatgpt` / `kizuki.import-claude` (config
  `{ path }`, `cursor: null`, `sync === backfill`, `tombstones: false`,
  `purge: false`, `fixture()` parses an exported constant, parser exported
  as a pure function with an `observedAt` parameter);
  `kizuki.markdown-folder` (snapshot cursor, real tombstones — a folder the
  connector re-scans is a live source; an export file is not).
- `content_hash` covers `connector_id, source_record_id, kind, occurred_at,
text, subjects, deleted, metadata` and excludes `observed_at`,
  `attachments`, `sensitivity_hint` (`packages/core/src/util/hash.ts`). The
  ledger dedupes on `(connector_id, source_record_id, content_hash)`.
- `proposalsForEvent` files one `entity` candidate per distinct
  `subject_id` (page `type: "person"`, `title = display_name ?? handleOf(id)`
  where `handleOf` takes the text after the LAST `:`) plus one `claim`
  capture note quoting the text as a blockquote. Consequence: every
  subject an importer emits becomes a person-candidate claim,
  so subjects are people (or the chat) only — never URLs, domains or labels.
- `cascadeTombstone` withdraws pending proposals of the record and files a
  `deletion` proposal per promoted page citing it. A wrongly emitted
  tombstone therefore reaches the receipted writer as a retraction
  claim — the concrete harm §0.3 prevents.
- The CLI on main is the pre-alpha single file `packages/cli/src/main.ts`:
  `ingest <connector_id> --vault PATH --source PATH` builds
  `getConnector(id, { path: resolve(--source) })`, calls `connect` with a
  refusing resolver, then `backfill(null)` (a `null` cursor is never
  checkpointed, so every run is a backfill). cli-verbs (`import <connector>
--source PATH`, NEW, not on main) and cli-wave2 (`connectorFor`) pass the
  same `{ path }` config. Nothing in this lane depends on either; both work
  with these connectors unchanged.
- `bun run verify` (`scripts/verify.sh`): frozen install, typecheck, tests,
  `scripts/verify-network.ts` (AST scan for network modules and calls),
  phone-home dependency grep, identifier denylist over tracked text, tracked
  paths and every reachable commit message.
- Bun 1.3 has no zip-archive API (`Bun.unzipSync` is undefined; only
  gzip/deflate/zstd exist). Every export this lane reads is the UNZIPPED
  folder (§Non-goals).

## Objective

Three sources the owner cannot connect to live — WhatsApp has no sanctioned
user API for personal history, Pocket closed in 2025, Omnivore closed in
2024 — arrive as export files. The owner unzips the export, runs
`kizuki ingest kizuki.import-whatsapp --vault V --source DIR` (main) or
`kizuki import import-whatsapp --source DIR` (cli-verbs), and the messages,
bookmarks and highlights land in the ledger as `kizuki.event/v1` events with
stable ids, honest timestamps, subjects for the people involved, media as
references, and sensitivity hints. Re-importing the same export stores
nothing new; re-importing a larger export stores only what is new;
re-importing a SMALLER export never deletes anything (§0.3). Every importer
passes the shared conformance suite, needs no credentials, touches no
network, and refuses hostile files (traversal, symlinks, oversize,
malformed encodings) with a `KizukiError` that names a line or row number
and never quotes captured text.

## Non-goals

- Live sync of any of the three sources; the WhatsApp Business API and
  Composio (deferred by decision; say so in the README). Nothing here is a
  "connector" in the live sense and the README must not call it one.
- Reading zip archives. The owner unzips first; the connectors refuse a
  `.zip` path with `misconfigured` ("unzip the export first"). This is also
  the decompression-bomb defence: there is no decompression.
- Media downloads, media parsing, thumbnails, HTML-to-text conversion of
  Omnivore `content/*.html` (attachment reference only, §4.4), the legacy
  Pocket HTML export (`ril_export.html`, refused with `parse_error`).
- Tombstones of any kind (§0.3). Deleted-message placeholders in WhatsApp
  ("This message was deleted", localized) stay ordinary text.
- Deriving `self` (the owner) without configuration; group-vs-direct chat
  inference; identity resolution across exports (RFC 0001 territory).
- CJK calendar dates (`2026年1月4日`), Persian/Arabic-Indic digits, and
  any WhatsApp line whose date is not numeric with `/`, `.` or `-`
  separators; such files fail with `parse_error` naming the first
  unrecognized line (§2.3).
- Any CLI verb or flag (the `{ path }`-only config surface of the CLI is an
  open question flagged in the result, not solved here).
- Any change to `kizuki.event/v1`, `kizuki.connector/v1`, the conformance
  suite, `packages/core`, or the existing three connectors.

## Runtime dependencies

None. `@kizuki/connectors` keeps `@kizuki/core` as its only dependency;
`@kizuki/core` stays dependency-free. CSV, the WhatsApp line grammar, JSON
and Markdown handling use `node:fs`, `node:path`, `Bun.CryptoHasher`,
`TextDecoder`, `Intl.DateTimeFormat` and `String.prototype.normalize` —
all present on Bun 1.3.10. No `fetch`, sockets, or network modules
anywhere (`scripts/verify-network.ts` scans every tracked source file).

## 0. Shared rules for the three importers

### 0.1 Identity, config, manifest

| connector            | registry id              | config                                                  | kinds          |
| -------------------- | ------------------------ | ------------------------------------------------------- | -------------- |
| WhatsApp chat export | `kizuki.import-whatsapp` | `{ path, date_order?, timezone?, self?, chat? }` (§2.1) | `["message"]`  |
| Pocket CSV export    | `kizuki.import-pocket`   | `{ path }` (§3.1)                                       | `["bookmark"]` |
| Omnivore export      | `kizuki.import-omnivore` | `{ path }` (§4.1)                                       | `["bookmark"]` |

The ids follow `kizuki.import-chatgpt` on main (cli-verbs' short form is
`import-whatsapp` etc.). `path` is validated with `requirePathConfig`
(existing). Every other key is validated per connector; an unknown key
throws `KizukiError("misconfigured", "<id>: unknown config key <k>")` at
construction (fail closed: config is host-authored, but a typo must not
silently become a default). Manifest, identical except `connector_id` and
`kinds`:

```ts
{
  schema: "kizuki.connector/v1", connector_id, version: "0.1.0", kinds,
  capabilities: { backfill: true, sync: true, tombstones: false, purge: true, fixture: true },
  required_secrets: [],
  emits_sensitivity_hint: true,
  auth_modes: ["none"],
}
```

`connect(_resolve)` resolves immediately (nothing to authenticate);
`revoke()` resolves immediately (nothing to revoke; the export file is the
owner's and stays); `health()` never throws (§0.6).

### 0.2 Snapshot semantics: `backfill` and `sync`

An export is a snapshot the owner chose to take. Both `backfill(cursor)`
and `sync(cursor)` ignore the cursor, parse the whole export, and return
`{ events, cursor: null }` — the source is exhausted in one batch, the
same contract `kizuki.import-chatgpt` implements and the ingest runner
already handles (`runBackfill`/`runSync` store a `null` cursor; the
telegram lane's `runToCompletion`, when it lands, stops on the empty
second batch). Parsing is deterministic: identical bytes + identical
config ⇒ identical event list, in the same order, with identical
`source_record_id`, `text`, `subjects` and `metadata`, so the ledger's
dedupe key makes every re-run a no-op. `observed_at` is one timestamp per
batch (`new Date().toISOString()`), outside the hash.

### 0.3 Tombstone semantics: absence is not deletion

`tombstones: false`, honestly and permanently. A record present in export
A and absent from export B may have been deleted at the source, or B may
simply cover a shorter range, a different device, or an export "without
media". The connector cannot tell, so it never emits `deleted: true`; a
re-import of a smaller export stores nothing, withdraws nothing, and files
no `deletion` proposal (`cascadeTombstone` is never reached). Removal of
imported data is the owner's decision through `kizuki purge --event |
--subject | --connector` (core `purgeEvents`), which leaves receipts. The
README states this in one sentence per importer. Proof: the
tombstone-semantics test in §7 drives the real `runBackfill` / `runSync`
from `@kizuki/core` against two exports of the same chat.

Edits are versions, not tombstones: when the same `source_record_id`
reappears with different `text` or `metadata` (Pocket `status` flipped to
`archive`, an Omnivore item gaining a highlight) the ledger stores a new
row for the same record — append-only supersession (RFC 0000 §7).
Volatile fields that would fork history on every export (Omnivore
`updatedAt`, `readingProgress`; WhatsApp line numbers) are excluded from
`metadata` (§2.7, §4.4).

### 0.4 Purge plans

`purge: true` means a precise plan, not remote deletion: the connector
never modifies the owner's export files. `purgeSource(subject_id)` parses
the configured export (no network; `misconfigured` if unreadable — a plan
that cannot be computed is not a plan) and returns

```ts
{
  subject_id,
  source_record_ids: [],                       // always: the export is the owner's file, untouched
  unreachable_source_record_ids: [...ids],     // sorted (compareStrings), records whose subjects include subject_id
}
```

An unknown subject (including the conformance suite's
`"conformance:subject"`) yields both arrays empty. The ledger side is
core's `purgeEvents(db, vault, { subject_handle }, reason)`; the plan tells
the owner what that purge will reach and that the export file itself stays.

### 0.5 Timestamps

Every `occurred_at` is derived from the export, never from the clock, and
an unparsable timestamp is a `parse_error` naming the line/row/index — the
existing `normalizedDate` fallback (silently stamping "now") is not used by
this lane. NEW helpers in `src/util.ts`:

```ts
export function unixSecondsToIso(value: unknown, where: string): string;
// string of digits or a safe integer, 0 < v < 2**40 → new Date(v * 1000).toISOString(); else KizukiError("parse_error", `${where}: invalid unix timestamp`)
export function isoToRfc3339(value: unknown, where: string): string;
// string with Number.isFinite(Date.parse(value)) → new Date(value).toISOString(); else parse_error `${where}: invalid timestamp`
export const FIXTURE_OBSERVED_AT = "2026-01-01T00:00:00.000Z";
```

### 0.6 Bounded, hostile-input-safe reading

NEW in `src/util.ts`:

```ts
export const MAX_EXPORT_BYTES = 256 * 1024 * 1024;
export const MAX_RECORDS = 1_000_000;
export async function readBoundedUtf8(
  path: string,
  connectorId: string,
  maxBytes = MAX_EXPORT_BYTES,
): Promise<string>;
// lstat: not a regular file (symlink, directory, device) → misconfigured; size > maxBytes → misconfigured naming the limit, without reading;
// readFile → new TextDecoder("utf-8", { fatal: true }).decode → invalid UTF-8 → parse_error `${connectorId}: ${basename} is not valid UTF-8`;
// strips one leading U+FEFF; normalizes CRLF and lone CR to LF.
export async function statRegularFile(
  path: string,
): Promise<{ byte_size: number } | null>;
// lstat; returns the size for a regular file, null for missing, symlink, directory, or any error (never throws)
export function safeFilename(name: string): string | null;
// null unless: 1..255 chars, basename(name) === name, no "/" or "\\", not "." or "..", no control characters, no leading "-"
export function subjectSlug(name: string): string;
// NFC → drop U+200E U+200F U+202A..U+202E U+2066..U+2069 → trim → toLowerCase()
//   → runs of anything outside \p{L}\p{N} become "-" → trim "-" → slice(0, 128) → "" becomes "unknown"
export function requireKnownKeys(
  config: Record<string, unknown>,
  connectorId: string,
  allowed: readonly string[],
): void;
export function mediaTypeFor(filename: string): string;
// lowercase extension → jpg/jpeg image/jpeg, png image/png, gif image/gif, webp image/webp, heic image/heic,
// mp4 video/mp4, 3gp video/3gpp, mov video/quicktime, mp3 audio/mpeg, opus audio/ogg, ogg audio/ogg, m4a audio/mp4, aac audio/aac,
// pdf application/pdf, vcf text/vcard, txt text/plain, html text/html, md text/markdown; anything else application/octet-stream
```

Rules every parser obeys: reject a record count above `MAX_RECORDS`
(`parse_error`); reject a single message/field above 1 MiB
(`MAX_RECORD_BYTES = 1024 * 1024`, `parse_error` naming the line/row);
never embed captured text, a sender name, a title or a URL in a thrown
message or a `HealthReport.detail` — positions only (`line 42`, `row 7`,
`metadata_0_to_100.json[3]`); never follow a symlink; never touch a path
outside the export folder (`safeFilename` + `join(dir, name)` only);
never read media bytes (`statRegularFile` for the size only). `health()`
reports `misconfigured` with a detail that may name the configured path
(the owner's own config, as `pathHealth` already does) but never a
filename taken from inside an export.

### 0.7 Subjects and sensitivity

Subjects are people or the chat. Ids have exactly one segment after the
namespace so `handleOf` yields a readable handle:

- WhatsApp: sender `whatsapp:<subjectSlug(name)>` (`whatsapp:self` when the
  name equals `config.self`), chat `whatsapp:chat:<subjectSlug(chat)>`.
- Pocket: `pocket:self`; Omnivore: `omnivore:self` — the owner saved the
  item; authors, labels and domains are metadata, not subjects (§ Already
  on main: every subject becomes a person candidate).

`sensitivity_hint`: `private` for every WhatsApp message (a personal chat;
group-vs-direct cannot be told from an export, so the stricter label
wins), `personal` for Pocket and Omnivore bookmarks (a reading list is
about the owner, not a secret). `emits_sensitivity_hint: true` is
therefore honest, and the owner's `kizuki query` serves these events
without a label warning.

## 1. Layout

```
packages/connectors/src/
  util.ts                     # + §0.5/§0.6 helpers (append; existing exports unchanged)
  import-whatsapp/
    index.ts                  # connector, manifest, config, fixture(), WHATSAPP_FIXTURE_FILES (§2.1, §2.8)
    grammar.ts                # line regex, header/system detection, message assembly (§2.3)
    dates.ts                  # date-order detection, 12-hour handling, localToUtc (§2.4, §2.5)
    media.ts                  # attachment/omitted detection, MediaLookup (§2.6)
    map.ts                    # ParsedMessage → CaptureEventInput, ids, subjects (§2.7)
  import-pocket/
    index.ts                  # connector, config, fixture(), POCKET_FIXTURE_EXPORT (§3)
    csv.ts                    # bounded RFC 4180 reader (§3.2)
  import-omnivore/
    index.ts                  # connector, config, fixture(), OMNIVORE_FIXTURE_FILES (§4)
    parse.ts                  # metadata_*.json + highlights/*.md + content/*.html (§4.3)
  registry.ts                 # + three entries and overloads (§5)
  index.ts                    # + re-exports (§5)
packages/connectors/README.md # NEW (§6)
packages/connectors/test/
  whatsapp.test.ts whatsapp-dates.test.ts pocket.test.ts csv.test.ts omnivore.test.ts
  importers-tombstones.test.ts conformance.test.ts (extend) registry.test.ts (extend)
```

Every file stays under ~400 lines.

## 2. WhatsApp chat export (`src/import-whatsapp/`)

Format facts (the official "Export chat" feature on Android and iOS,
observed 2026-09-02 across current app versions; there is no published
specification, which is why the grammar below is explicit and every
deviation is a named `parse_error`): the export is a zip holding one chat
text file — `WhatsApp Chat with <name>.txt` on Android, `_chat.txt` on iOS
— plus, for "with media" exports, the media files beside it. Timestamps are
the exporting device's LOCAL time in the device locale with no zone
information. One line per message; multi-line messages continue on
following lines; system notices have no sender.

### 2.1 Config

```ts
export const WHATSAPP_IMPORT_CONNECTOR_ID = "kizuki.import-whatsapp" as const;
export type DateOrder = "dmy" | "mdy" | "ymd";
export interface WhatsAppImportConfig {
  /** The unzipped export directory (exactly one .txt inside) or the chat .txt itself. */
  path: string;
  /** Overrides §2.4 detection. */
  date_order?: DateOrder;
  /** IANA zone ("Europe/Berlin") or fixed offset ("+02:00"); default: the host's zone (§2.5). */
  timezone?: string;
  /** Sender display name that is the owner; that sender becomes `whatsapp:self`. */
  self?: string;
  /** Chat display name override (default derived from the file name, §2.7). */
  chat?: string;
}
```

Validation at construction (`misconfigured`): `path` via
`requirePathConfig`; `date_order` ∈ the three values; `timezone` via
`resolveTimezone` (§2.5); `self` and `chat` non-empty strings when
present; unknown keys refused (§0.1).

Export resolution (`resolveExport(path): Promise<{ txt: string; mediaDir: string }>`,
used by `health`, `backfill`, `sync`, `purgeSource`): `lstat(path)` — a
symlink or missing path → `misconfigured`; a `.zip` file → `misconfigured`
"unzip the export first"; a regular file must end with `.txt`; a directory
must contain exactly one `.txt` regular file at its top level (zero →
`misconfigured` "no .txt chat export in <path>"; several → `misconfigured`
"several .txt files in <path>; pass the chat file path"). `mediaDir =
dirname(txt)`.

### 2.2 Public API

```ts
export interface ParsedWhatsAppMessage {
  line: number; // 1-based line of the first line of the message (test/diagnostic only; never persisted)
  local_timestamp: string; // "YYYY-MM-DDTHH:MM" or "YYYY-MM-DDTHH:MM:SS", 24-hour, as written after date-order resolution
  sender: string; // verbatim (marks stripped, trimmed)
  text: string; // continuation lines joined with "\n"
}
export interface WhatsAppParseOptions {
  date_order?: DateOrder;
  timezone: string; // already resolved (§2.5)
  self?: string;
  chat: string; // display name
  observed_at: string;
  media: MediaLookup; // §2.6
}
export function splitWhatsAppMessages(
  text: string,
  date_order?: DateOrder,
): { messages: ParsedWhatsAppMessage[]; date_order: DateOrder };
export function parseWhatsAppExport(
  text: string,
  opts: WhatsAppParseOptions,
): Promise<CaptureEventInput[]>;
export function chatNameFromFile(txtPath: string): string;
export class WhatsAppImportConnector implements Connector {
  constructor(config: WhatsAppImportConfig);
}
export function createWhatsAppImportConnector(
  config: WhatsAppImportConfig,
): WhatsAppImportConnector;
export const WHATSAPP_FIXTURE_FILES: Readonly<Record<string, string>>; // §2.8
export const WHATSAPP_FIXTURE_TIMEZONE = "+00:00";
```

### 2.3 Line grammar (`grammar.ts`)

A line is a MESSAGE START when it matches, from column 0:

```
START   := MARK* "["? DATE SEP1 TIME "]"? SEP2 REST
MARK    := U+200E | U+200F
DATE    := D{1,2} S D{1,2} S (D{2}|D{4})   |   D{4} S D{1,2} S D{1,2}     S ∈ { "/", ".", "-" }, both S equal
SEP1    := ","? WS+                                                        WS ∈ { " ", U+00A0, U+202F }
TIME    := D{1,2} ":" D{2} (":" D{2})? (WS? MERIDIEM)?
MERIDIEM:= [AaPp] "."? WS? [Mm] "."?                                       (AM, pm, a.m., p. m.)
SEP2    := WS* "-" WS+          when no "[" opened the line   (Android)
         | WS+                  when "]" closed the timestamp  (iOS)
REST    := SENDER ": " TEXT  |  TEXT                                       SENDER = shortest prefix before the first ": "
```

Rules:

- The header is a plain regex built from the grammar above (write it once,
  export it as `MESSAGE_START` for tests). `D` is ASCII `[0-9]` only.
- `REST` with a `SENDER` is a message; `REST` without one is a system
  notice (encryption banner, joins, subject changes, missed calls) and is
  skipped — it has no author and would only add a capture note per notice
  to the review queue. Skipped notices are not counted anywhere; the
  README says so.
- A line that is not a MESSAGE START is a continuation of the previous
  message: appended with `"\n"`, verbatim except CR normalization
  (`readBoundedUtf8`). Leading MARKs are stripped from every line;
  trailing whitespace is kept. A continuation line before the first
  START is skipped.
- A file with zero START lines → `parse_error` "not a WhatsApp chat
  export (no timestamped line found)". A file with START lines but only
  notices → `{ events: [] }`, not an error.
- A message whose text exceeds `MAX_RECORD_BYTES` → `parse_error` naming
  the line; more than `MAX_RECORDS` messages → `parse_error`.
- Known limitation, stated in the README: a continuation line that itself
  begins with a timestamp pattern splits the message (every WhatsApp
  parser shares this).

### 2.4 Date order (`dates.ts`)

```ts
export interface RawDate {
  a: number;
  b: number;
  c: number;
  wide_first: boolean;
} // as written, left to right
export function detectDateOrder(dates: readonly RawDate[]): DateOrder;
```

- `wide_first` (4-digit first field) on any line ⇒ `ymd`; mixed with
  non-wide lines ⇒ `parse_error` "inconsistent date formats".
- Otherwise evidence: any `a > 12` ⇒ `dmy`; any `b > 12` ⇒ `mdy`; both
  ⇒ `parse_error` "inconsistent dates". No evidence ⇒ evaluate both
  hypotheses over the whole file: the one under which the sequence of
  local timestamps is non-decreasing wins; both or neither monotone ⇒
  `parse_error` `ambiguous date order (DD/MM vs MM/DD); set date_order to
"dmy" or "mdy"`. (An export is chronological, so this decides every
  real chat longer than twelve days; a short ambiguous chat gets an
  actionable refusal instead of a silent guess.)
- `config.date_order` skips detection; a date invalid under it (month 13,
  day 32, Feb 30 — use a real calendar check like
  `packages/core/src/util/time.ts` does) ⇒ `parse_error` naming the line.
- Two-digit years are `2000 + yy`. 12-hour times: `12 AM` → `00`, `12 PM`
  → `12`, hour `> 12` with a meridiem ⇒ `parse_error`. Seconds kept when
  present. Result: `local_timestamp` as in §2.2.

### 2.5 Time zone → `occurred_at` (`dates.ts`)

```ts
export function resolveTimezone(value: string | undefined): string;
// undefined → Intl.DateTimeFormat().resolvedOptions().timeZone; /^[+-]\d{2}:\d{2}$/ → as is (hours ≤ 14, minutes ≤ 59);
// otherwise must construct new Intl.DateTimeFormat("en-US", { timeZone: value }) without RangeError → returns value; else misconfigured
export function localToUtc(local_timestamp: string, timezone: string): string; // RFC3339 with milliseconds ("....000Z")
```

Fixed offset: arithmetic. IANA zone: two-pass resolution with
`Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year, month,
day, hour, minute, second: "2-digit" }).formatToParts` — guess `Date.UTC(parts)`,
compute the zone's offset at the guess, re-apply, compute once more; when
the two offsets differ (a DST transition) take the earlier instant for a
repeated wall-clock hour and shift a non-existent wall-clock hour forward
by the gap. Deterministic on any host with the same tz database; the host
default zone is recorded in `metadata.timezone` so a later reader knows
what was assumed. Two machines in different zones importing the same
export produce different `occurred_at` and hence different rows — stated
in the README; pass `timezone` for a portable result.

### 2.6 Media (`media.ts`)

```ts
export type MediaLookup = (
  filename: string,
) => Promise<{ byte_size: number } | null>;
export interface MediaRef {
  kind: "file" | "omitted";
  filename: string | null;
}
export function detectMedia(text: string): MediaRef | null;
export function fsMediaLookup(mediaDir: string): MediaLookup; // safeFilename(name) === null → null; else statRegularFile(join(mediaDir, name))
export function mapMediaLookup(
  files: Readonly<Record<string, string>>,
): MediaLookup; // fixture/tests: Buffer.byteLength(files[name])
```

`detectMedia` runs on the FIRST line of a message only, after MARK
stripping and trimming:

- Attached file (Android): `^(?<name>[^\s<>/\\]+\.[A-Za-z0-9]{1,5})\s\([^()]{1,40}\)$`
  (`IMG-20260104-WA0001.jpg (file attached)`, and the localized
  parentheticals: the phrase is not matched by word, only by shape).
- Attached file (iOS): `^<[^<>:]{1,40}:\s*(?<name>[^\s<>/\\]+\.[A-Za-z0-9]{1,5})>$`
  (`<attached: 00000002-PHOTO-2026-01-04-09-16-30.jpg>`, `<pièce jointe : …>`, `<Anhang: …>`).
- Omitted (export without media): `^<[^<>]{1,40}>$` (`<Media omitted>`,
  `<Multimedia omitido>`, `<Médias omis>`) or `^\S{1,20} omitted$` (`image
omitted`, `sticker omitted`, `GIF omitted`).

A `file` match becomes an attachment ONLY when the lookup finds a regular
file: `{ attachment_id: name, media_type: mediaTypeFor(name), filename:
name, byte_size }`. A name that fails `safeFilename` or is absent yields no
attachment and no error (the text line stays verbatim; a "with media"
export whose media folder was not copied simply has no refs). Media bytes
are never opened. `metadata.media` records `"file" | "omitted" | null` and
`metadata.filename` the matched name or `null` (both hashed: they are part
of what the message is).

### 2.7 Event mapping (`map.ts`)

| field              | value                                                                                                                                                                                                                                                           |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `connector_id`     | `kizuki.import-whatsapp`                                                                                                                                                                                                                                        |
| `source_record_id` | `` `${local_timestamp}/${sha256(sender + "\n" + text).slice(0, 16)}/${n}` `` — `n` = 1-based occurrence of the identical `(local_timestamp, sender, text)` triple in file order                                                                                 |
| `kind`             | `"message"`                                                                                                                                                                                                                                                     |
| `occurred_at`      | `localToUtc(local_timestamp, timezone)`                                                                                                                                                                                                                         |
| `observed_at`      | `opts.observed_at` (one per batch)                                                                                                                                                                                                                              |
| `text`             | the message text (§2.3), verbatim                                                                                                                                                                                                                               |
| `subjects`         | `[{ subject_id: senderId, role: "from", display_name: sender }, { subject_id: "whatsapp:chat:" + subjectSlug(chat), role: "about", display_name: chat }]`; `senderId` = `"whatsapp:self"` when `sender === opts.self`, else `"whatsapp:" + subjectSlug(sender)` |
| `sensitivity_hint` | `"private"`                                                                                                                                                                                                                                                     |
| `deleted`          | `false`, always                                                                                                                                                                                                                                                 |
| `attachments`      | `[ref]` per §2.6 or `[]`                                                                                                                                                                                                                                        |
| `metadata`         | `{ chat, sender, local_timestamp, timezone, media, filename }` — no line numbers, no positions (they move when a longer export is taken)                                                                                                                        |

WhatsApp has no message ids, so the id above is content-derived: stable
across exports regardless of position, and different for a message that
was edited between exports (a new version, §0.3). Limitation stated in the
README: an export "with media" and one "without media" name the same photo
message differently (`IMG… (file attached)` vs `<Media omitted>`), so the
two exports store it twice; and identical text from the same sender in
the same minute relies on `n`, which a partial export can renumber.

`chatNameFromFile(txt)`: `config.chat` wins; else the file stem; an English
stem `WhatsApp Chat with <name>` yields `<name>`; the iOS stem `_chat`
yields the parent directory's basename. Only the English prefix is
recognized; other locales keep the stem (readable, and overridable).

The chat name is part of every event's `subjects` and `metadata`, both
hashed: the same chat exported under a different file name (Android vs
iOS, or a renamed contact) keeps its `source_record_id`s but re-stores
each message as a new version (same record, new `content_hash`; the
capture-note proposal dedupes on its identical body, only the new chat
subject gets a fresh entity candidate). Pass `chat` to pin the name; the
README states this.

### 2.8 Connector and fixture (`index.ts`)

- `health()`: `resolveExport` ok → `ok`; any `KizukiError` → `misconfigured`
  with the error message as `detail` (these messages name the configured
  path only, §0.6).
- `backfill(_)` / `sync(_)`: `resolveExport` → `readBoundedUtf8(txt)` →
  `parseWhatsAppExport(text, { date_order, timezone, self, chat:
chatNameFromFile(txt), observed_at: now, media: fsMediaLookup(mediaDir) })`
  → `{ events, cursor: null }`.
- `purgeSource(subject_id)`: same parse; plan per §0.4.
- `fixture()`: `parseWhatsAppExport(WHATSAPP_FIXTURE_FILES["WhatsApp Chat with Acme Planning.txt"],
{ timezone: WHATSAPP_FIXTURE_TIMEZONE, chat: "Acme Planning", observed_at:
FIXTURE_OBSERVED_AT, media: mapMediaLookup(WHATSAPP_FIXTURE_FILES) })` —
  no disk, no config.

`WHATSAPP_FIXTURE_FILES` has exactly two entries. The chat file (Android
format, `mdy` decided by evidence on line 10, one U+202F before a meridiem,
one multi-line message, one identical-pair `n = 2`, one attached file that
exists, one omitted media, one system notice, `12:00 AM`):

```
1/4/26, 9:15 AM - Messages and calls are end-to-end encrypted. No one outside of this chat can read or listen to them.
1/4/26, 9:15 AM - Ada: Morning all. Planning for the acme launch starts today.
1/4/26, 9:16 AM - Grace: Morning! Two things:
- venue
- budget
1/4/26, 9:16 AM - Linus: ok
1/4/26, 9:16 AM - Linus: ok
1/4/26, 9:20 AM - Ada: IMG-20260104-WA0001.jpg (file attached)
1/4/26, 9:21 AM - Grace: <Media omitted>
1/13/26, 6:05<U+202F>PM - Linus: Venue booked for the 20th. Café Kōan, 18:00.
2/1/26, 12:00 AM - Ada: Reminder: budget review at noon.
```

and `IMG-20260104-WA0001.jpg` = `fixture-bytes-not-an-image` (26 bytes).
`fixture()` therefore returns exactly 8 events; the first has
`occurred_at "2026-01-04T09:15:00.000Z"`, the multi-line one has text
`"Morning! Two things:\n- venue\n- budget"`, the two `ok` messages differ
only in the trailing `/1` and `/2`, the photo event carries one attachment
`{ attachment_id: "IMG-20260104-WA0001.jpg", media_type: "image/jpeg",
filename: "IMG-20260104-WA0001.jpg", byte_size: 26 }`, the omitted one has
`metadata.media === "omitted"` and no attachment, the U+202F line parses to
`2026-01-13T18:05:00.000Z`, and the last to `2026-02-01T00:00:00.000Z`.

## 3. Pocket CSV export (`src/import-pocket/`)

Format facts: the final Pocket data export (the service closed in 2025; no
API remains, so this is an importer by necessity) is a zip of one or more
`part_NNNNNN.csv` files with the header `title,url,time_added,tags,status`
— `time_added` unix seconds, `tags` separated by `|`, `status` `unread` or
`archive`. The parser is header-driven, so column order does not matter:
`url` and `time_added` are required columns; `title`, `tags`, `status`
optional; other columns are ignored and not persisted. A file whose
header lacks `url` or `time_added` (the older `ril_export.html`, or any
other CSV) → `parse_error` "not a Pocket CSV export".

### 3.1 Config and API

```ts
export const POCKET_IMPORT_CONNECTOR_ID = "kizuki.import-pocket" as const;
export interface PocketImportConfig {
  path: string;
} // a .csv file, or a directory holding part_*.csv (all parsed, names sorted with compareStrings)
export interface PocketRow {
  title: string;
  url: string;
  time_added: string;
  tags: string[];
  status: string;
}
export function parsePocketCsv(text: string, where: string): PocketRow[]; // where = file basename for error messages
export function pocketEvents(
  rows: readonly PocketRow[],
  observed_at: string,
): CaptureEventInput[];
export class PocketImportConnector implements Connector {
  constructor(config: PocketImportConfig);
}
export function createPocketImportConnector(
  config: PocketImportConfig,
): PocketImportConnector;
export const POCKET_FIXTURE_EXPORT: string; // §3.4
```

A `.zip` path → `misconfigured` "unzip the export first"; a directory with
no `*.csv` → `misconfigured`. `health()`: `ok` when the path resolves to
≥ 1 readable CSV, else `misconfigured`.

### 3.2 CSV reader (`csv.ts`)

```ts
export interface CsvOptions {
  maxFieldBytes?: number /* MAX_RECORD_BYTES */;
  maxRows?: number; /* MAX_RECORDS */
}
export function parseCsv(
  text: string,
  where: string,
  opts?: CsvOptions,
): string[][];
```

RFC 4180: fields split on `,`; a field starting with `"` is quoted, `""`
inside is one quote, and CR/LF inside quotes are part of the field; rows
end at LF (CRLF already normalized); a trailing newline is optional; an
empty line between rows is skipped; a leading BOM was stripped upstream.
Errors (`parse_error`, naming `where` and the 1-based row): unterminated
quote; a quote in the middle of an unquoted field; a field over
`maxFieldBytes`; more than `maxRows` rows. The caller checks that every
row has the header's column count (`parse_error` naming the row).

### 3.3 Event mapping

| field              | value                                                                                                                                           |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `source_record_id` | `url` (trimmed; > 4096 chars ⇒ `parse_error` naming the row); the 2nd, 3rd… identical url gets `#2`, `#3`                                       |
| `kind`             | `"bookmark"`                                                                                                                                    |
| `occurred_at`      | `unixSecondsToIso(time_added, "<file> row <n>")`                                                                                                |
| `text`             | `title` non-empty ? `` `${title}\n${url}` `` : `url`                                                                                            |
| `subjects`         | `[{ subject_id: "pocket:self", role: "from" }]`                                                                                                 |
| `sensitivity_hint` | `"personal"`                                                                                                                                    |
| `deleted`          | `false`                                                                                                                                         |
| `attachments`      | `[]`                                                                                                                                            |
| `metadata`         | `{ title, url, tags: string[] (split on "\|", trimmed, empties dropped), status }` (`status` is what the export said, verbatim, "" when absent) |

Rows with an empty `url` ⇒ `parse_error` naming the row (a bookmark
without a URL is not a record). Order = file order across files.

### 3.4 Fixture

`POCKET_FIXTURE_EXPORT` (a quoted title with a comma, a doubled quote, a
`|` tag list, an empty tags field, an `archive` row, one duplicate url):

```
title,url,time_added,tags,status
"Local-first software, explained",https://example.com/local-first,1767225600,software|reading,unread
Quartz heron field notes,https://example.com/heron,1767312000,,archive
"A ""quoted"" title",https://example.com/quoted,1767398400,notes,unread
Quartz heron field notes,https://example.com/heron,1767484800,birds,unread
```

`fixture()` = `pocketEvents(parsePocketCsv(POCKET_FIXTURE_EXPORT, "fixture"),
FIXTURE_OBSERVED_AT)`: 4 events, ids `https://example.com/local-first`,
`https://example.com/heron`, `https://example.com/quoted`,
`https://example.com/heron#2`; the first `occurred_at` is
`2026-01-01T00:00:00.000Z`; the third text is `A "quoted" title\nhttps://example.com/quoted`.

## 4. Omnivore export folder (`src/import-omnivore/`)

Format facts: Omnivore's data export (the service closed in 2024) is a zip
holding `metadata_<from>_to_<to>.json` files — each a JSON array of item
objects with `id`, `slug`, `title`, `description`, `author`, `url`,
`state`, `readingProgress`, `thumbnail`, `labels`, `savedAt`, `updatedAt`,
`publishedAt` — plus `content/<slug>.html` (the saved article) and
`highlights/<slug>.md` (the owner's highlights and notes, rendered as
Markdown). The brief scopes this importer to json + md; `content/*.html`
becomes an attachment reference only (§Non-goals).

### 4.1 Config and API

```ts
export const OMNIVORE_IMPORT_CONNECTOR_ID = "kizuki.import-omnivore" as const;
export interface OmnivoreImportConfig {
  path: string;
} // the unzipped export directory
export interface OmnivoreItem {
  id: string;
  slug: string;
  title: string;
  description: string;
  author: string;
  url: string;
  state: string;
  labels: string[];
  saved_at: string;
  published_at: string | null;
}
export interface OmnivoreFiles {
  // what the parser needs, so it runs from memory (fixture) or disk (connector)
  metadata: { name: string; text: string }[]; // sorted by name (compareStrings)
  highlight(slug: string): Promise<string | null>; // highlights/<slug>.md text or null
  content(slug: string): Promise<{ byte_size: number } | null>; // content/<slug>.html size or null
}
export function parseOmnivoreMetadata(
  text: string,
  where: string,
): OmnivoreItem[];
export function omnivoreEvents(
  files: OmnivoreFiles,
  observed_at: string,
): Promise<CaptureEventInput[]>;
export function fsOmnivoreFiles(dir: string): Promise<OmnivoreFiles>;
export function mapOmnivoreFiles(
  files: Readonly<Record<string, string>>,
): OmnivoreFiles;
export class OmnivoreImportConnector implements Connector {
  constructor(config: OmnivoreImportConfig);
}
export function createOmnivoreImportConnector(
  config: OmnivoreImportConfig,
): OmnivoreImportConnector;
export const OMNIVORE_FIXTURE_FILES: Readonly<Record<string, string>>; // §4.5
```

`fsOmnivoreFiles(dir)`: `lstat(dir)` must be a directory (symlink →
`misconfigured`); a `.zip` path → "unzip the export first"; metadata files
= top-level regular files matching `/^metadata_\d+_to_\d+\.json$/`, each
read with `readBoundedUtf8`; zero such files → `misconfigured` "no
metadata_*.json in <dir>". `highlight(slug)` / `content(slug)` require
`/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(slug)` (else `null`: the slug is
captured text and must never reach the filesystem otherwise) and use
`join(dir, "highlights", slug + ".md")` via `readBoundedUtf8` (a missing
file is `null`; a symlink is `null`) and `join(dir, "content", slug +
".html")` via `statRegularFile`.

### 4.2 Metadata parsing

`parseOmnivoreMetadata(text, where)`: `parseJsonArray` (existing) then per
element: not a plain object ⇒ skipped; `id` and `slug` must be non-empty
strings (`parse_error` `${where}[${index}]: id and slug are required`);
`title`, `description`, `author`, `url`, `state` default `""` when absent
or not strings; `labels` = strings, or objects with a string `name`,
anything else dropped; `saved_at` = `isoToRfc3339(savedAt, "<where>[<i>].savedAt")`
(required); `published_at` = `isoToRfc3339` when present and valid, else
`null`. More than `MAX_RECORDS` items across files ⇒ `parse_error`.

### 4.3 Event mapping

| field              | value                                                                                                                                                            |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `source_record_id` | `id`                                                                                                                                                             |
| `kind`             | `"bookmark"`                                                                                                                                                     |
| `occurred_at`      | `saved_at`                                                                                                                                                       |
| `text`             | non-empty parts of `[title, url, description, highlights]` joined with `"\n\n"`; `highlights` = the `highlights/<slug>.md` text with trailing whitespace trimmed |
| `subjects`         | `[{ subject_id: "omnivore:self", role: "from" }]`                                                                                                                |
| `sensitivity_hint` | `"personal"`                                                                                                                                                     |
| `deleted`          | `false`                                                                                                                                                          |
| `attachments`      | `[{ attachment_id: "content", media_type: "text/html", filename: "content/<slug>.html", byte_size }]` when `content(slug)` is non-null, else `[]`                |
| `metadata`         | `{ title, url, author, state, labels, published_at, has_highlights: boolean }` — `updatedAt`, `readingProgress`, `thumbnail` excluded (volatile, §0.3)           |

Duplicate `id` across metadata files ⇒ the later occurrence gets `#2`,
`#3` on `source_record_id` (same rule as Pocket), so a doubled export
cannot collapse two records.

### 4.4 Connector

`health()`: `ok` when `fsOmnivoreFiles` resolves, else `misconfigured`.
`backfill`/`sync`: `omnivoreEvents(await fsOmnivoreFiles(dir), now)` →
`{ events, cursor: null }`. `purgeSource`: same parse, plan per §0.4.
`fixture()`: `omnivoreEvents(mapOmnivoreFiles(OMNIVORE_FIXTURE_FILES), FIXTURE_OBSERVED_AT)`.

### 4.5 Fixture

`OMNIVORE_FIXTURE_FILES` — four entries:

- `metadata_0_to_3.json`: three items, ids `a1b2c3d4-0000-4000-8000-000000000001..3`,
  slugs `local-first-software`, `quartz-heron-notes`, `acme-launch-plan`,
  titles `Local-first software`, `Quartz heron notes`, `Acme launch plan`,
  urls `https://example.com/<slug>`; the first with `description: "Why
data should live on the owner's disk."`, `labels: ["software",
"reading"]`, `state: "Active"`, `savedAt: "2026-01-01T09:00:00Z"`,
  `publishedAt: "2025-12-30T00:00:00Z"`, `author: "grace"`; the second
  `description: "Field notes on a quartz heron."`, `state: "Archived"`, one
  label given as `{ "name": "birds" }`, `savedAt` with an offset
  (`"2026-01-02T10:00:00+02:00"` → `2026-01-02T08:00:00.000Z`); the third
  with an empty `description`, no `publishedAt`, no highlights, no content,
  `savedAt: "2026-01-03T09:00:00Z"`. (No fixture text in this lane
  contains the word `budget` outside the WhatsApp chat: the acceptance
  `query` count depends on it.)
- `highlights/local-first-software.md`:
  `## Highlights\n\n> Data stays under your control.\n\nNote: relevant for acme.\n`
- `content/local-first-software.html`: `<html><body><p>fixture</p></body></html>`
- `content/quartz-heron-notes.html`: `<html><body><p>heron</p></body></html>`

`fixture()` returns 3 events: the first text ends with `Note: relevant for
acme.` and has one attachment with `byte_size` = the HTML length and
`metadata.has_highlights === true`; the second has an attachment and no
highlights; the third has neither.

## 5. Registry and exports

- `src/registry.ts`: import the three ids, factories and config types; add
  the three `REGISTRY` entries (after `CLAUDE_IMPORT_CONNECTOR_ID`, in the
  order whatsapp, pocket, omnivore), one `getConnector` overload per
  connector, and the three `case` arms. Add the entries LAST, after the
  conformance suite passes (connectors AGENTS.md).
- `src/index.ts`: re-export every exported name in §2.2, §3.1, §4.1 plus
  `WHATSAPP_FIXTURE_FILES`, `WHATSAPP_FIXTURE_TIMEZONE`,
  `POCKET_FIXTURE_EXPORT`, `OMNIVORE_FIXTURE_FILES`, and from `util.ts`
  `FIXTURE_OBSERVED_AT`, `MAX_EXPORT_BYTES`, `MAX_RECORDS`,
  `MAX_RECORD_BYTES`, `subjectSlug`, `safeFilename`, `mediaTypeFor`,
  `parseCsv`.
- `packages/core/src/index.ts` is untouched (`packages/core/test/index.test.ts`
  keeps its exact list).

## 6. Documentation (`packages/connectors/README.md`, NEW)

One page, plain language, no person, host or vendor names beyond the
three source products and the fixture names (the README is under
`bun run verify`'s denylist and attribution gates): a table of the six
registry entries (`markdown-folder`, `import-chatgpt`, `import-claude`,
`import-whatsapp`, `import-pocket`, `import-omnivore`) with one line each
saying what it reads and whether it is a live source or a snapshot
importer; then a section per importer from this lane: how to obtain the
export, "unzip it first", the exact `ingest` line that works on main, and
the limitations verbatim from §0.3 (no deletions inferred; purge is the
owner's), §2.3 (system notices skipped, continuation-line split), §2.5
(no zone in the export; host zone assumed; `timezone` for portability),
§2.7 (with/without-media exports differ), §3 (final CSV format only),
§4 (content HTML as a reference only; no per-highlight ids, highlights
travel inside the item text). State that the WhatsApp Business API and
Composio are deferred and that no importer is a live sync. Run the
humanizer pass; claim nothing that does not run.

## 7. Tests

`packages/connectors/test/` (bun:test; `mkdtemp` under `os.tmpdir()`,
removed in `finally`; fixtures synthetic — ada, grace, linus, acme):

- `whatsapp.test.ts`
  - `fixture()` returns exactly the 8 events of §2.8 (assert ids, texts,
    `occurred_at`, subjects with `display_name`, the attachment, the
    `omitted` metadata, `sensitivity_hint: "private"`, `deleted: false`);
    every event passes `validateEventInput`.
  - iOS format: `[04/01/2026, 09:15:00] Ada: Morning all.` +
    `[13/01/2026, 09:16:30] Grace: ‎<attached: 00000002-PHOTO-2026-01-04-09-16-30.jpg>`
    with the media file present → `dmy` by evidence, seconds kept, one
    attachment, MARK stripped from the text.
  - Multi-line message assembly; a continuation line before the first
    START is dropped; CRLF input equals LF input event-for-event.
  - System notices skipped; a notice-only file yields `[]`; a file with
    no START line throws `parse_error` naming the reason.
  - `self` config maps that sender to `whatsapp:self`; `chat` override;
    `chatNameFromFile` for `WhatsApp Chat with Acme Planning.txt`,
    `_chat.txt` (parent dir name) and `export.txt` (stem).
  - Media safety: an attached-file line naming `../../etc/passwd`, `a/b.jpg`
    and a name that is a symlink in the media dir yields no attachment and
    no error; a regular file yields `byte_size`; bytes are never read (the
    lookup receives only a size).
  - Directory resolution: dir with one `.txt` ok; zero and two `.txt`
    files → `misconfigured` with the documented messages; a `.zip` path →
    "unzip the export first"; a symlinked chat file → `misconfigured`;
    `health()` mirrors each case and never throws.
  - Bounds: a message over `MAX_RECORD_BYTES` → `parse_error` naming the
    line; a file over a test-lowered `maxBytes` → `misconfigured` before
    reading (assert via a large sparse file or by calling
    `readBoundedUtf8` with `maxBytes: 16`).
  - Redaction: every thrown message across the failure cases above and
    every `health().detail` contains neither a sender name nor message
    text from the input (assert against a distinctive token planted in
    the fixture).
  - Unknown config key → `misconfigured` at construction.
- `whatsapp-dates.test.ts`
  - `detectDateOrder`: `a > 12` ⇒ dmy; `b > 12` ⇒ mdy; wide first ⇒ ymd;
    both `> 12` ⇒ `parse_error`; no evidence + monotone under one
    hypothesis ⇒ that one; no evidence + both monotone ⇒ `parse_error`
    with the exact "ambiguous date order" message; `date_order` config
    wins and an invalid date under it (`31/04/2026`, `29/02/2027`) throws
    naming the line.
  - 12-hour: `12:00 AM` → `00:00`, `12:30 PM` → `12:30`, `6:05 PM` →
    `18:05`, `13:00 PM` → `parse_error`; `p. m.`, `a.m.`, `pm`, U+202F and
    U+00A0 separators all parse; two-digit and four-digit years.
  - `resolveTimezone`: `undefined` → the host zone string; `+02:00`
    accepted; `+15:00`, `Not/AZone`, `""` → `misconfigured`.
  - `localToUtc`: fixed offset arithmetic; `Europe/Berlin` summer
    (`2026-07-01T10:00` → `08:00Z`) and winter (`2026-01-01T10:00` →
    `09:00Z`); the repeated hour on `2026-10-25T02:30` → the earlier
    instant (`00:30Z`); the skipped hour on `2026-03-29T02:30` → `01:30Z`;
    `America/New_York` one case; output always ends in `.000Z`.
- `pocket.test.ts`: `fixture()` equals §3.4 exactly; a directory with
  `part_000000.csv` + `part_000001.csv` parses both in name order; header
  in a different column order works; a header without `url` →
  `parse_error` "not a Pocket CSV export"; `ril_export.html` bytes → the
  same; an empty `url` row, an invalid `time_added`, a row with a
  different column count → `parse_error` naming the row and never quoting
  the title; `tags` split and trimmed; duplicate urls numbered; `.zip`
  path refused; unknown config key refused; every event passes
  `validateEventInput`.
- `csv.test.ts`: RFC 4180 vectors — quoted comma, doubled quote, embedded
  LF inside quotes, CRLF rows, trailing newline present/absent, blank line
  skipped, empty trailing field; unterminated quote → `parse_error` with
  the row number; stray quote mid-field → `parse_error`; `maxFieldBytes`
  and `maxRows` enforced.
- `omnivore.test.ts`: `fixture()` equals §4.5 exactly (ids, text joins,
  attachment sizes, `has_highlights`, labels from strings and objects,
  offset normalization of `savedAt`); metadata files parse in
  `compareStrings` order; an item without `id`/`slug` or with an invalid
  `savedAt` → `parse_error` naming file and index, never the title; a
  slug `../x`, `a/b` or one that is a symlink target yields no highlight
  and no attachment, and no path outside the export dir is touched (assert
  with a canary file one level up); duplicate ids numbered; `updatedAt`
  and `readingProgress` absent from `metadata`; `.zip` refused; no
  `metadata_*.json` → `misconfigured`; unknown config key refused.
- `importers-tombstones.test.ts` (the §0.3 proof, all three connectors,
  through core): `openLedger(":memory:")` + `initStaging`; write export A
  (the fixture) to a temp dir and `runBackfill(db, connector, id, "src")`
  → `stored === N`, `proposals_created > 0`; write export B = a strict
  subset (WhatsApp: the last 3 messages only; Pocket: rows 2–3; Omnivore:
  one metadata file with item 2 only) over the same path and
  `runSync(db, connector, id, "src")` → `{ stored: 0, duplicates: |B|,
withdrawn: 0, retractions_filed: 0, errors: [] }`, `[...replay(db, {})]`
  has no `deleted: true` row and still `N` rows; then export A again →
  all duplicates. And the reverse: B first, then A → `stored === N - |B|`,
  and the overlapping records keep their `source_record_id`. Plus: Pocket
  row with `status` changed `unread → archive` re-imported → one new row,
  same `source_record_id`, different `content_hash`, the old row
  untouched.
- `conformance.test.ts` (extend "all registry connectors pass
  conformance"): write `WHATSAPP_FIXTURE_FILES`, `POCKET_FIXTURE_EXPORT`
  and `OMNIVORE_FIXTURE_FILES` into the temp root; build the three via
  `getConnector` (`{ path, timezone: "+00:00" }` for WhatsApp so the double
  backfill is host-independent) and assert `{ pass: true, failures: [] }`
  for each. Add a test that iterates `Object.keys(REGISTRY)` and asserts
  every key was exercised by the suite in this file (the count is derived,
  never a literal — plan §3.1).
- `registry.test.ts` (extend): `getConnector` builds each of the three by
  id and the manifest `connector_id` matches; `getConnector(id, {})`
  without `path` → `misconfigured` for each.
- Existing tests (`chatgpt`, `claude`, `markdown-folder`) unchanged and
  green.

## Acceptance

```
bun run typecheck                                                       # exit 0
bun test                                                                # green; ≥ 580 tests (515 on main today), ≥ 65 in packages/connectors/test
bun test packages/connectors/test/conformance.test.ts                   # green; six registry ids exercised
bun test packages/connectors/test/importers-tombstones.test.ts          # green; the §0.3 proof for all three importers
bun -e 'import { REGISTRY } from "./packages/connectors/src/index.ts"; console.log(Object.keys(REGISTRY).sort().join(" "))'
                                                                        # kizuki.import-chatgpt kizuki.import-claude kizuki.import-omnivore kizuki.import-pocket kizuki.import-whatsapp kizuki.markdown-folder
bun -e 'import { getConnector, WHATSAPP_IMPORT_CONNECTOR_ID, POCKET_IMPORT_CONNECTOR_ID, OMNIVORE_IMPORT_CONNECTOR_ID } from "./packages/connectors/src/index.ts"; for (const id of [WHATSAPP_IMPORT_CONNECTOR_ID, POCKET_IMPORT_CONNECTOR_ID, OMNIVORE_IMPORT_CONNECTOR_ID]) { const c = getConnector(id, { path: "/nonexistent" }); const m = c.manifest(); console.log(id, JSON.stringify(m.capabilities), JSON.stringify(m.auth_modes), (await c.fixture()).length) }'
                                                                        # three lines, each: <id> {"backfill":true,"sync":true,"tombstones":false,"purge":true,"fixture":true} ["none"] <n>  with n = 8, 4, 3
                                                                        # (construction validates config without touching the path; manifest() and fixture() do no I/O)
bun -e 'import { getConnector, POCKET_IMPORT_CONNECTOR_ID } from "./packages/connectors/src/index.ts"; try { await getConnector(POCKET_IMPORT_CONNECTOR_ID, { path: "/nonexistent" }).purgeSource("pocket:self") } catch (e) { console.log(e.name, e.code) }'
                                                                        # KizukiError misconfigured  (a plan that cannot be computed is refused, §0.4)
bun -e 'import { getConnector, WHATSAPP_IMPORT_CONNECTOR_ID } from "./packages/connectors/src/index.ts"; try { getConnector(WHATSAPP_IMPORT_CONNECTOR_ID, { path: "/x", timezone: "Not/AZone" }) } catch (e) { console.log(e.code) }; try { getConnector(WHATSAPP_IMPORT_CONNECTOR_ID, { path: "/x", tz: "+02:00" }) } catch (e) { console.log(e.code) }'
                                                                        # misconfigured
                                                                        # misconfigured  (unknown key refused, §0.1)
T=$(mktemp -d) && bun packages/cli/src/main.ts init $T/vault >/dev/null && mkdir $T/wa $T/om && \
  bun -e 'import { WHATSAPP_FIXTURE_FILES, OMNIVORE_FIXTURE_FILES, POCKET_FIXTURE_EXPORT } from "./packages/connectors/src/index.ts"; const T = process.argv[1]; for (const [n, c] of Object.entries(WHATSAPP_FIXTURE_FILES)) await Bun.write(`${T}/wa/${n}`, c); for (const [n, c] of Object.entries(OMNIVORE_FIXTURE_FILES)) await Bun.write(`${T}/om/${n}`, c); await Bun.write(`${T}/pocket.csv`, POCKET_FIXTURE_EXPORT)' "$T"
bun packages/cli/src/main.ts ingest kizuki.import-whatsapp --vault $T/vault --source $T/wa      # events_stored=8 duplicates=0 proposals_created=… withdrawn=0 retractions_filed=0
bun packages/cli/src/main.ts ingest kizuki.import-whatsapp --vault $T/vault --source $T/wa      # events_stored=0 duplicates=8 proposals_created=0 withdrawn=0 retractions_filed=0
bun packages/cli/src/main.ts ingest kizuki.import-pocket --vault $T/vault --source $T/pocket.csv   # events_stored=4 …
bun packages/cli/src/main.ts ingest kizuki.import-omnivore --vault $T/vault --source $T/om     # events_stored=3 …
mkdir $T/wa2 && sed -n '10,11p' "$T/wa/WhatsApp Chat with Acme Planning.txt" > "$T/wa2/WhatsApp Chat with Acme Planning.txt" && \
  bun packages/cli/src/main.ts ingest kizuki.import-whatsapp --vault $T/vault --source $T/wa2  # a two-message export of the same chat (same file name, so the same chat subject; line 10 carries the mdy evidence): events_stored=0 duplicates=2 proposals_created=0 withdrawn=0 retractions_filed=0 (smaller export deletes nothing)
bun packages/cli/src/main.ts doctor --vault $T/vault | grep -c 'retraction-pending'            # 0
bun packages/cli/src/main.ts query 'budget' --vault $T/vault | grep -c '^event '               # 2 (main's query serves ledger events by substring: the multi-line message and the reminder)
bun run scripts/verify-network.ts                                       # "network source verification passed"
git diff --stat main..HEAD -- '*/package.json' bun.lock | cat            # empty: no dependency change anywhere
git ls-files packages/connectors | grep -c README.md                    # 1
bun run verify                                                          # exit 0 (typecheck, tests, policy tests, network scan, dependency grep, denylist over tracked text and reachable commit messages)
git status --porcelain                                                  # empty
```
