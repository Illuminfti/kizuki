# Lane: connector-screenpipe — a read-only adapter over the screenpipe local database

Reconciled against `main` @ `76930db` (2026-09-02). Every path, symbol and
flag below was grepped on that revision; anything not on main is marked NEW
with its intended location.

Package(s): NEW `packages/connector-screenpipe` (own workspace package, zero
runtime dependencies, `bun:sqlite` only), one registry entry in
`packages/connectors/src/registry.ts`, re-exports in
`packages/connectors/src/index.ts`, one workspace link in
`packages/connectors/package.json`, one case each in
`packages/connectors/test/conformance.test.ts` and
`packages/connectors/test/registry.test.ts`, and the package README. Nothing
in `packages/core` changes. Read, in order: `CONVENTIONS.md`;
`docs/architecture.md` (invariants 4, 6, 7, 8, 10 and the
`kizuki.connector/v1` paragraph); `rfcs/0000-constraints.md` §1, §5, §6;
`AGENTS.md`, `packages/connectors/AGENTS.md`;
`packages/core/src/contracts/connector.ts` (`Manifest`, `Connector`,
`SyncBatch`, `PurgePlan`, `HealthReport` — constructor-validated);
`packages/core/src/contracts/event.ts` (`CaptureEventInput`,
`validateEventInput`, `SubjectRef`, `AttachmentRef`);
`packages/core/src/util/hash.ts` (which fields feed `content_hash`:
`observed_at`, `attachments`, `sensitivity_hint` are excluded);
`packages/core/src/util/time.ts` (`isRfc3339`, the only timestamp validator
you may rely on); `packages/core/src/ingest/run.ts` (`runBackfill`/`runSync`
run exactly one batch per call and keep the previous cursor when
`errors.length > 0`); `packages/core/src/staging/producers.ts` (the floor
mints one entity candidate per distinct `subject_id` and one capture note per
event — this drives the subject design in §7); `packages/core/src/ledger/
purge.ts` (`PurgeFilter` is `event_id | connector_id | subject_handle`, the
latter matching `subject_id` exactly); `packages/connectors/src/
{conformance,registry,index,util,errors}.ts` and
`packages/connectors/src/markdown-folder/index.ts` (the `auth_modes: ["none"]`,
`config: { path }` precedent this connector follows);
`packages/connectors/test/{conformance,markdown-folder,registry}.test.ts`
(test shape); `scripts/verify.sh` and `scripts/verify-network.ts` (the gate).
The fuller design is `workspace/kizuki-plan/ARCHITECTURE.md` §3.1 (the line
"Screenpipe = adapter over its local DB"; "Screenpipe = local database" under
sign-in), §3.2 (conformance), §2.1–2.2 (event contract and queue semantics),
§10 (security), §12 (gates). Where the plan and main disagree, main wins.

## Already on main (do not redo)

- `Connector` with `manifest / health / connect / backfill / sync / revoke /
purgeSource / fixture`; `auth_modes: ["none"]` connectors take a plain
  `{ path }` config and ignore the `SecretResolver` (`markdown-folder`).
- The CLI host contract for `none`-mode connectors (cli-verbs §3, NEW there,
  not on main): `kizuki connect <connector> --source PATH` builds
  `getConnector(id, { path })`, calls `connect(refuseSecrets)` then
  `health()`, and enrolls only on state `ok`; `backfill`/`sync`/`doctor`
  rebuild the connector from the 0600 host state file with exactly
  `{ path }`. `resolveConnectorId("screenpipe")` → `kizuki.screenpipe`. This
  lane needs no CLI change; every option beyond `path` (§2) has a default.
- `HealthReport` throws at construction on an invalid state or timestamp, so
  every report this connector returns is a real instance.
- `RunResult.cursor` is persisted verbatim in `checkpoints.cursor`; the
  spine never parses it (`Cursor` is opaque).
- `bun:sqlite` on the pinned Bun (CI pins 1.3.10; `.bun-version` is added by
  ci-hardening) supports `new Database(path, { readonly: true, create: false,
safeIntegers: true })`. Verified on 1.3.14 (2026-09-02): a missing file
  throws `unable to open database file`; a write on a read-only handle throws
  `attempt to write a readonly database`; a non-database file opens but the
  first query throws `file is not a database`; `safeIntegers` returns
  `bigint` for INTEGER columns. Repeat the probe in Acceptance on 1.3.10
  before building on it.
- `scripts/verify-network.ts` scans every tracked file under `packages/` for
  `fetch`/`WebSocket`/`Bun.serve`/`node:net`…; this lane adds none of those
  names anywhere (screenpipe also exposes an HTTP API on localhost — it is
  deliberately NOT used; invariant 6).

## Provider facts this lane is built on (checked 2026-09-02)

Source: the screenpipe repository at commit `c758770e` (workspace version
`0.4.46`, desktop release `app-v2.7.12`, both dated 2026-09-01), crate
`crates/screenpipe-db` (116 sqlx migrations under `src/migrations/`, applied
in filename order into a fresh SQLite to derive the effective schema), and
the public architecture page (`docs.screenpipe.com/architecture`).

- **Location.** The database is a single SQLite file, by default
  `~/.screenpipe/db.sqlite`; media (JPEG snapshots, audio chunks) lives under
  `~/.screenpipe/data/` and is never read by this connector. screenpipe runs
  the database in WAL mode with a write queue; concurrent readers are the
  supported access pattern (`sqlite3 ~/.screenpipe/db.sqlite .schema` is the
  documented way to inspect it).
- **Migrations.** Applied with `sqlx::migrate!` into `_sqlx_migrations
(version BIGINT PRIMARY KEY, description TEXT, installed_on TIMESTAMP,
success BOOLEAN, checksum BLOB, execution_time BIGINT)`; `version` is the
  14-digit filename prefix. screenpipe runs the migrator with
  `set_ignore_missing(true)` and rewrites checksums when a shipped migration
  file changed, so the set of applied versions, not checksums, is the
  compatibility signal.
- **Where screen text lives.** Since migration `20260312000000`
  (2026-03-11, "consolidate search to frames.full_text") the single
  searchable text per frame is `frames.full_text`; since `20260613130000`
  ("unify ocr_text into frames", 2026-06-13) the `ocr_text` table is gone and
  `frames.text_json` holds per-word OCR boxes. `full_text` is
  accessibility-tree text, OCR text, or both joined by `\n` when
  `text_source = 'hybrid'` (`insert_snapshot_frame_with_ocr` in
  `db/frames.rs`). The OCR fallback lands AFTER the frame row exists:
  `insert_ocr_text` runs `UPDATE frames SET full_text = … WHERE id = ?`
  asynchronously, so a freshly inserted frame may gain text seconds later.
  That is why §8 has a settle window.
