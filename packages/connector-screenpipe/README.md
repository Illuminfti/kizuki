# `@kizuki/connector-screenpipe`

## What it reads

This package is a read-only adapter over screenpipe's local SQLite database. It
does not call the screenpipe HTTP API, and it never reads or copies screen or
audio media.

Each settled `frames.full_text` row becomes one private `screen_text` event.
That column holds accessibility text, OCR text, or both. Each
`audio_transcriptions` row becomes one private `audio_transcription` event.
Subjects identify an app, an HTTP(S) site host, a speaker, or an audio device
when that information is present.

Screen text and audio transcription are a local-capture source class, so the
manifest declares `default_sensitivity: private` and `sensitivity_floor:
personal`, and every event this connector emits carries
`sensitivity_hint: private`. Nobody is asked to label anything. The port
carries both fields as optional, so `kizuki.connector/v1` still reads for a
connector written before them; the shared conformance suite rejects a class
that is declared and is not one of the known levels, and the ledger stores the
hint. Resolving a label from the source class is accepted design
(RFC 0002 §8.2) and has no consumer on this branch.

screenpipe stores the database at `~/.screenpipe/db.sqlite` by default and keeps
media separately under `~/.screenpipe/data/`.

## Connect

```sh
kizuki connect screenpipe --source ~/.screenpipe/db.sqlite
kizuki backfill screenpipe
kizuki sync screenpipe
```

Repeat `backfill` until a call reports no new events. A call reports none only
when nothing more is readable: a run of frames without text is walked out inside
the call rather than ending it, so the event count is the whole drain signal.
`sync` then continues from the same checkpoint.

`connect`, `backfill`, and `sync` are wired to this connector today. A host that
drives the loop itself reaches it through `@kizuki/connectors` via
`getConnector("kizuki.screenpipe", { path })`.

screenpipe can keep recording throughout. It runs the database in WAL mode
behind its own write queue, and concurrent readers are its supported access
pattern. This package opens the file read-only, refuses to create one that is
missing, sets `PRAGMA query_only`, never opens a transaction, and waits at most
five seconds on a busy database, so screenpipe's writer is never blocked.
If the database is locked anyway, `health()` reports `unreachable` with the
detail `screenpipe database is locked; retry`, and the next call retries from
the same checkpoint.

This connector needs no token, application credential, account scope, or
network permission. `revoke()` closes the retained database handle. There is no
credential to invalidate, so ending access is the host's `disconnect` on the
enrollment row.

## Schema this version targets

