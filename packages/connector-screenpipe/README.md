# `@kizuki/connector-screenpipe`

## What it reads

This package is an offline adapter for screenpipe's local SQLite database. It
opens the file read-only, does not call the screenpipe HTTP API, and never
reads or copies screen or audio media.

Each settled `frames.full_text` row becomes one private `screen_text` event.
The field can contain accessibility text, OCR text, or both. Each
`audio_transcriptions` row becomes one private `audio_transcription` event.
Subjects identify an app, an HTTP(S) site host, a speaker, or an audio device
when that information is present.

Screenpipe normally stores the database at `~/.screenpipe/db.sqlite` and keeps
media separately under `~/.screenpipe/data/`.

Do not use this connector while screenpipe is running. Screenpipe's operating
guide explicitly prohibits external SQLite clients on the live database, and
its WAL/VFS locking can make mixed access unsafe even for a read-only client.
Quit screenpipe before every connector operation, including health or doctor
checks. Keep it stopped until the Kizuki process exits or a library caller has
awaited `revoke()`, which closes the retained database handle.

For a separate snapshot, quit screenpipe and copy the complete
`~/.screenpipe/` directory before pointing Kizuki at the copied `db.sqlite`.
This keeps any existing `db.sqlite-wal` with its database. Never copy the live
database piecemeal.

## Connect

First quit screenpipe completely. Then run:

```sh
kizuki connect screenpipe --source ~/.screenpipe/db.sqlite
kizuki backfill screenpipe
kizuki sync screenpipe
```

Repeat backfill until it reports no new events, or let a CLI version with
draining support continue for you before restarting screenpipe. A later sync
is another offline sweep: stop screenpipe, run sync, then restart it. The
`connect`, `backfill`, and `sync` verbs are wired by the CLI lanes; until they
merge, the connector is reachable through `@kizuki/connectors` via
`getConnector("kizuki.screenpipe", { path })`.

No token, application credential, account scope, or network permission is
needed. Direct database access is not a provider-published third-party
integration flow; screenpipe's supported surfaces while its daemon is running
are its local API, MCP server, and CLI.

A locked Screenpipe Vault is unreadable by this package. Unlocking is an
explicit owner action in Screenpipe; Kizuki never asks for or retains the vault
password. If Screenpipe cannot produce an unlocked offline database or copy,
use its supported API, MCP, or CLI instead.

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

- Screenpipe does not expose a per-row deletion log. Retention and manual
  deletion therefore cannot be mirrored honestly, so the manifest declares
  `tombstones: false`.
- This package must not attach to screenpipe's live database. Read-only SQLite
  flags do not make mixed VFS/WAL access safe.
- If screenpipe redacts text after Kizuki has read it, the earlier ledger event
  remains until the owner purges it. This connector never rewrites old events.
- Speaker names and assignments are captured once. Later speaker renames,
  reassignments, or retranscriptions in screenpipe do not revise prior events.
- Frames are consumed once they are at least `settle_seconds` old. The default
  is 300 seconds so asynchronous OCR has time to update `full_text`, but
  screenpipe publishes no maximum OCR-settle guarantee. A settled frame that
  still has no text is skipped permanently.
- Screen text and transcripts longer than 65,536 JavaScript code units are cut
  and marked with `metadata.text_truncated: true`.
- The optional `since` setting is approximate at its boundary second,
  especially for legacy space-separated timestamps.
- A call emits at most 500 events. Checkpoints hold the last consumed frame and
  transcription IDs, so repeated calls resume without rescanning history.
- Restoring or replacing the source database can rewind IDs. The connector
  does not detect that replacement, so build a new source enrollment instead
  of reusing its checkpoint.
- Direct file access sees physically retained rows. It does not enforce
  screenpipe's account-dependent history policy, which can restrict supported
  API access to the latest 24 hours.
- At-rest redaction mutates source rows, and browser URL redaction is off in
  screenpipe's default redaction configuration. Direct file access does not
  apply screenpipe's separate,
  paid-plan query-time privacy filter.
- Keystrokes, clipboard data, UI elements, meetings, memories, tags, and media
  files are outside this connector.
- The screenpipe HTTP API is not used.

These limits and provider facts were checked on 2026-09-02.

## Purge

Once the CLI purge lane is present, owner-invoked Kizuki purge can target the
subject IDs emitted here:

```sh
kizuki purge --subject screenpipe:app:<slug> --reason "..."
kizuki purge --subject screenpipe:site:<host> --reason "..."
kizuki purge --subject screenpipe:speaker:<id> --reason "..."
kizuki purge --subject screenpipe:audio-device:<slug> --reason "..."
kizuki purge --connector screenpipe --reason "..."
```

`purgeSource()` returns matching source record IDs under
`unreachable_source_record_ids`, capped at 10,000. It is an informational,
read-only plan: screenpipe's database is never changed. Site plans match the
parsed host and may take seconds on a database with many URL-bearing frames.
Ledger purge by subject or connector is not limited by the plan cap.

## Review-queue volume

Kizuki's deterministic floor creates one capture note per emitted frame or
transcription. A database with millions of frames can therefore create a long
review queue. Configure `since` when the CLI exposes that option if only recent
history is wanted.

## Provider research packet

Checked 2026-09-02 against screenpipe's
[FAQ](https://docs.screenpipe.com/faq),
[architecture documentation](https://docs.screenpipe.com/architecture),
[CLI operating guide](https://github.com/screenpipe/screenpipe/blob/c758770e225324c22778cb949ba7e80fa024d2d2/crates/screenpipe-core/assets/skills/screenpipe-cli/SKILL.md),
and the official database source and migrations at
[`c758770e`](https://github.com/screenpipe/screenpipe/tree/c758770e225324c22778cb949ba7e80fa024d2d2/crates/screenpipe-db).

| Topic | Finding |
| --- | --- |
| Sanctioned access and scopes | Screenpipe does not publish a third-party direct-database protocol. Its supported live surfaces are API, MCP, and CLI. This package performs offline file reads with no API scope or remote service. |
| Operator setup | Fully stop screenpipe. Either read its stopped database in place or copy the complete `~/.screenpipe/` directory after shutdown so the database and any WAL stay together. Never attach this package to the live database. |
| Owner steps | With screenpipe stopped, point the connector at `db.sqlite`, backfill until caught up, then close every Kizuki handle before restarting screenpipe. Repeat that stop/sync/close/restart sequence for incremental imports. Health and doctor checks have the same shutdown requirement. |
| Secret custody | No token or client secret exists for this connector. Nothing is persisted through a secret reference. Locked Screenpipe Vaults are unsupported; unlock only through owner-operated Screenpipe surfaces and never provide a vault password to Kizuki. |
| History and backfill | All physically retained compatible rows are visible, including rows a screenpipe API history policy might hide. Kizuki pages them in 500-event batches; an optional initial `since` can skip older IDs approximately. |
| Incremental behavior | Each offline sweep resumes from frame and transcription IDs. There is no webhook or network cursor; later row updates, hard deletions, and database ID rewinds are not detected. |
| Edits and deletions | Late OCR is covered only by the settle window. Later redaction, speaker correction, and retranscription are not reread. Screenpipe has retention and range deletion but no deletion log suitable for tombstones. |
| Approval, billing, and review | The connector itself has no provider approval or billing gate. Screenpipe's own plan can govern supported history and query-time privacy features; direct file access does not reproduce those gates. |
| Honest fallback | Use screenpipe's API, MCP server, or CLI when it must remain running; this zero-network package cannot provide that path. Update screenpipe when the schema is below the floor, and use owner-invoked Kizuki ledger purge when imported evidence must be removed. |