- **Frame columns read** (effective schema; `frames.id` is
  `INTEGER PRIMARY KEY AUTOINCREMENT`, never reused): `id, timestamp,
app_name, window_name, browser_url, device_name, focused, full_text,
text_source, capture_trigger, snapshot_path, document_path, video_chunk_id,
offset_index`. `video_chunk_id` is NULL for event-driven snapshot frames.
- **Audio.** `audio_transcriptions(id INTEGER PRIMARY KEY AUTOINCREMENT,
audio_chunk_id, offset_index, timestamp, transcription, device,
is_input_device, speaker_id, transcription_engine, start_time, end_time,
text_length, …)` with `UNIQUE(audio_chunk_id, transcription)`; rows are
  inserted complete (empty or duplicate transcriptions are never inserted).
  `start_time`/`end_time` are offsets in seconds from the row's `timestamp`
  (comment in `db/frames.rs`). `speakers(id, name, …)`; `name` may be NULL or
  `''` and is renamed by the user later. `audio_chunks(id, file_path,
timestamp, …)`.
- **Timestamps.** `frames.timestamp`, `audio_transcriptions.timestamp` and
  `audio_chunks.timestamp` are bound as `chrono::DateTime<Utc>` through sqlx
  0.9, which encodes `to_rfc3339_opts(SecondsFormat::AutoSi, false)`:
  `2026-01-15T10:30:00+00:00`, `…00.123+00:00`, `…00.123456+00:00` or nine
  fractional digits. Older databases may carry the legacy sqlx encodings the
  decoder still accepts (`%F %T%.f`, `%F %T%.fZ`, `%F %T%.f%:z`, `%F %R`).
  §5 normalizes exactly these forms and rejects everything else.
- **Redaction.** An optional PII worker overwrites `frames.full_text`,
  `frames.window_name`, `frames.browser_url`, `audio_transcriptions.
transcription` in place and stamps `*_redacted_at` (unix seconds). Text
  redacted after Kizuki read it is NOT re-read by this lane (§8, README).
- **Deletion.** screenpipe deletes rows itself (retention: `DELETE FROM
frames WHERE timestamp BETWEEN …`, the same statement a manual range delete
  uses) and evicts media (`evicted_at`) while keeping rows. Nothing
  distinguishes housekeeping from intent, and there is no per-row deletion
  log, so `tombstones: false` is the honest manifest (§8.1). Ledger purge
  is the remedy and works by subject or connector (§8.7).
- **Not captured** (exist in the schema, out of scope): `ui_events`
  (keystrokes, clipboard), `elements`, `memories`, `meetings`, `tags`,
  `outputs`, activity ledger and semantic tables, media files.

## Objective