The minimum supported screenpipe migration is `20260613130000`, from
2026-06-13, when OCR text was unified into `frames`. This package was verified
through migration `20260828143000` at screenpipe repository commit
[`c758770e`](https://github.com/screenpipe/screenpipe/tree/c758770e225324c22778cb949ba7e80fa024d2d2)
on 2026-09-01.

Newer databases remain readable when every required column is present.
`health()` reports the newer migration in its detail. Older databases are
refused with:

```text
screenpipe schema older than supported: migration 20260613130000 not applied (max <version>); update screenpipe
```

## Limits

- screenpipe exposes no per-row deletion log. Retention and manual deletion
  therefore cannot be mirrored honestly, so the manifest declares
  `tombstones: false`.
- A read-only reader of a WAL database creates `db.sqlite-shm` beside the
  database file, so the directory holding it must be writable by your user. When
  it is not, the open fails and `health()` reports `misconfigured` carrying
  SQLite's own `attempt to write a readonly database` text. That is a permission
  problem on the directory, not a write by this package.
- If screenpipe redacts text after Kizuki has read it, the earlier ledger event
  remains until the owner purges it. This connector never rewrites old events.
- Speaker names and assignments are captured once. Later speaker renames,
  reassignments, or retranscriptions in screenpipe do not revise prior events.
- Frames are consumed once they are at least `settle_seconds` old. The default
  is 300 seconds so asynchronous OCR has time to update `full_text`, but
  screenpipe publishes no maximum OCR-settle guarantee. A settled frame that
  still has no text is skipped for good and counted in the checkpoint.
- A row timestamped more than `settle_seconds` ahead of your clock cannot be
  waiting for that update, so it is read straight away rather than holding the
  walk on it. Its `occurred_at` keeps the timestamp the source gave it.
- A row whose timestamp is not stored as text, cannot be parsed, or whose
  instant falls outside the years RFC3339 covers, is skipped and counted in the
  checkpoint rather than emitted with a fabricated time. One such row never
  holds up the rows behind it.
- Screen text and transcripts longer than 65,536 UTF-16 code units are cut on a
  code point boundary and marked with `metadata.text_truncated: true`.
- Every other captured string is bounded at 1,024 UTF-16 code units, counted
  the same way and cut the same way: the window title, application name, URL,
  document path, device names, capture trigger and text source that travel in
  `metadata`, and the display names that reach subjects. A cut there is marked
  with `metadata.metadata_truncated: true`. The bounds are separate because
  only the text is a screenful; one batch of 500 events would otherwise carry
  megabytes of window titles around events whose own text is a line long.
- A snapshot attachment carries the last component of `snapshot_path` as its
  filename when that component is at most 255 code units and the path itself
  was not cut. Otherwise the reference stands without a filename: what it
  points at is the row, not the name.
- The optional `since` setting excludes every row dated before it. The cutoff is
  compared against each row's own timestamp, so it holds even where ID order and
  timestamp order disagree, which is ordinary for `audio_transcriptions`. It
  must be a timestamp the runtime can represent, which excludes the leap second
  RFC3339 otherwise allows. The starting ID is still probed against the
  timestamp column and is approximate at the boundary second and for legacy
  encodings; the probe only ever starts earlier than it needs to, so the
  approximation costs a few reads rather than history. Each table is probed in
  a single statement, so a row screenpipe writes while the probe runs is behind
  the starting ID rather than in front of it, and a row whose timestamp is not
  stored as text is never probed past: it reaches the walk and is counted like
  any other unreadable timestamp. The cutoff applies on every call, so raising
  it later excludes rows from then on, while lowering it does not bring back
  rows the checkpoint has already passed.
- A call emits at most 500 events and reads rows in pages of 500. It keeps
  paging until it has an event, both tables are read out, or the settle window
  stops it, so a long idle run costs a slower call rather than a call that
  reports nothing while rows remain behind the checkpoint. Screen frames may
  take at most 400 of the 500 places while transcriptions are still behind the
  checkpoint, so a machine in continuous use cannot leave its audio unread;
  when the audio table is caught up, frames take the whole batch.
- A column this connector only carries into metadata or a subject degrades
  rather than failing the batch: `offset_index` and `audio_chunk_id` read as
  `0`, and a capture device, audio device or engine name that is not stored as
  text reads as empty. SQLite columns are dynamically typed, so any of these
  can hold a blob whatever the schema declares.
- A row whose ID or transcript text cannot be read stops that table where it
  stands. The rows in front of it are still emitted and still advance the
  checkpoint, and `health()` then reports `misconfigured` naming the column, so
  `doctor` goes red rather than staying green over a source that has stopped
  moving.
- Restoring or replacing the source database can rewind IDs. The connector does
  not detect that replacement, so build a new source enrollment instead of
  reusing its checkpoint.
- Keystrokes, clipboard data, UI elements, meetings, memories, tags, and media
  files are outside this connector.
- The screenpipe HTTP API is not used.

These limits and provider facts were checked on 2026-09-02.

## Purge

Owner-invoked Kizuki purge targets the subject IDs emitted here:

```sh
kizuki purge --subject screenpipe:app:<slug> --reason "..."
kizuki purge --subject screenpipe:site:<host> --reason "..."
kizuki purge --subject screenpipe:speaker:<id> --reason "..."
kizuki purge --subject screenpipe:audio-device:<slug> --reason "..."
kizuki purge --connector screenpipe --reason "..."
```

An app or device subject carries its name reduced to lowercase letters, digits,
`.`, `_` and `-`. Two kinds of name keep a short fingerprint of the whole name
so that names reducing the same way stay separate subjects: one longer than 64
characters, and one that loses a letter or digit to the reduction, such as a
name written in Chinese, Japanese, Cyrillic, Greek, or Arabic. A name that
reduces to nothing is that fingerprint alone rather than no subject at all. A
site subject carries an ordinary hostname verbatim; an address literal, whose
colons a subject ID cannot carry, is reduced and fingerprinted the same way, so
two addresses never share a subject. Only the first 1,024 characters of a name
reach its subject ID.

`purgeSource()` returns matching source record IDs under
`unreachable_source_record_ids`, capped at 10,000. It is an informational,
read-only plan: screenpipe's database is never changed. A plan lists only rows
this connector emits, so frames without text, rows with an unusable timestamp,
and rows excluded by `since` are absent from it, as they are from the ledger. A
row still inside the settle window is listed, because the next call will read
it. Every plan walks
frame or transcription IDs in pages and matches one row at a time, so it takes
seconds on a large database and allocates nothing that the number of distinct
app or device names could grow. Ledger purge by subject or connector is not
limited by the plan cap.

## Capture volume

Kizuki's model-free producer creates one capture note per emitted frame or
transcription. A database with millions of frames therefore produces a large
number of claims for the loop to write and budget against; it does not queue
anything for a person to approve. There is no owner review queue and no owner
approval step (`docs/decision-log.md` D9, D10; RFC 0002 §4). Canon writing is
bounded by the loop's per-run and per-day write budget and every write is
receipted and reversible; the model-free path here still runs with no model
configured, while canon writing itself requires one (`docs/decision-log.md`
D12). Configure `since` when the CLI exposes that option if only recent
history is wanted.

## Provider research packet

Checked 2026-09-02 against screenpipe's
[architecture documentation](https://docs.screenpipe.com/architecture) and its
database crate and migrations at
[`c758770e`](https://github.com/screenpipe/screenpipe/tree/c758770e225324c22778cb949ba7e80fa024d2d2/crates/screenpipe-db).

| Topic                         | Finding                                                                                                                                                                                                                                                                                                                    |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sanctioned access and scopes  | screenpipe publishes its schema and documents inspecting the database file directly. This package reads that file and nothing else. There is no API scope and no remote service.                                                                                                                                           |
| Concurrency                   | The database runs in WAL mode behind screenpipe's write queue, so a reader can run while screenpipe records. This package reads without a transaction and never checkpoints or vacuums the file.                                                                                                                           |
| Owner steps                   | Point the connector at `db.sqlite`, backfill until a call reports no new events, then sync on whatever schedule the owner wants.                                                                                                                                                                                           |
| Secret custody                | No token or client secret exists for this connector, and nothing is persisted through a secret reference.                                                                                                                                                                                                                  |
| History and backfill          | Every physically retained row of a compatible schema is visible. Kizuki pages them in 500-event batches; an optional `since` excludes every row dated before it.                                                                                                                                                           |
| Incremental behavior          | Each sweep resumes from the checkpointed frame and transcription IDs. There is no webhook and no network cursor; later row updates, hard deletions, and database ID rewinds are not detected.                                                                                                                              |
| Edits and deletions           | Late OCR is covered by the settle window. Redaction overwrites the text columns in place and stamps `*_redacted_at`; those rows are not re-read. Media eviction empties `file_path` and keeps the row. Retention and range deletion leave no deletion log suitable for tombstones.                                         |
| Approval, billing, and review | The connector itself has no provider approval or billing gate. Screenpipe's own plan can govern supported history and query-time privacy features; direct file access does not reproduce those gates. These are provider-side gates only; Kizuki itself has no owner review or approval gate (`docs/decision-log.md` D10). |
| Honest fallback               | Update screenpipe when the schema sits below the floor, and use owner-invoked Kizuki ledger purge when imported evidence must be removed.                                                                                                                                                                                  |
