# `@kizuki/connector-screenpipe`

Offline, read-only adapter for a stopped screenpipe SQLite database. It never
calls the screenpipe HTTP API, never reads media files, and never writes the
source. Each settled `frames.full_text` row becomes one private `screen_text`
event. Each `audio_transcriptions` row becomes one private
`audio_transcription` event. Subjects name an app, an HTTP(S) site host, a
speaker, or an audio device when that information is present.

This package is not a 1.0 product surface. It is the connector implementation
behind `kizuki.screenpipe`. Canon writing, if a model is configured, is done
by the loop's receipted writer. There is no owner review queue and no owner
approval step (`docs/decision-log.md` D9, D10; RFC 0002). Capture, ledger,
search, timeline, context, audit and undo stay model-free (D12).

## Connect

Quit screenpipe completely before every connector operation, including health
checks. Screenpipe's operating guide prohibits external SQLite clients on the
live database. Keep it stopped until the Kizuki process exits or a caller has
awaited `revoke()`.

```sh
kizuki connect screenpipe --source ~/.screenpipe/db.sqlite
kizuki backfill screenpipe
kizuki sync screenpipe
```

`connect`, `backfill`, and `sync` are CLI verbs. Until a given host exposes
them, the connector is reachable through `@kizuki/connectors` via
`getConnector("kizuki.screenpipe", { path })`.

One backfill run is a bounded, resumable drain of the snapshot recorded at
the first `backfill(null)`. Each call emits at most 500 events, merged in
global occurrence order across frame and audio streams. The host repeats
until the cursor `phase` is `exhausted` or `caught_up`. An empty batch with
`phase: "continue"` is not used: skip-only pages are consumed inside the
call. `caught_up` means unsettled rows remain inside the snapshot (poll
after `settle_seconds`). `exhausted` means both snapshot watermarks were
consumed. Incremental rows inserted after the snapshot high-water mark are
picked up by `sync`, not by further backfill.

No token, application credential, account scope, or network permission is
needed. A locked Screenpipe Vault is unreadable here. Unlocking is an owner
action in Screenpipe; Kizuki never asks for or retains the vault password.

For a separate snapshot, quit screenpipe and copy the complete
`~/.screenpipe/` directory so any `db.sqlite-wal` stays with the database.

## Schema this version targets