`kizuki connect screenpipe --source ~/.screenpipe/db.sqlite` (the CLI verb
is cli-verbs'; this lane ships everything under it) opens the owner's
screenpipe database read-only, proves the schema is one this lane targets,
and enrolls. `backfill` walks every settled frame with text and every
transcription in id order as `private` events with the app, site, speaker
and audio device as subjects; `sync` continues from the checkpointed ids.
The database is never written, never copied, never locked against
screenpipe. A synthetic fixture database generated in tests stands in for a
real one everywhere, including `fixture()` and the conformance suite.

## 1. Package layout and registration

```
packages/connector-screenpipe/
  package.json          # name @kizuki/connector-screenpipe, type module, module src/index.ts,
                        # exports { ".": "./src/index.ts" }, dependencies: { "@kizuki/core": "workspace:*" } — nothing else
  README.md             # §11
  src/
    index.ts            # public exports (§10)
    errors.ts           # ScreenpipeConnectorError (§2)
    config.ts           # ScreenpipeConfig validation (§2)
    open.ts             # openReadOnly (§3)
    schema.ts           # schema floor, required columns, inspectSchema (§4)
    time.ts             # normalizeTimestamp, offsetSeconds (§5)
    cursor.ts           # cursor schema, parse/encode, bounds (§6)
    read.ts             # row readers over the four tables (§7.1)
    map.ts              # rows → CaptureEventInput, subjects, slug, siteHost (§7.2–7.4)
    connector.ts        # ScreenpipeConnector (§8)
    fixture.ts          # FIXTURE_DDL, seedFixtureDatabase, FIXTURE_NOW (§9)
  test/
    helpers.ts  open.test.ts  schema.test.ts  time.test.ts  cursor.test.ts  map.test.ts
    backfill.test.ts  sync.test.ts  health.test.ts  purge.test.ts  readonly.test.ts
    redaction.test.ts  conformance.test.ts
```

Keep every file under ~400 lines. `tsconfig.json` already includes
`packages/*/src/**/*.ts` and `packages/*/test/**/*.ts`; `bun test` at the
root discovers the new `test/` directory with no config change.

Touches outside the package (all additive):

- `packages/connectors/package.json`: add
  `"@kizuki/connector-screenpipe": "workspace:*"` to `dependencies`.
- `packages/connectors/src/registry.ts`: import `SCREENPIPE_CONNECTOR_ID`,
  `createScreenpipeConnector` and `type ScreenpipeConfig` from
  `@kizuki/connector-screenpipe`; add `[SCREENPIPE_CONNECTOR_ID]:
createScreenpipeConnector` to `REGISTRY`, the overload
  `getConnector(id: typeof SCREENPIPE_CONNECTOR_ID, config: ScreenpipeConfig): Connector`
  and the `case`. Last step, after conformance passes (connectors AGENTS.md).
- `packages/connectors/src/index.ts`: re-export `SCREENPIPE_CONNECTOR_ID`,
  `ScreenpipeConnector`, `createScreenpipeConnector`,
  `ScreenpipeConnectorError`, `seedFixtureDatabase`, `FIXTURE_NOW` and the
  types `ScreenpipeConfig`, `ScreenpipeDeps`, `ScreenpipeCursor`.
- `packages/connectors/test/conformance.test.ts` and `registry.test.ts`:
  one case each (§Tests).
- `bun.lock`: regenerated by `bun install` (workspace link only, no
  external package); commit it — CI installs with `--frozen-lockfile`.

The package imports only `@kizuki/core` and `bun:sqlite`/`node:*`. It never
imports `@kizuki/connectors` (that package will import this one; a
back-import would be a cycle), so it carries its own error class.

## 2. Config and errors (`src/config.ts`, `src/errors.ts`)

```ts
export const SCREENPIPE_CONNECTOR_ID = "kizuki.screenpipe" as const;

export interface ScreenpipeConfig {
  /** The screenpipe SQLite file. The CLI host passes it absolute; relative paths are resolved against cwd. */
  path: string;
  /**
   * RFC3339. Rows whose `timestamp` sorts before this are never read. Applied
   * once, when the cursor is null (first backfill); absent = all history.
   */
  since?: string;
  /** Integer 0..86400, default DEFAULT_SETTLE_SECONDS (§8.3). */
  settle_seconds?: number;
}

export interface ScreenpipeDeps {
  now: () => number; // Date.now
  open: (path: string) => Database; // openReadOnly (§3); tests and fixture() inject an in-memory database
}

export function parseConfig(
  config: unknown,
): Required<Pick<ScreenpipeConfig, "path" | "settle_seconds">> & {
  since: string | null;
};
// isPlainObject; `path` non-empty string; `since` absent or isRfc3339 (else "misconfigured");
// `settle_seconds` absent or an integer in [0, 86400] (else "misconfigured"); any other key → "misconfigured"
// (fail closed on unknown keys: the host state file is on-disk input).

export type ScreenpipeErrorCode =
  | "misconfigured" // bad config, unopenable path, not a database, cannot read
  | "schema_mismatch" // not a screenpipe database, floor migration missing, required column missing
  | "locked" // SQLITE_BUSY / SQLITE_LOCKED after busy_timeout
  | "parse_error" // malformed cursor, unsafe row id
  | "closed"; // revoke() was called on this instance
export class ScreenpipeConnectorError extends Error {
  readonly code: ScreenpipeErrorCode;
  constructor(
    code: ScreenpipeErrorCode,
    message: string,
    options?: { cause?: unknown },
  );
}
```

Messages carry the configured path, table and column names, migration
numbers and SQLite's own error text. They never carry a row value:
`full_text`, `window_name`, `browser_url`, `document_path`, `transcription`,
`app_name`, `device`, speaker names and `snapshot_path` are captured text
(invariant 7) and stay out of every error, health detail and cursor
(`redaction.test.ts`).

## 3. Opening the database read-only (`src/open.ts`)

```ts
export const BUSY_TIMEOUT_MS = 5_000;
export function openReadOnly(path: string): Database;
// new Database(path, { readonly: true, create: false, safeIntegers: true });
// then db.exec("PRAGMA query_only = 1"); db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
// then one probe query `SELECT name FROM sqlite_master LIMIT 1` so a non-database file fails here, not later.
// Failures: "unable to open database file" / ENOENT / EACCES / "file is not a database" →
//   ScreenpipeConnectorError("misconfigured", `kizuki.screenpipe: cannot open ${path}: ${sqlite message}`);
//   "database is locked" | "database table is locked" → ScreenpipeConnectorError("locked", "kizuki.screenpipe: screenpipe database is locked; retry").
// The handle is closed on any failure before throwing.
```

Rules:

- `readonly: true` is the guarantee (SQLite refuses every write on the
  handle); `query_only` is belt and braces; `create: false` means a typo in
  `--source` can never create an empty database at the wrong path.
- `safeIntegers: true` returns `bigint` for INTEGER columns so an id beyond
  `Number.MAX_SAFE_INTEGER` is detected instead of silently rounded.
  `toSafeNumber(value: unknown): number | null` (in `read.ts`) converts a
  `bigint` in the safe range, passes a safe-integer `number` through, and
  returns `null` for anything else. A `null` id is a `parse_error`
  (`kizuki.screenpipe: row id is not a safe integer`), never skipped
  silently: the cursor could not represent it.
- No `PRAGMA journal_mode`, no `VACUUM`, no `ATTACH`, no temp tables — a
  read-only WAL reader needs the `-shm` file; when screenpipe's directory is
  not writable by the current user SQLite reports the open failure and
  health says `misconfigured` with that text (README states this).
- One handle per connector instance, opened lazily (§8.2) and closed by
  `revoke()`.

## 4. Schema target and fail-closed detection (`src/schema.ts`)

```ts
/** The migration that retired `ocr_text`; `frames.full_text` + `frames.text_json` era. */
export const SCREENPIPE_SCHEMA_FLOOR = 20260613130000;
/** Newest migration this lane was verified against (repository commit c758770e, 2026-09-01). */
export const SCREENPIPE_SCHEMA_VERIFIED = 20260828143000;

export const REQUIRED_COLUMNS = {
  frames: [
    "id",
    "timestamp",
    "app_name",
    "window_name",
    "browser_url",
    "device_name",
    "focused",
    "full_text",
    "text_source",
    "capture_trigger",
    "snapshot_path",
    "document_path",
    "video_chunk_id",
    "offset_index",
  ],
  audio_transcriptions: [
    "id",
    "audio_chunk_id",
    "offset_index",
    "timestamp",
    "transcription",
    "device",
    "is_input_device",
    "speaker_id",
    "transcription_engine",
    "start_time",
    "end_time",
  ],
  audio_chunks: ["id", "file_path", "timestamp"],
  speakers: ["id", "name"],
} as const satisfies Record<string, readonly string[]>;

export interface SchemaReport {
  ok: boolean;
  migrations_table: boolean; // `_sqlx_migrations` exists
  floor_applied: boolean; // a row with version = SCREENPIPE_SCHEMA_FLOOR and success = 1
  max_migration: number | null; // MAX(version) WHERE success = 1; null without the table
  newer_than_verified: boolean; // max_migration > SCREENPIPE_SCHEMA_VERIFIED
  missing: string[]; // "frames.full_text" style, sorted; a missing table lists every required column
  detail: string; // one line, for HealthReport.detail and error messages
}
export function inspectSchema(db: Database): SchemaReport;
// `SELECT name FROM sqlite_master WHERE type = 'table' AND name = '_sqlx_migrations'`;
// `SELECT COUNT(*) FROM _sqlx_migrations WHERE version = ? AND success = 1`;
// `SELECT MAX(version) FROM _sqlx_migrations WHERE success = 1`;
// `PRAGMA table_info(<table>)` per REQUIRED_COLUMNS key, comparing `name` only (types are not checked:
// screenpipe rebuilt these tables several times; values are validated per row in §7).
// ok = migrations_table && floor_applied && missing.length === 0.
export function assertSchema(db: Database): SchemaReport; // returns the report when ok, else throws ScreenpipeConnectorError("schema_mismatch", report.detail)
```

`detail` strings (exact; tests compare them):

- `not a screenpipe database (no _sqlx_migrations table)`
- `screenpipe schema older than supported: migration 20260613130000 not applied (max 20260312000000); update screenpipe`
  (the parenthesised max is `none` when the table is empty)
- `screenpipe schema mismatch: missing frames.full_text, audio_transcriptions.speaker_id`
- `screenpipe schema newer than verified: max migration 20260901000000 > 20260828143000; required columns present`
  — this one is informational: state stays `ok` (§8.4). screenpipe ships
  migrations weekly; refusing every newer database would make the connector
  unusable within a month, while the column fingerprint plus per-row value
  validation is what actually protects the read.
- `screenpipe schema verified (max migration 20260828143000)` when everything matches.

`assertSchema` runs at `connect()` and again at the start of every
`backfill`/`sync`/`purgeSource` call (a screenpipe upgrade can migrate the
file between two syncs). It costs five small statements.

## 5. Timestamps (`src/time.ts`)

```ts
export function normalizeTimestamp(raw: unknown): string | null;
// Accepts a string that isRfc3339 (T separator, optional fraction of any length, `Z`/`z` or ±hh:mm) verbatim;
// or the legacy sqlx shapes /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/, rewritten
// as `${date}T${time}` + `:00` when seconds are absent + `Z` when no zone is present, then re-checked with
// isRfc3339. Returns new Date(normalized).toISOString() (UTC, millisecond precision) — deterministic for a
// given input — or null for anything else. Never throws.
export function offsetSeconds(base: string, seconds: unknown): string;
// base is an ISO string from normalizeTimestamp; seconds a finite number in [0, 86400) → ISO of base + seconds;
// anything else → base unchanged.
```

Sub-millisecond precision is dropped; two frames inside one millisecond are
still distinct by `source_record_id`. A row whose timestamp does not
normalize is skipped and counted (§6), never given a fabricated time.

## 6. Cursor (`src/cursor.ts`)

```ts
export const SCREENPIPE_CURSOR_SCHEMA = "kizuki.screenpipe-cursor/v1" as const;
export interface SkippedCounters {
  frames_without_text: number; // full_text NULL or whitespace-only
  frames_bad_timestamp: number;
  transcriptions_bad_timestamp: number;
}
export interface ScreenpipeCursor {
  schema: typeof SCREENPIPE_CURSOR_SCHEMA;
  last_frame_id: number; // highest frames.id consumed (emitted or skipped); 0 = none
  last_transcription_id: number; // same for audio_transcriptions.id
  skipped: SkippedCounters; // running totals, for health detail and doctor
}
export function initialCursor(afterIds?: {
  frame: number;
  transcription: number;
}): ScreenpipeCursor;
export function parseCursor(cursor: string): ScreenpipeCursor;
// ScreenpipeConnectorError("parse_error", "kizuki.screenpipe: malformed cursor") on non-JSON, wrong schema,
// any missing or extra key at either level, a non-integer or negative id or counter.
export function encodeCursor(cursor: ScreenpipeCursor): string; // JSON, keys in the order above

export const BATCH_LIMIT = 500; // events per SyncBatch
export const MAX_TEXT_CHARS = 65_536; // per event; longer text is cut and flagged (§7.3)
export const DEFAULT_SETTLE_SECONDS = 300;
export const MAX_PLAN_IDS = 10_000; // purge plan cap (§8.7)
export const PLAN_PAGE = 5_000; // rows per page while building a plan
```

Ids and counters only — no text, no paths, no names.

## 7. Reading and mapping rows

### 7.1 Readers (`src/read.ts`)

```ts
export interface FrameRow {
  id: number;
  timestamp: string; // raw column text
  app_name: string | null;
  window_name: string | null;
  browser_url: string | null;
  device_name: string;
  focused: boolean | null; // bigint 0n/1n → boolean; anything else → null
  full_text: string | null;
  text_source: string | null;
  capture_trigger: string | null;
  snapshot_path: string | null;
  document_path: string | null;
  video_chunk_id: number | null;
  offset_index: number;
}
export interface TranscriptionRow {
  id: number;
  audio_chunk_id: number;
  offset_index: number;
  timestamp: string;
  transcription: string;
  device: string;
  is_input_device: boolean;
  speaker_id: number | null;
  speaker_name: string | null; // speakers.name via LEFT JOIN; '' → null
  transcription_engine: string;
  start_time: number | null; // REAL; non-finite → null
  end_time: number | null;
}
export function readFrames(
  db: Database,
  afterId: number,
  limit: number,
): FrameRow[];
// SELECT id, timestamp, app_name, window_name, browser_url, device_name, focused, full_text, text_source,
//        capture_trigger, snapshot_path, document_path, video_chunk_id, offset_index
//   FROM frames WHERE id > ? ORDER BY id LIMIT ?          -- primary-key range scan, no timestamp predicate (§8.3)
export function readTranscriptions(
  db: Database,
  afterId: number,
  limit: number,
): TranscriptionRow[];
// SELECT t.id, t.audio_chunk_id, t.offset_index, t.timestamp, t.transcription, t.device, t.is_input_device,
//        t.speaker_id, s.name AS speaker_name, t.transcription_engine, t.start_time, t.end_time
//   FROM audio_transcriptions t LEFT JOIN speakers s ON s.id = t.speaker_id
//  WHERE t.id > ? ORDER BY t.id LIMIT ?
export function seedAfterIds(
  db: Database,
  since: string,
): { frame: number; transcription: number };
// SELECT COALESCE(MAX(id), 0) FROM frames WHERE timestamp < ?  (and the same for audio_transcriptions);
// `since` is passed as `new Date(since).toISOString()` so it compares textually against the RFC3339 rows
// screenpipe writes (idx_frames_timestamp / idx_audio_transcriptions_timestamp make this an index probe).
// Approximate by design at the boundary second and for legacy space-separated rows; README says so.
```

Every column value is validated on read: a TEXT column holding a non-string
becomes `null` (nullable) or the row is a `parse_error` (`id`,
`timestamp`, `transcription`, `device_name`, `device`, `transcription_engine`
must be present with the right type — these are `NOT NULL` in the schema and
a violation means the file is not what the fingerprint said).

### 7.2 Subjects (`src/map.ts`)

The staging floor mints one `entity` candidate per distinct `subject_id`
(`packages/core/src/staging/producers.ts`), so subject cardinality must be
bounded by things that exist in the owner's world, not by every window
title they ever saw. Subjects are therefore:

| subject_id                               | role    | display_name            | when                                                |
| ---------------------------------------- | ------- | ----------------------- | --------------------------------------------------- |
| `screenpipe:app:<slug(app_name)>`        | `about` | `app_name` verbatim     | frame with non-empty `app_name`                     |
| `screenpipe:site:<host>`                 | `about` | `host`                  | frame whose `browser_url` parses to an http(s) host |
| `screenpipe:speaker:<speaker_id>`        | `from`  | `speaker_name` when set | transcription with non-null `speaker_id`            |
| `screenpipe:audio-device:<slug(device)>` | `about` | `device` verbatim       | transcription with non-empty `device`               |

```ts
export function slug(name: string): string;
// NFKC-normalize, toLowerCase, replace /[^a-z0-9._-]+/g with "-", trim leading/trailing "-", cut to 64 chars;
// "" when nothing remains (then no subject is emitted).
export function siteHost(browserUrl: string | null): string | null;
// new URL(url) inside try/catch; protocol http: or https: only; hostname lowercased, trailing "." removed;
// empty or IP-literal-free? no: any non-empty hostname is fine; null otherwise. Query strings and paths never leave this function.
```

`window_name`, `document_path` and the full `browser_url` are metadata (7.3),
not subjects. Display names are captured text: they are copied into
`display_name` and nowhere else. `handleOf` in staging yields the last
segment after `:`, so a site subject's handle is its host and an app's is
its slug.

### 7.3 Frame → event (`mapFrame(row, observedAt)`)

| field              | value                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `connector_id`     | `kizuki.screenpipe`                                                                                                                                                                                                                                                                                                                                                                        |
| `source_record_id` | `frame:<id>`                                                                                                                                                                                                                                                                                                                                                                               |
| `kind`             | `screen_text`                                                                                                                                                                                                                                                                                                                                                                              |
| `occurred_at`      | `normalizeTimestamp(row.timestamp)` (caller guarantees non-null)                                                                                                                                                                                                                                                                                                                           |
| `observed_at`      | one timestamp per batch (`new Date(deps.now()).toISOString()`)                                                                                                                                                                                                                                                                                                                             |
| `text`             | `full_text` verbatim, cut to `MAX_TEXT_CHARS` code units when longer                                                                                                                                                                                                                                                                                                                       |
| `subjects`         | app, then site (7.2); `[]` when neither applies                                                                                                                                                                                                                                                                                                                                            |
| `sensitivity_hint` | `private` always (a screen recording is the owner's most private data)                                                                                                                                                                                                                                                                                                                     |
| `deleted`          | `false` always                                                                                                                                                                                                                                                                                                                                                                             |
| `attachments`      | `[{ attachment_id: "snapshot", media_type: "image/jpeg", filename: basename(snapshot_path) }]` when `snapshot_path` is non-empty, else `[]` — a reference, never a copy                                                                                                                                                                                                                    |
| `metadata`         | `{ frame_id, device_name, app_name, window_name, browser_url, document_path, focused, capture_trigger, text_source, video_chunk_id, offset_index, text_truncated }` — nulls kept as `null`; `text_truncated` boolean; no `*_redacted_at`, `sync_id`, `synced_at`, `cloud_blob_id`, `elements_ref_frame_id`, `semantic_run_id` (post-hoc mutable columns would fork history on any re-read) |

### 7.4 Transcription → event (`mapTranscription(row, observedAt)`)

| field              | value                                                                                                                                                                                                                                                            |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `source_record_id` | `transcription:<id>`                                                                                                                                                                                                                                             |
| `kind`             | `audio_transcription`                                                                                                                                                                                                                                            |
| `occurred_at`      | `offsetSeconds(normalizeTimestamp(row.timestamp), row.start_time)`                                                                                                                                                                                               |
| `text`             | `transcription` verbatim, cut at `MAX_TEXT_CHARS`                                                                                                                                                                                                                |
| `subjects`         | speaker (`from`), then audio device (`about`) (7.2)                                                                                                                                                                                                              |
| `sensitivity_hint` | `private`                                                                                                                                                                                                                                                        |
| `attachments`      | `[]` (audio chunks are never referenced: `file_path` is emptied on eviction and is not a stable reference)                                                                                                                                                       |
| `metadata`         | `{ transcription_id, audio_chunk_id, offset_index, device, is_input_device, transcription_engine, start_time, end_time, speaker_id, text_truncated }` — no speaker name (it lives in `display_name`; speakers are renamed later and `subjects` is hashed anyway) |

Every event passes `validateEventInput` (a test asserts it for the whole
fixture).

## 8. Connector behavior (`src/connector.ts`)

```ts
export class ScreenpipeConnector implements Connector {
  constructor(config: ScreenpipeConfig, deps?: Partial<ScreenpipeDeps>);
  manifest(): Manifest;
  health(): Promise<HealthReport>;
  connect(_resolve: SecretResolver): Promise<void>;
  backfill(cursor: Cursor | null): Promise<SyncBatch>;
  sync(cursor: Cursor | null): Promise<SyncBatch>;
  revoke(): Promise<void>;
  purgeSource(subject_id: string): Promise<PurgePlan>;
  fixture(): Promise<CaptureEventInput[]>;
}
export function createScreenpipeConnector(
  config: ScreenpipeConfig,
): ScreenpipeConnector; // real deps; what the registry calls
```

`parseConfig` runs in the constructor (fail closed before any file is
touched).

### 8.1 `manifest()`

```ts
{
  schema: "kizuki.connector/v1", connector_id: "kizuki.screenpipe", version: "0.1.0",
  kinds: ["screen_text", "audio_transcription"],
  capabilities: { backfill: true, sync: true, tombstones: false, purge: true, fixture: true },
  required_secrets: [],
  emits_sensitivity_hint: true,
  auth_modes: ["none"],
}
```

`tombstones: false` is honest (provider facts: no per-row deletion signal).
`purge: true` means a precise, read-only plan of what this connector knows
(§8.7); nothing is ever deleted inside screenpipe.

### 8.2 `connect(resolve)`, `revoke()`

- `connect`: ignores the resolver (nothing to resolve); `ensureOpen()`
  (`deps.open(path)` once per instance) then `assertSchema(db)`. Throws
  `misconfigured` / `locked` / `schema_mismatch`. Calling it twice is a
  no-op on an open handle.
- `backfill`, `sync`, `purgeSource`, `health` call `ensureOpen()` themselves,
  so the shared conformance suite (which never calls `connect` for a
  connector with `required_secrets: []`) works, and so does the CLI, which
  always connects first.
- `revoke`: closes the handle and marks the instance closed; every later
  call throws `ScreenpipeConnectorError("closed", "kizuki.screenpipe: connector was revoked; build a new instance")`,
  `health()` reports `disabled` with detail `revoked`. There is no
  credential to invalidate; ending access is the host's `disconnect` on
  the row (README says so).

### 8.3 `backfill(cursor)` and `sync(cursor)` — one shared `advance`

`sync(cursor)` and `backfill(cursor)` are the same function: continue from
the ids in the cursor (`null` = `initialCursor(seedAfterIds(db, since))` when
`since` is set, else `initialCursor()`). There is no phase: with no
tombstones and no re-reads, "sync" is exactly "read what appeared since the
checkpoint".

1. `assertSchema(db)` (throws `schema_mismatch` — the batch is abandoned and
   the runner keeps the previous checkpoint).
2. `boundary = new Date(deps.now() - settle_seconds * 1000).toISOString()`.
3. Frames: `readFrames(db, c.last_frame_id, BATCH_LIMIT)`; walk in id
   order:
   - `ts = normalizeTimestamp(row.timestamp)`; `null` →
     `skipped.frames_bad_timestamp += 1`, `last_frame_id = id`, continue;
   - `ts > boundary` (string compare on ISO) → **stop the frame walk here**
     without advancing past this row (the settle window: screenpipe's OCR
     fallback UPDATEs `full_text` after insert, and a row is only consumed
     once);
   - `full_text` null or whitespace-only → `skipped.frames_without_text += 1`,
     advance, continue (frames without text are normal — nothing changed on
     screen, or capture happened without a text source);
   - else push `mapFrame(row, observedAt)`, advance.
   - If `readFrames` returned `BATCH_LIMIT` rows and none stopped the walk,
     the batch is full: skip step 4.
4. Transcriptions with the remaining budget (`BATCH_LIMIT - events.length`),
   same loop over `readTranscriptions` with `skipped.transcriptions_bad_timestamp`
   and the same settle rule (rows are inserted complete, but the shared
   rule keeps one definition of "settled").
5. Record `lastBatchAt = deps.now()` and the batch's skip deltas in memory
   (for §8.4); return `{ events, cursor: encodeCursor(c) }` — **never
   `null`**: the cursor must survive into `sync`, and a caught-up call
   returns `{ events: [], cursor }` (the empty batch the CLI lanes use as
   the drain signal; `runToCompletion`, NEW in the connector-telegram lane,
   is the intended caller — this lane's tests loop explicitly).

Properties (all tested): two calls with the same cursor and the same `now`
return identical events; `observed_at` is the only field that changes with
`now` and it is outside `content_hash`; the cursor advances only past rows
that were emitted or deliberately skipped; a row inside the settle window is
read again next time, so late OCR text is captured; a frame that still has
no text once it is settled is skipped for good (README says so; the
`frames_without_text` counter is visible in doctor through the checkpoint's
`last_result.cursor`); a batch never exceeds `BATCH_LIMIT` events; a
`parse_error` (unsafe id, `NOT NULL` column violated) throws and leaves the
checkpoint untouched.

### 8.4 `health()` — passive, cheap, never throws

Every report is a `HealthReport` instance; `detail` is one of the §4
strings or the SQLite message, never row content.

- `disabled` (`detail: "revoked"`) after `revoke()`.
- `misconfigured` when `ensureOpen()` or `inspectSchema` fails closed
  (missing file, not a database, no `_sqlx_migrations`, floor missing,
  missing columns) — `detail` = the error message / `report.detail`.
- `unreachable` when SQLite reports the database locked
  (`detail: "screenpipe database is locked; retry"`).
- `ok` otherwise; `detail` = `report.detail` (which names a newer-than-
  verified schema when applicable) followed, when this process skipped rows
  in its last batch, by `; skipped N without text, M unparsable timestamps`;
  `last_success_at` = the ISO time of the last successful batch in this
  process (absent before the first).

`skipped` rows and a newer schema are deliberately not `degraded`: the
cli-verbs `connect` verb refuses anything but `ok` and its `doctor` turns any
non-`ok` health into exit 1, so `degraded` here would make an owner's fresh
screenpipe upgrade or one malformed row a permanent red doctor.

### 8.5 Bounds

`BATCH_LIMIT` rows per table per call; `MAX_TEXT_CHARS` per event; every
query is a primary-key range or an indexed probe except the two purge-plan
scans named in §8.7; `busy_timeout` 5 s; no statement ever holds a
transaction (reads are autocommit; screenpipe's writer is never blocked).

### 8.6 `fixture()`

`seedFixtureDatabase(new Database(":memory:"))` (§9), a connector over it
with `deps.open = () => memoryDb`, `deps.now = () => Date.parse(FIXTURE_NOW)`,
`settle_seconds: 0`; call `advance(null)` until an empty batch; close; return
the events (`observed_at = FIXTURE_NOW`). Needs no file, no credentials, no
network; deterministic.

### 8.7 `purgeSource(subject_id)`

A read-only plan of what this connector knows about the subject:
`source_record_ids` is always `[]` (Kizuki never deletes inside screenpipe);
`unreachable_source_record_ids` lists this connector's `source_record_id`s
for the subject in ascending id order, capped at `MAX_PLAN_IDS`. By subject
kind:

- `screenpipe:app:<slug>` — `SELECT DISTINCT app_name FROM frames WHERE
app_name IS NOT NULL` (index scan on `idx_frames_app_name_timestamp`), keep
  the names whose `slug()` equals `<slug>`, then page
  `SELECT id FROM frames WHERE app_name IN (…) AND id > ? ORDER BY id LIMIT PLAN_PAGE`
  until the cap.
- `screenpipe:site:<host>` — page `SELECT id, browser_url FROM frames WHERE
browser_url IS NOT NULL AND browser_url != '' AND id > ? ORDER BY id LIMIT PLAN_PAGE`,
  keep rows with `siteHost(browser_url) === host`, until the cap or the end
  (a full walk of frames with a URL — bounded memory, but O(rows); README
  says a site plan on a large database takes seconds; an owner-invoked
  purge is the only caller).
- `screenpipe:speaker:<id>` — page `SELECT id FROM audio_transcriptions
WHERE speaker_id = ? AND id > ? ORDER BY id LIMIT PLAN_PAGE`.
- `screenpipe:audio-device:<slug>` — `SELECT DISTINCT device FROM
audio_transcriptions`, match by `slug()`, page by `device IN (…)`.
- anything else (including the suite's `conformance:subject`) → both
  arrays empty.

The plan is informational: ledger purge is subject-keyed on its own
(`purgeEvents(db, vaultPath, { subject_handle: "screenpipe:app:acme-mail" }, reason)`
and `{ connector_id: "kizuki.screenpipe" }`, both in
`packages/core/src/ledger/purge.ts` on main) and complete regardless of the
cap. Never touches the network, never writes.

## 9. Fixture database (`src/fixture.ts`)

Product code: it backs the `fixture` capability and the registry
conformance test, and it is the only screenpipe-shaped data anywhere in the
tree.

```ts
export const FIXTURE_NOW = "2026-01-09T00:00:00.000Z";
/** Every migration the fixture claims as applied; includes the floor and the verified max. */
export const FIXTURE_MIGRATIONS: readonly number[] = [
  20240703111257, 20260220000000, 20260312000000, 20260613000001,
  20260613130000, 20260828143000,
];
/**
 * The four tables with every column screenpipe's effective schema has today (not only the required
 * ones), plus `_sqlx_migrations` exactly as sqlx creates it. Column types copied from the effective
 * schema (`frames.id INTEGER PRIMARY KEY AUTOINCREMENT`, `timestamp TIMESTAMP NOT NULL`, …).
 */
export const FIXTURE_DDL: string;
export interface SeedOptions {
  migrations?: readonly number[]; // default FIXTURE_MIGRATIONS
  rows?: boolean; // default true; false = schema only
}
export function seedFixtureDatabase(db: Database, opts?: SeedOptions): void;
// runs FIXTURE_DDL, inserts the migration rows (success = 1, checksum X'', execution_time 0), then FIXTURE rows
```

Rows (synthetic; names ada, grace, linus, acme only; all timestamps on
2026-01-05/06 so they are settled at `FIXTURE_NOW`):

- `frames` (ids 1–8, `device_name` `Built-in Display`):
  1. `Acme Mail`, window `Inbox — grace`, `full_text` a two-line note
     mentioning ada and grace, `text_source 'accessibility'`, `capture_trigger 'app_switch'`,
     `snapshot_path '/home/ada/.screenpipe/data/2026-01-05_09-00-00-monitor-1.jpg'`,
     timestamp `2026-01-05T09:00:00.123456+00:00`.
  2. `Firefox`, `browser_url 'https://mail.acme.example/inbox/42?tab=1'`
     (site subject `mail.acme.example`), `text_source 'ocr'`, timestamp with
     `Z` and no fraction.
  3. `Terminal`, `document_path '/home/ada/notes/todo.md'`, `text_source 'hybrid'`,
     `focused 1`, legacy timestamp `2026-01-05 09:02:00.5+00:00`.
  4. `Acme Mail`, `full_text NULL` (skipped: without text).
  5. `Acme Mail`, `full_text '   '` (skipped: without text).
  6. `Notes`, `full_text` of 70 000 characters (truncated event).
  7. `Notes`, timestamp `'yesterday'` (skipped: bad timestamp).
  8. `Firefox`, `browser_url 'not a url'` (no site subject), `app_name`
     `''` (no app subject), text present.
- `speakers`: `(1, 'Grace')`, `(2, NULL)`.
- `audio_chunks`: `(1, '/home/ada/.screenpipe/data/2026-01-06_10-00-00-mic.mp4', …)`, `(2, …)`.
- `audio_transcriptions` (ids 1–3): `speaker_id 1`, device
  `MacBook Microphone (input)`, `is_input_device 1`, `start_time 12.5`;
  `speaker_id 2`, device `Display Audio (output)`, `is_input_device 0`;
  `speaker_id NULL`, `start_time NULL`. Texts mention linus and acme.

Expected: `fixture()` yields exactly 8 events (5 `screen_text` — ids
1, 2, 3, 6, 8 — and 3 `audio_transcription`), and a fresh backfill's cursor
reads `skipped: { frames_without_text: 2, frames_bad_timestamp: 1, transcriptions_bad_timestamp: 0 }`
with `last_frame_id: 8`, `last_transcription_id: 3`. A test pins the sha256
of `canonicalSerialize` for all 8 (hash stability).

`test/helpers.ts` (not `src`) writes the seeded database to a
`mkdtempSync` directory (`db.sqlite`, default rollback journal — no `-wal`
files to reason about) and returns `{ dir, path, writer }` where `writer` is
a read-write `Database` tests use to append or mutate rows between calls.

## 10. Exports

`packages/connector-screenpipe/src/index.ts` exports `SCREENPIPE_CONNECTOR_ID`,
`ScreenpipeConnector`, `createScreenpipeConnector`, `ScreenpipeConnectorError`,
`parseConfig`, `openReadOnly`, `BUSY_TIMEOUT_MS`, `inspectSchema`,
`assertSchema`, `SCREENPIPE_SCHEMA_FLOOR`, `SCREENPIPE_SCHEMA_VERIFIED`,
`REQUIRED_COLUMNS`, `normalizeTimestamp`, `offsetSeconds`,
`SCREENPIPE_CURSOR_SCHEMA`, `initialCursor`, `parseCursor`, `encodeCursor`,
`BATCH_LIMIT`, `MAX_TEXT_CHARS`, `DEFAULT_SETTLE_SECONDS`, `MAX_PLAN_IDS`,
`PLAN_PAGE`, `readFrames`, `readTranscriptions`, `seedAfterIds`, `slug`,
`siteHost`, `mapFrame`, `mapTranscription`, `FIXTURE_NOW`,
`FIXTURE_MIGRATIONS`, `FIXTURE_DDL`, `seedFixtureDatabase`, and the types
`ScreenpipeConfig`, `ScreenpipeDeps`, `ScreenpipeErrorCode`, `SchemaReport`,
`ScreenpipeCursor`, `SkippedCounters`, `FrameRow`, `TranscriptionRow`,
`SeedOptions`. `packages/connectors/src/index.ts` re-exports the subset in §1.

## 11. Documentation (`packages/connector-screenpipe/README.md`)

Sections, in order, each claiming only what this package does:

1. **What it reads** — screen text (`frames.full_text`: accessibility text,
   OCR, or both) and audio transcriptions from screenpipe's local SQLite
   file, read-only; each row becomes one `private` event; subjects are the
   app, the site host, the speaker and the audio device; the default file
   location `~/.screenpipe/db.sqlite`; media is never read or copied.
2. **Connect** — `kizuki connect screenpipe --source ~/.screenpipe/db.sqlite`
   then `kizuki backfill screenpipe` (repeat until it reports no new
   events, or let the CLI drain) and `kizuki sync screenpipe`. State the
   verb ownership sentence exactly as the other connector READMEs do until
   the verbs exist on the same branch.
3. **Schema this version targets** — migration floor `20260613130000`
   (screenpipe from 2026-06-13 on), verified through `20260828143000`
   (repository commit `c758770e`, 2026-09-01); newer databases are read when
   the required columns are present and reported in `doctor`'s health
   detail; older ones are refused with the exact message from §4 — update
   screenpipe.
4. **Limits (honest)** — deletions in screenpipe (retention or manual) are
   not mirrored (`tombstones: false`); text redacted by screenpipe after
   Kizuki read it stays in Kizuki's ledger until purged; frames are read once
   they are `settle_seconds` (default 300) old, and a frame that still has
   no text then is skipped for good; screen text longer than 65 536
   characters is cut and flagged; `since` is approximate at the boundary
   second; keystrokes, clipboard, UI elements, meetings, memories, tags and
   media are not captured; the screenpipe HTTP API is never used; a
   read-only WAL reader needs the `-shm` file, so the database directory
   must be writable by your user; facts checked 2026-09-02.
5. **Purge** — `kizuki purge --subject screenpipe:app:<slug> --reason …`,
   `--subject screenpipe:site:<host>`, `--subject screenpipe:speaker:<id>`,
   `--subject screenpipe:audio-device:<slug>`, and
   `--connector screenpipe`; what the plan lists and that screenpipe's own
   data is untouched.
6. **Review-queue volume** — one capture note per frame is the deterministic
   floor; on a database with millions of frames connect with a `since`
   (when the CLI exposes it — see open questions) or expect a long queue.

Run the `humanizer` pass on the README; no identifier from the denylist, no
real user names, hostnames or paths beyond the documented default.

## Non-goals

- No CLI verbs or flags (`connect`, `backfill`, `sync`, `--since`,
  `--settle-seconds` are the CLI lanes'); no changes under `packages/cli`.
- No tombstones, no redaction re-reads, no session/coalescing of consecutive
  frames (that is the RFC 0001 activity layer's job), no `ui_events`,
  `elements`, `memories`, `meetings`, `tags`, media, or the screenpipe HTTP
  API.
- No writes to the screenpipe file, ever; no `-wal` checkpointing, no
  `VACUUM`.
- No changes to `packages/core`, `kizuki.event/v1`, `kizuki.connector/v1`,
  the connections schema, or the ingest runner.
- No runtime dependency (`npm view` was not needed: `bun:sqlite` is built
  in).

## Tests

All under `packages/connector-screenpipe/test/` unless noted; `bun:test`;
temp dirs via `mkdtempSync`, removed in `afterEach`; synthetic data only;
`now` injected through `deps.now`. Regression tests that must exist (names
are the `test()` titles):

- `open.test.ts` — "a missing file is misconfigured, not created" (the
  path does not exist afterwards); "a non-database file is misconfigured";
  "the handle refuses writes" (`db.exec("INSERT …")` throws
  `attempt to write a readonly database`); "safeIntegers surfaces unsafe ids
  as parse_error" (writer inserts `id = 9007199254740993`).
- `schema.test.ts` — "the fixture schema is verified" (`ok`, `detail` =
  the verified string); "a database without _sqlx_migrations is not a
  screenpipe database" (exact detail); "a database below the floor is
  refused" (`migrations: [20240703111257, 20260312000000]`, exact detail
  with `max 20260312000000`); "a missing required column fails closed"
  (`ALTER TABLE frames DROP COLUMN full_text` on the writer → `missing`
  contains `frames.full_text`, `connect()` throws `schema_mismatch`,
  `backfill(null)` throws `schema_mismatch`, health `misconfigured`); "a
  newer migration is read and reported" (`migrations` plus
  `20260901000000` → `ok`, `newer_than_verified`, health `ok` with the exact
  detail); "schema is re-checked on every batch" (drop the column between
  two `sync` calls → second call throws, cursor unchanged).
- `time.test.ts` — one case per accepted shape from §5 with the expected
  ISO output; "rejects garbage, bare dates and month 13"; "offsetSeconds
  ignores negative, non-finite and out-of-range offsets".
- `cursor.test.ts` — round trip; "rejects wrong schema, extra keys, missing
  counters, negative ids, floats"; "encoding is key-order stable".
- `map.test.ts` — "frame subjects: app slug and site host"; "an app_name
  that slugs to nothing yields no app subject"; "a non-http browser_url
  yields no site subject and query strings never appear in subjects";
  "snapshot becomes a jpeg attachment reference with basename only"; "long
  text is cut at MAX_TEXT_CHARS and flagged"; "transcription occurred_at
  adds start_time"; "speaker without a name has no display_name";
  "metadata carries no redaction or sync columns"; "every fixture event
  passes validateEventInput"; "fixture hashes are stable" (8 pinned sha256
  literals).
- `backfill.test.ts` — "first backfill emits the settled fixture rows in id
  order with the documented skip counters"; "a batch never exceeds
  BATCH_LIMIT" (writer inserts 1 200 frames → 500/500/200 then empty, cursor
  advances each time); "the same cursor and now yield identical events";
  "the settle window holds back recent frames" (`now` = last frame + 60 s,
  `settle_seconds: 300` → not emitted; `now` + 300 s → emitted); "late OCR
  text inside the settle window is captured" (insert with NULL `full_text`,
  UPDATE it, advance `now` → emitted with the text); "a frame without text
  past the settle window is skipped for good"; "an out-of-order recent
  timestamp stops the walk without skipping the row"; "since seeds the
  cursor past older rows"; "double backfill through InMemoryLedger is all
  duplicates" (`InMemoryLedger` from `@kizuki/connectors`).
- `sync.test.ts` — "sync(null) equals backfill(null)"; "sync continues from
  the checkpoint and sees rows appended by a concurrent writer" (writer
  inserts while the connector's read handle is open); "a caught-up sync
  returns an empty batch with the same cursor"; "sync never returns a null
  cursor".
- `health.test.ts` — the state table of §8.4 including `disabled` after
  `revoke`, `unreachable` while another connection holds
  `BEGIN EXCLUSIVE` on a rollback-journal database (`busy_timeout` lowered
  through a test-only `deps.open` that sets it to 50 ms), and the
  `; skipped …` suffix after a batch with skips; every report is a
  `HealthReport`.
- `purge.test.ts` — "an app plan lists every frame of that app under
  unreachable ids, nothing under source_record_ids"; "a site plan matches
  by host only"; "a speaker plan and a device plan"; "an unknown subject
  yields an empty plan"; "the plan is capped at MAX_PLAN_IDS" (writer
  inserts 10 001 frames of one app); "purgeSource never writes" (file sha256
  unchanged).
- `readonly.test.ts` — "backfill, sync, health and purgeSource leave the
  file byte-identical" (sha256 before/after over the whole cycle); "the
  connector holds no lock a writer notices" (writer inserts succeed while
  the connector's handle is open and mid-batch).
- `redaction.test.ts` — plant `PLANTED-CAPTURE-MARKER` in `full_text`,
  `window_name`, `browser_url` path, `document_path`, `transcription`,
  `app_name`, `device` and a speaker name; assert none of
  `JSON.stringify(manifest())`, any `health().detail`, any thrown
  `message` across the failure cases above, or any cursor contains it;
  assert the marker appears in events only in `text`, `display_name` and
  the documented metadata keys.
- `conformance.test.ts` — "kizuki.screenpipe passes the shared conformance
  suite" (`runConformance(connector)` over a temp fixture file with
  `settle_seconds: 0`, no `tombstone` hooks needed) →
  `{ pass: true, failures: [] }`.
- `packages/connectors/test/conformance.test.ts` — the registry case
  gains `getConnector(SCREENPIPE_CONNECTOR_ID, { path: fixturePath, settle_seconds: 0 })`
  (seeded through `seedFixtureDatabase` on a temp file) and the expected
  array gains one `{ pass: true, failures: [] }`.
- `packages/connectors/test/registry.test.ts` — "getConnector builds
  kizuki.screenpipe" (manifest `connector_id`).

Target: ≥ 55 new tests in the package plus the two registry-level ones.

## Acceptance

```
cd <worktree>
bun install                                                                                   # bun.lock gains the workspace link only; commit it
bun install --frozen-lockfile                                                                 # exit 0 on the committed lockfile
cat packages/connector-screenpipe/package.json | grep -c '"@kizuki/core": "workspace:\*"'    # 1; and no other dependency line
bun -e 'import { Database } from "bun:sqlite"; try { new Database("/nonexistent/x.sqlite", { readonly: true, create: false, safeIntegers: true }); console.log("WRONG") } catch (e) { console.log("probe-ok:", e.message) }'
                                                                                              # probe-ok: unable to open database file   (repeat on the CI-pinned Bun)
bun run typecheck                                                                             # exit 0
bun test packages/connector-screenpipe                                                        # green; ≥ 55 tests
bun test packages/connectors                                                                  # green; the conformance list includes the screenpipe result
bun test                                                                                      # green
bun run scripts/verify-network.ts                                                             # "network source verification passed"
T=$(mktemp -d) && bun -e 'import { Database } from "bun:sqlite"; import { seedFixtureDatabase, createScreenpipeConnector } from "./packages/connector-screenpipe/src/index.ts"; const p = process.argv[1]; const w = new Database(p); seedFixtureDatabase(w); w.close(); const c = createScreenpipeConnector({ path: p, settle_seconds: 0 }); await c.connect(async () => { throw new Error("none") }); const h = await c.health(); const b = await c.backfill(null); const again = await c.sync(b.cursor); console.log(h.state, b.events.length, JSON.parse(b.cursor).skipped, again.events.length, b.events.every(e => e.sensitivity_hint === "private"))' "$T/db.sqlite"
                                                                                              # ok 8 { frames_without_text: 2, frames_bad_timestamp: 1, transcriptions_bad_timestamp: 0 } 0 true
sha256sum "$T/db.sqlite"                                                                      # identical to the value printed before the previous command's backfill (run it once before, once after)
bun -e 'const m = await import("./packages/connector-screenpipe/src/index.ts"); const c = m.createScreenpipeConnector({ path: "/nonexistent/db.sqlite" }); console.log((await c.health()).state)'
                                                                                              # misconfigured
bun -e 'const m = await import("./packages/connector-screenpipe/src/index.ts"); const f = await m.createScreenpipeConnector({ path: ":memory:" }).fixture(); console.log(f.length, new Set(f.map(e => e.kind)).size)'
                                                                                              # 8 2
bun -e 'const m = await import("./packages/connectors/src/index.ts"); console.log(m.getConnector("kizuki.screenpipe", { path: "/tmp/never-opened.sqlite" }).manifest().auth_modes)'
                                                                                              # [ "none" ]   (construction never opens the file)
git grep -n -E 'fetch\(|Bun\.serve|WebSocket|node:http|node:net' -- packages/connector-screenpipe   # no output
git grep -n -i -E 'ill''umi|her''mes|ika-''hetzner|alb''edo|g''brain' -- packages/connector-screenpipe   # no output
git diff --stat main..HEAD -- 'packages/*/package.json' bun.lock | cat                        # exactly packages/connector-screenpipe/package.json (new), packages/connectors/package.json, bun.lock
git diff --stat main..HEAD -- packages/core | cat                                             # no output
bun run verify                                                                                # exit 0 (typecheck, tests, policy test, network scan, dependency grep, identifier denylist over tracked text and commit messages)
git status --porcelain                                                                        # empty
```