Minimum supported screenpipe migration: `20260613130000` (2026-06-13, OCR
text unified into `frames`). Verified through `20260828143000` at screenpipe
commit
[`c758770e`](https://github.com/screenpipe/screenpipe/tree/c758770e225324c22778cb949ba7e80fa024d2d2)
on 2026-09-01.

Health fails closed unless required columns match the declared affinity and
nullability contract and the timestamp indexes used by cursor queries exist.
Databases newer than the verified maximum and databases below the supported
floor are refused.

## Privacy

The manifest floor is `private` and is not lowerable. Events carry
`sensitivity_hint: "private"`. Browser URLs in generic metadata default to
origin plus a redacted path: userinfo, query, and fragment are stripped.
`retain_full_urls: true` keeps the full URL and still cannot lower the
private floor.

## Limits

- Screenpipe does not expose a per-row deletion log. The manifest declares
  `tombstones: false` and `purge: false`. `purgeSource()` throws
  `not_supported`. `planUnreachableSourceRecords()` is a read-only planning
  helper: it returns `{ ids, complete, continuation? }`, is capped at 10,000
  ids and a two-second deadline, and never deletes source rows. An incomplete
  page has an opaque continuation bound to the exact subject and the same open
  SQLite connection. Each page runs in a read transaction and checks bounded
  file-instance metadata plus SQLite's `data_version` before and after the
  query. Reopening the source or changing it rejects continuation and requires
  a fresh enumeration rather than claiming completeness. It is never proof of
  complete source erasure. Ledger purge is the
  path that removes imported evidence.
- This package must not attach to screenpipe's live database.
- Timezone-less source timestamps are not assigned UTC. They are quarantined
  unless `timezone` is set to an IANA name or `±HH:MM` offset. Invalid or
  overflowing audio `start_time` values are quarantined, not collapsed onto
  the chunk base time.
- Frames are emitted only after they are at least `settle_seconds` old
  (default 300). A malformed settled row fails the batch before a new
  checkpoint is returned, so it can be corrected or retried without silent
  loss. Health remains degraded with a safe row-kind/id/field failure receipt
  until a successful batch clears it; captured text is never retained there.
  `replayFrom(cursor, { frame, transcription })` rewinds a stream id
  without dropping database identity.
- Cursors bind to the resolved path, the first successful migration
  (version and `installed_on`), and source high-water marks. Compatible
  additive upgrades keep the existing cursor. Replacing, rewinding, or
  rebinding the database fails with `reset_detected`. Re-enroll and
  rebackfill.
- Screen text and transcripts longer than 65,536 JavaScript code units are
  cut on Unicode code-point boundaries and marked with `metadata.text_truncated: true`.
- The optional `since` setting compares normalized instants, not lexical
  timestamp text. Unparseable and offset-unknown boundary rows do not move
  the seed watermark.
- Direct file access sees physically retained rows. It does not enforce
  screenpipe's account-dependent history policy.
- Keystrokes, clipboard data, UI elements, meetings, memories, tags, and
  media files are outside this connector.

These limits and provider facts were checked on 2026-09-04.

## Capture volume

Kizuki's model-free producer creates one capture note per emitted frame or
transcription. A large database therefore produces a large number of claims
for the loop to write and budget against. There is no owner review queue.
Canon writing is bounded by the loop's per-run and per-day write budget;
every write is receipted and reversible. Configure `since` when the host
exposes that option if only recent history is wanted.

## Provider research packet

Checked 2026-09-04 against screenpipe's
[FAQ](https://docs.screenpipe.com/faq),
[architecture documentation](https://docs.screenpipe.com/architecture),
[CLI operating guide](https://github.com/screenpipe/screenpipe/blob/c758770e225324c22778cb949ba7e80fa024d2d2/crates/screenpipe-core/assets/skills/screenpipe-cli/SKILL.md),
and the official database source and migrations at
[`c758770e`](https://github.com/screenpipe/screenpipe/tree/c758770e225324c22778cb949ba7e80fa024d2d2/crates/screenpipe-db).

| Topic | Finding |
| --- | --- |
| Sanctioned access and scopes | Screenpipe does not publish a third-party direct-database protocol. Supported live surfaces are API, MCP, and CLI. This package performs offline file reads with no API scope or remote service. |
| Operator setup | Fully stop screenpipe. Either read its stopped database in place or copy the complete `~/.screenpipe/` directory after shutdown. Never attach this package to the live database. |
| Owner steps | With screenpipe stopped, point the connector at `db.sqlite`, backfill until the cursor is `exhausted` or `caught_up`, then close every Kizuki handle before restarting screenpipe. Use `sync` for later incremental imports. Health checks have the same shutdown requirement. |
| Secret custody | No token or client secret exists for this connector. Locked Screenpipe Vaults are unsupported. |
| History and backfill | All physically retained compatible rows are visible. Kizuki pages them in 500-event batches with independent stream cursors merged by occurrence time. An optional initial `since` skips older IDs by normalized instant. |
| Incremental behavior | Each offline sweep resumes from frame and transcription IDs bound to a database fingerprint. Database replacement or ID rewind fails closed. |
| Edits and deletions | Late OCR is covered only by the settle window. Later redaction, speaker correction, and retranscription are not reread. Screenpipe has retention and range deletion but no deletion log suitable for tombstones. Source-side purge is not supported. |
| Approval, billing, and review | The connector itself has no provider approval or billing gate. These are provider-side gates only; Kizuki itself has no owner review or approval gate (`docs/decision-log.md` D10). |
| Honest fallback | Use screenpipe's API, MCP server, or CLI when it must remain running. Use ledger purge when imported evidence must be removed. |
