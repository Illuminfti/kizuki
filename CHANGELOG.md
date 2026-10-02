# Changelog

## Unreleased

### Fixed

- Purge is physically total. After it, the purged text is gone from claim and
  proposal payloads (ids, provenance and receipts stay), from archive copies
  and stage images, from the search index and retrieval store, and from freed
  database pages and the write-ahead log (`secure_delete`, a truncating
  checkpoint and a compaction). The canon rewrite of a held page no longer
  archives the page it replaces. `purge --verify` prints one proof per store
  and fails while any store still holds the text; its previous `ok` could be
  empty. A finished purge is only proved, and `--repair` erases what the proofs
  found; a page or archive file the proof cannot read is reported as
  unverifiable. Typed claims bound to a purged event by their support are
  erased too. `kizuki recover` and the daemon sweep finish a purge interrupted after
  its first phase. The ledger migration adds `purge_erasures`,
  `purge_claim_scope`, `purge_suppression_lifts` and
  `purge_suppression_sources`.
- A source record that was purged is no longer captured again silently. Sync
  refuses a record whose connector and source record id match a purge, reports
  `suppressed=N`, and keeps going; `purge` warns with the path of a record that
  still exists at its source. The daemon sync path reports the refusal in the run
  receipt. `kizuki purge --suppressions` lists the refusals
  and `kizuki purge --lift-suppression RECEIPT` lifts them. Purges recorded
  earlier refuse too until lifted.
- Chat, session and email records no longer file one capture-note claim each
  onto a single per-day `captures/<connector>/<day>` page. That page was
  recomposed from all of its live claims on every write and outgrew the canon
  page limit on a busy day. Their text stays in the ledger, so search,
  timeline and context read it with no model, and typed extraction turns it
  into claims when a model is configured. Markdown, wiki and other page-kind
  events keep their capture notes.
- The doctor sweep closes out the capture notes earlier revisions filed for
  such records: each unwritten one becomes `skipped` with reason
  `message_capture_fanout`, is never deleted, creates no canon page, and is
  counted as `captures_skipped` on the run receipt. Doctor reports them on a
  `capture fan-out` line (JSON `claims.capture_fanout`), apart from unwritten
  claims, names `kizuki serve run doctor-sweep` while any are pending, and no
  longer lists them among leftover skipped rows.

### Operator safety

- `serve status`, `serve --install`, `serve --uninstall` and doctor no longer
  read or change the service of a different vault that has the same vault id.
  The installed definition's `--vault` path is compared with the vault in use;
  on a copy, status reports the service as absent for it and names the other
  path, and install and uninstall refuse. An unreadable definition reports the
  service as unknown for this vault, doctor prints a short copy-specific line
  with the command to run, and the app shows a copy as belonging to another
  workspace instead of offering to enable it.
- The verify gate fails on machine-specific absolute home or data paths in
  tracked text, including file URLs and doubled leading slashes, with a small
  allowlist of synthetic names. The existing
  occurrences were removed.
- `undo` on a page changed since the receipt says whether later receipts or a
  hand edit caused it and what to do next. Doctor names `chmod 600` when a
  loosely permissioned `serve.toml` blocks model inspection. Doctor and
  `serve status` fail on a canon write intent pending for over 300 seconds. A
  command with no vault says how to pass or set one. Doctor's claim counts add
  a `live_by_producer` split separating model-extracted claims from
  deterministic-floor claims (page mirrors, capture notes, entity stubs).

### Added

- `kizuki backup --out DIR` snapshots a live vault: it takes the canon writer,
  waits while a canon write is pending, takes an SQLite snapshot of the ledger,
  copies canon and the receipt stream, and writes a hashed `kizuki.snapshot/v1`
  manifest. It needs no `export` purpose, carries no credential and refuses
  while a source revocation is purging. `kizuki restore` reads it and verifies
  it with `--verify`. The manifest and command output report the vault entries
  a snapshot does not carry (non-canon pages, `.kizuki` configuration), and
  restore checks page bytes against their receipts before publishing.
- A connector can now declare `capabilities.cursor_store: "host"` and keep a
  bounded side map (up to 1 MiB and 10,000 entries per connection) that the
  host writes in the same transaction as the checkpoint. The wire cursor still
  has to fit 8 KiB. The map is lent to `backfill` and `sync` as
  `RunContext.cursor_store` and updated through `SyncBatch.cursor_store`; a
  run that does not commit its cursor leaves the map alone. This is ledger
  version 35 (`connector_cursor_store`); existing vaults migrate on open.
- IMAP sign-in ends with an optional date floor (`Only mail since
  (YYYY-MM-DD) [all]:`, stored as `since`). Mail received before it, by
  INTERNALDATE at midnight UTC, is not fetched or remembered.
- `kizuki agent list [--json]` shows enrolled agents with their state, grant
  epoch and grant summary, and never a credential. `kizuki agent grant NAME
  --grant FILE --operation-id ID` replaces an enrolled agent's grant in place:
  the credential and running MCP sessions keep working, the grant epoch rises
  with an audit row, and a retry of the same operation ID is idempotent. An
  unknown or revoked agent and an invalid grant are refused without changes.
- The app's agent setup offers `world_view` among the read tools and an
  owner-correction relay choice that defaults to off.
- Gmail, Google Calendar and X sign-in work on a headless server. When no
  browser can be opened, or with the new `--no-browser` flag, the CLI prints the
  authorization address to stderr with the loopback callback port and an
  `ssh -L PORT:127.0.0.1:PORT <host>` tunnel command, and keeps waiting for the
  callback. Previously the address was never shown and sign-in failed.
- `kizuki connect ics --url https://...` enrolls an https calendar feed with
  ETag-validated re-reads, as its own source and behind separate source
  consent. `--url env:VAR` reads the address from an environment variable so it
  stays out of shell history.
- Model prompts are scrubbed of obvious secrets before they leave for a model
  endpoint. PEM blocks, JWTs, `sk-`, `ghp_`, `github_pat_`, `xox` and `AKIA`
  tokens, `Authorization: Bearer` values, `NAME=value` assignments whose name
  contains `secret`, `token`, `password` or `api_key`, and runs of 12 or more
  lowercase words that read as a mnemonic are replaced by `[redacted:<kind>]` in the typed and legacy
  extraction prompts and in the text a configured judge sees. The ledger is not
  changed; the model's anchors are mapped back onto the original record. Run
  receipts carry the per-kind count as `model.redacted`. The scrubber is a
  documented heuristic, not a guarantee. It covers the `[ports.llm]` extraction
  path and the text its admission judge receives. A configured
  `[ports.systemone]` judge is a separate destination at its own `base_url`: it
  is not named by source consent, not covered by `[ports.llm.provider]`, and not
  shown by `connect status` or `--json` egress. The judge the reflex path uses
  is not scrubbed.
- `[ports.llm.provider]` passes an allow-listed `provider` object
  (`data_collection`, `zdr`, `order`, `only`, `ignore`, `allow_fallbacks`) to
  OpenAI-compatible routers, for example `data_collection = "deny"` and
  `zdr = true`. Unknown keys are refused. The table is not part of the model
  binding that source consent names.
- `kizuki connect status` shows each source's egress destination (endpoint
  host and model, `local only`, or `none`) and retention stance, with the
  provider controls the configured model requests. `--json` reports `egress`;
  `connect status --source KEY` reports it too.

- `kizuki version` identifies the exact build. A release package prints
  `VERSION source=<source revision> built=<UTC time>` from values compiled in by
  `build:release`; a run from source prints `VERSION dev`. Anything that
  parsed the whole line as a bare version number should read the first word.
- `docs/upgrade.md`: a runbook for upgrading an installed package in place
  (stage the new version directory, file-level backup with `sqlite3 .backup`,
  install from the new real path, verify, roll back), with a scripted test that
  upgrades and rolls back a fixture package over a fixture vault.
- Release smoke runs `kizuki world --operation find_concepts --json` and an MCP
  `world_view` call against the built package, and checks that `kizuki version`
  matches the package's `BUILD.json` revision.
- `kizuki connect claude-code-sessions --source PATH` and `kizuki connect
  codex-sessions --source PATH` capture the text turns of Claude Code and Codex
  session transcripts as private `message` events, so decisions and changes of
  direction made in a coding session reach the ledger. Both read a local folder
  offline through one shared parser (`@kizuki/connector-agent-sessions`).
  Thinking, tool inputs and tool results are never captured; secret-shaped
  strings, terminal escapes and bidirectional controls are removed before
  capture; turns carrying Kizuki's own context packet are skipped. A pass reads
  only files modified since its watermark and resumes mid-file inside the 8 KiB
  cursor bound. No tombstones are emitted. See
  [Coding-session transcripts](docs/connect.md#coding-session-transcripts).
- `[extraction] max_calls_per_day` (1 to 100,000, default 1,000) and
  `max_output_tokens_per_day` (1,024 to 1,000,000,000, default 4,000,000)
  bound model spend per UTC day, rejected requests included. A pass that finds
  one spent makes no request and stops as `model:budget_day`. The `throughput`
  line in `doctor` and `serve status` shows both.
- A systemic-rejection breaker: when three different records are rejected the
  same way in a row, the pass stops as `model:systemic_rejection`, backs off
  (15 minutes, doubling to 6 hours, stored durably) and asks again with one
  single-record probe. Records passed over during the streak go back on the
  deferred queue and are not counted as skipped in that pass. A probe refused
  alone twice skips that record for good and doubles the wait, so a run of
  poison records drains one per wait instead of wedging extraction. An
  unreadable stored history counts as a fresh wait, never as none.
- Run receipts carry `model.consecutive_rejections` and
  `model.last_rejection_rule` while a refusal streak lasts.
- `kizuki hook session-start --harness claude-code|codex|generic` injects a
  compact, bounded, provenance-labelled context block at harness session start.
  It reads the hook JSON on standard input, prefers the running daemon's
  loopback endpoint, falls back to a direct read it can stop at `--timeout-ms`,
  attributes the call to the agent named by `--token-ref`, and exits 0 with no
  output on a timeout, denial, missing vault or any error. The daemon now
  records where its loopback endpoint listens in `.kizuki/serve.endpoint`, an
  owner-only file that holds no credential and is removed at shutdown.
- A default `purpose=session` context packet gains `owner`, `now`,
  `commitments` and `uncertain` sections read from authorized claims and
  Situations, each bounded and each listed with a reason when empty. The
  response reports them in `data.session`. Situation content needs the
  `world_view` grant.
- Session sections list only claims that are current at the packet's time, label
  every member of a contradiction with its taint and sensitivity, and report
  `unavailable` when a full candidate window held nothing usable. A one-line
  note tells the reader that state lines are data unless clean and owner
  authored. The daemon's endpoint file is trusted only when it belongs to the
  current boot, and a failed write of it no longer stops the daemon.
- [Integration recipes](docs/integrations.md) for Claude Code, Codex and any
  stdio MCP client.
- Everything Kizuki serves to an agent passes one output seam that reuses the
  model-prompt scrubber. PEM blocks, JWTs, `sk-`, `ghp_`, `github_pat_`, `xox`
  and `AKIA` tokens, `Authorization: Bearer` values, `NAME=value` secret
  assignments and mnemonic-like word runs become `[redacted:<kind>]` in search,
  `get_page`, `timeline` and its expansion, every `context_packet` section,
  `query_entities`, `graph_neighbors` and `world_view`, over MCP stdio, loopback
  HTTP and the session hook. The envelope adds `redacted`, the per-kind count of
  replaced spans, and never a value. Redaction runs before an excerpt, preview
  or expansion window is cut and before a packet is packed, so a secret cannot
  survive a cut and the token budget stays exact. The owner keeps raw text. The
  scrubber is a heuristic; see [what an agent is served](docs/agent-enrollment.md#what-an-agent-is-served).

- A source policy for an owner-mapped importer (`import-legacy-wiki`,
  `import-legacy-events`) may set `sensitivity_default`, so the labels its
  mapping wrote decide the tier once you regrant: a page labelled `personal` is
  stored `personal`, and unlabelled or unreadable pages stay `private`. Nothing
  changes for an existing grant until you regrant.
- A source policy may carry `class_rules` (path globs marked `machine_exhaust`
  or `credential`), and capture stamps a `credential` class on evidence that
  matches the shared secret patterns. Agent grants gain the optional
  `deny_classes`; when absent it denies `credential`, so existing agents lose
  credential-shaped material and nothing else. `agent list` shows the effective
  list. Ledger migration 36 adds the class table and stamps stored events.
- Grants may name subject ids with spaces and other printable characters, as
  importer subject mappings produce them.
- `system_health` reports `pages.withheld` and, to the owner, the path of each
  page file that could not be read.

### Fixed

- Export no longer refuses because of a disconnected source that holds no
  exported event, and it checks each source's grant once instead of once per
  claim and per event; a 3,000-event, 3-source vault exports in seconds where
  a production-size vault took over an hour. `connect status`, `grant`,
  `revoke` and `resume-revocation` now work on a disconnected source.
- A restored vault recreates its receipt journal, so `kizuki doctor` reports
  no orphans and status ok. Restore prints the agents to enroll again.
- A first Telegram backfill of an account with more than about 125 dialogs
  stored nothing and repeated forever, because the per-dialog cursor passed
  the 8 KiB checkpoint bound. The per-dialog map now lives in the host cursor
  store, so accounts up to the 5,000 listed dialogs backfill, and a batch stops
  between dialogs after about 40 seconds so a slow account takes more batches
  instead of hitting the 60 second call limit. Cursors written by the old
  version still read and migrate. The cursor schema is
  `kizuki.telegram-cursor/v2`.
- IMAP mailboxes with many UID gaps (30 percent gaps at 5,000 UIDs already
  passed 8 KiB) could not checkpoint. The per-folder seen set and retry list
  now live in the host cursor store; the cursor schema is
  `kizuki.imap-cursor/v2` and v1 cursors still read and migrate. Marking the
  messages of a page as seen is one merge per page instead of one per message.
- Machine output is no longer cut off when stdout is a pipe. The CLI wrote
  through an asynchronous stream and then exited, so a `--json` document larger
  than the pipe buffer (64 KiB or less, depending on the reader) reached
  `| jq` or a hook truncated and unparseable. Every command's stdout and stderr
  now go out with a synchronous write that waits for a slow reader; a reader
  that closes early ends the output quietly.
- `correct` now applies a grant's class denial on every ledger, including one
  with no source grants: a claim whose evidence carries a withheld class is
  absent to that agent, dry run or not.
- The daily brief is stamped private when it names a page that ever received a
  private receipt (a repair never lowers it), says when rail failure groups
  were omitted, and the brief repair also rewrites the run-id
  stub a failed brief run leaves behind, skips oversized files, and names the
  day of a page it could not repair.
- `max_calls_per_day` now charges every request a legacy producer makes for one
  record, not one per record.
- Structural claim deduplication now requires overlapping validity. A claim
  with the same key, polarity and object but a disjoint or merely adjacent
  validity window is stored as its own claim instead of being merged into an
  earlier one, and it no longer raises authority through cross-connector
  corroboration. Overlapping windows still corroborate.
- The standing HTTP endpoint compares its bearer token in constant time.
- MCP `world_view` can be called from its advertised schema. `tools/list` now
  lists the operation and its fields with their defaults, so
  `{"operation":"find_concepts"}` alone works, where the schema used to be
  empty.
- MCP `tools/list` is about 33 KB instead of about 185 KB: `world_view`
  advertises a summary of its answer (the server still checks every answer
  against the whole grammar) and each tool states only the result lists it can
  fill.
- MCP `tools/list` names only the tools the principal's grant allows.
- Denied and invalid `world_view` calls are audited and count toward the rate
  limit; the audit row used to roll back with the refusal.
- Served canon reads (MCP tools and the loopback host) no longer parse the
  whole vault on every call. Parsed pages and their resolved authority are kept
  for the life of the process and refreshed when a file or the receipt history
  changes.
- The MCP adapter no longer runs schema repair writes when it starts on a
  current ledger, so a long writer no longer delays or refuses startup.
- The connector catalog no longer labels Gmail or IMAP a local source, and
  `kizuki.import-beacon` has a title instead of its raw id.
- The embed-backfill rail no longer wakes every minute when no embedding port
  is configured: it backs off to an hour and returns to a minute when the
  service starts or on its next run after `[ports] embedding` names a port.
  `kizuki doctor` prints `vector layer: off (no embedding model configured)`,
  `vector layer: configured (<port id>)` or `vector layer: invalid (<reason>)`
  for an id the host cannot bind, and an idle embed rail is no longer reported
  down for producing nothing. The CLI and doctor read `[ports] embedding`
  through one validator.
- A scheduled run that did nothing no longer appends a run receipt per tick. The
  first idle run after activity is receipted, later ones only advance the
  schedule, with at most one idle receipt an hour per rail. Doctor takes rail
  liveness from the schedule as well as receipts and counts the empty streak in
  elapsed periods, so its sensitivity is unchanged. The fixture qualification
  observer credits an idle slot from the schedule row and accepts the embed
  rail's back-off period. The daemon's receipt count includes only receipts it
  persisted.
- `journal-prune` bounds `run-receipts.jsonl` by size as well as age (oldest
  receipts dropped past 8 MiB, rows and file kept in step), and no longer
  rewrites the journal from only the newest 10,000 rows. The prune always keeps
  the newest receipt and replaces the file atomically before deleting rows.
  Doctor reads at most the newest 5,000 run receipts and scans the newest 1 MiB
  of the journal for orphans.
- A rejected request no longer stalls the queue head at the default one step
  per pass. The narrowed retry, the first record alone, is now stored with the
  extraction cursor, so the next pass sends it and a record rejected on its own
  twice is skipped through the existing skip path.
- A model that rejects every request no longer makes `max_calls_per_pass` of 2
  or more skip the whole ledger without claims.
- A response rejected whole, including `finish_reason=length`, now records the
  input and output tokens the provider billed in receipts and usage rows
  instead of zero.
- World reads no longer claim completeness they do not have. `kizuki world`,
  MCP `world_view` and HTTP `/v1/world_view` now report `partial` coverage with
  a `coverage` gap when a source the caller can read has unfinished history
  import or a failed last capture run, and with a `pending_consolidation` gap
  when a readable, extraction-granted source has events extraction has not yet
  consumed. An empty discovery in that state is `partial` instead of
  `complete_for_query`. Sources and events the grant hides never affect the
  result.
- Label search in `find_concepts` and `find_situations` is case-insensitive with
  Unicode folding, and is paginated: the previous 32-match cap is now the page
  size, and results carry an opaque `cursor` (null on the last page) that
  `kizuki world --cursor`, MCP and HTTP accept. One request examines at most a
  fixed number of handles; past that it returns a cursor with a `traversal_limit`
  gap rather than scanning the whole vault.
- `kizuki doctor` reports `status=failed` only for real failures and names
  them. An idle rail with no pending work is healthy: the empty streak counts
  only runs that had work waiting (extract backlog past the cursor for a
  granted source, unwritten live claims, consented sources no run has reached,
  pending retrieval operations), and `brief`, `journal-prune`, `doctor-sweep`,
  `purge-sweep` and an unconfigured `embed-backfill` are judged by staleness and
  failure only. A rail whose last five runs ended degraded or stopped, without
  applying retrieval work or shrinking its pending count, is down with the error
  most of them share (including the codes a rail reports in `retrieval.degraded`),
  and a failed rail says why it failed. A bounded catch-up pass that drains a
  large index backlog is progress, not a fault, and so is extraction that
  answered but filed no new claim (deduplicated drafts, skipped records). The
  degraded streak applies to every rail except `doctor-sweep`, and only while
  the newest receipt is not stale, so an uninstalled service stops failing.
- The model line reflects the daemon, not whether the doctor process can
  resolve the model secret. The configured model reference now carries its
  `@host` exactly as run receipts record it, so from a shell without the secret
  doctor prints `canon writing: configured; daemon last_success=... last_failure=...
  consecutive_failures=N` and says `unverified` only when the daemon left no
  receipts. `doctor` gains an `extraction` line (backlog past the extract cursor,
  `last_extracted_at`, and the setting to change after repeated truncation) and
  an `egress` line per source that sends text to a model (endpoint host, model,
  retention).
- The constant `identity authority: unavailable` line and the
  `identity-authority-unavailable` entry in every context packet's degraded list
  are gone. Doctor lists the canon files the index cannot read, and reports
  `index-degraded` only while one exists.
- The closing `next:` line follows from the top failure and no longer suggests
  `kizuki tell` for a failed report.
- Connections show `last_run_clean` (the last run recorded no error) instead of
  `backfill_complete=no` forever for a source that is only synced. It makes no
  claim about what is left upstream, because the checkpoint keeps no cursor
  exhaustion. `doctor --json` keeps `backfill_complete` beside it.
- Doctor reports a canon page held out of the index by an open hold or write as
  `index-degraded` (a rebuild does not clear it), says when the canon walk was
  truncated, and words a degraded stamp with nothing skipped or held as possibly
  stale. The `index-degraded` flag on query and context responses still follows
  the derived stamp; it clears at the next `kizuki rebuild`, not on an
  incremental refresh.
- The failure a report leads with is now structured (`top_failure`), so the
  `next:` hint no longer reads failure text, and a down rail's hint points at
  the read-only `kizuki serve status` instead of running the rail.
- The daemon, `kizuki doctor` and `kizuki serve status` read whether an
  embedding port is configured from the same configuration, so the
  `doctor-sweep` receipt judges `embed-backfill` as doctor does. The sweep and
  `kizuki rebuild` no longer walk every canon page to read one field.
- Doctor reads the newest 2,000 sync receipts and the newest 200 of each other
  rail instead of a week of receipts, and the `doctor-sweep` rail now records
  the failures doctor would report, so its status matches.
- Captured and canon text in a context packet is blockquoted line by line, and
  titles and paths stay on one line, so a page or capture that contains a line
  imitating a packet stamp cannot pass for one. Unicode tag characters and
  bidirectional controls are removed from served text for every principal.
- `system_health` for an agent reports counts over what its grant can read and
  the connections that feed that view; the vault-wide page, event and claim
  totals, agent counts, runtime, derived-index times, retrieval backlog and
  per-connection run results are owner only.
- `correct`, `propose` and a `context_packet` task capture refuse an id the agent
  cannot read exactly as they refuse one that does not exist, so neither
  existence nor tier can be probed. A denied task capture no longer reports
  `reason: "denied"`.
- A claim object or a task-capture value with a Unicode line separator can no
  longer start a packet line of its own, and the packet hash covers the served
  path. `world_view` labels lengthened by redaction are cut back to the schema
  bound, `system_health` for an agent reports `counts_capped` when its counts
  stop at the bound and derives connections without that bound, and an unreadable
  provenance or correction target is refused generically while the owner's audit
  row keeps the real reason.

### Changed

- Ledger hits from `kizuki query` and the MCP `search` tool carry an excerpt of
  the captured text, at most 600 characters, instead of the whole record, and
  mark it `truncated: true` when it was cut. `kizuki query --full-text` and the
  `full_text` search argument return whole records. Canon hits are unchanged.
- `bun run test` and `bun run verify` run `bun test --timeout 120000`, so a
  loaded machine does not fail tests at Bun's 5-second default. A test's own
  explicit timeout is unchanged. The CLI test helper kills a child process that
  has not exited after 90 seconds and fails that test with a clear message.
- Claims take their sensitivity from the sources of their own provenance
  events, not from every source of their connector, so one private source no
  longer raises the claims of its siblings.
- A canon page is readable to a time-scoped grant when every source it cites is
  inside the window; before, no page was.
- One unreadable or symlinked canon page file no longer fails every canon read
  with `serving failed`; it is skipped and named by `system_health`.
- A refused `kizuki export` now names the sources that block it and the exact
  grant or revocation command that clears each one, instead of a bare
  `source_export_denied`. The consent rule is unchanged: export still needs the
  `export` purpose on every source.
- The canon writer now updates a page the loop already materialised. A claim
  whose target was written earlier under the machine-origin `auto/` prefix used
  to be planned as a create and fail with `page ... already exists` on every
  pass, so later claims for that target never landed. The arbiter now finds the
  page under `auto/` and edits it through the receipted writer, before and
  after hashes included. A page at the target's own path still wins.
- The daily brief is now a bounded summary of what changed since the previous
  brief: new, updated, corrected and undone canon pages, rail runs that
  failed, degraded or stopped, and the extraction backlog (live claims not yet
  written, ledger events past the extraction cursor, deferred inputs). It is
  never just boilerplate, and its page carries valid frontmatter with
  `sources: []`.
- Daemon-written briefs are classified as machine origin in `kizuki doctor`
  and in retrieval candidates; other pages under `dashboards/` stay human.
- A daemon-written brief that fails the page schema, such as one an older
  build wrote without `sources`, is rewritten by the next brief or doctor-sweep
  run through the same notifier, keeping its body. The run receipt records
  `pages_repaired`. A page that cannot be rewritten degrades the run with
  `brief-repair-failed` and is tried again on the next sweep.

## 1.0.2 (2026-09-24)

### Added

- Extraction throughput is now owner-configurable in
  `<vault>/.kizuki/serve.toml`. `[extraction]` takes `max_calls_per_pass`
  (1 to 256, default 1), `records_per_request` (1 to 8, default 2),
  `max_input_tokens` (2,000 to 32,000, default 8,000), `max_output_tokens`
  (1,024 to 16,384, default 8,192) and `max_pass_seconds` (30 to 600, default
  60). `[serve] sync_period_s` (60 to 86,400, default 900) sets the sync
  rail's period and takes effect at the next service start. Without these keys
  a pass does what it did in 1.0.1: one request of at most two records.
  `kizuki doctor` and `kizuki serve status` print the effective values on a
  `throughput` line. Each step of a pass files its claims and commits the
  cursor before the next request, so a kill loses at most the request in
  flight. To drain a backlog:

  ```toml
  [serve]
  sync_period_s = 300

  [extraction]
  max_calls_per_pass = 64
  records_per_request = 2
  max_pass_seconds = 300
  ```

  Passes run back to back while the sync rail is due, so keep `sync_period_s`
  no longer than `max_pass_seconds`. See
  [extraction budgets](docs/extraction-budgets.md#owner-throughput-settings).
- `[ports.llm] reasoning_effort` sets the chat-completions `reasoning_effort`
  field on every model request: `none`, `minimal`, `low`, `medium` or `high`,
  for example `reasoning_effort = "low"`. Unset sends no field. A model with
  mandatory reasoning needs it: its hidden reasoning counts against
  `max_output_tokens`, and without a lower effort it can spend the whole
  reservation, so the response is truncated and rejected. `kizuki doctor` and
  `kizuki serve status` show the effective value next to the bound model, or
  `provider-default` when unset, and `doctor` reports a value outside that
  list as `model configuration invalid` (`model_config_error` in `--json`).
  The value is not part of `model_ref`, receipts or source consent.
- A typed record that no request can carry whole, because it is longer than
  24,000 characters or its request exceeds `max_input_tokens`, is extracted in
  segments, one request per segment. A split falls on a paragraph break, else
  a line break, else a word boundary. Anchors are moved back to record offsets
  and checked against the original text before anything is filed. Segment
  progress is kept in the new `extract_oversized_records` table (serve schema
  9, carried by backups), so a kill resumes at the next unfinished segment.
  Each segment is one step of the pass, so the stop request, the pass time
  budget and the short writer hold apply to it.
- A record that cannot be split safely, such as a single 30,000-character
  token, a record whose segments no request can carry, or a segment the model
  rejects on its own twice, is skipped with a `record_oversized_skipped`
  receipt that holds the event id, length and
  extracted offset, never the text. `kizuki doctor` and `kizuki serve status`
  print an `oversized records` line, and `kizuki serve retry-skipped` puts
  skipped records back in the queue, resuming after text already filed.
  Restore refuses segment offsets that fall inside a character.

### Fixed

- A legacy-wiki source whose rows predate page hashes failed every sync with
  "wiki committed identities are incompatible with scan policy" and never
  committed a cursor. Such a row now heals: the page is emitted again with its
  hash, and a page deleted since is still withdrawn.
- A wiki page longer than a staging proposal body (64,000 UTF-16 units) failed
  its whole batch. Staging now stages the head of the page, marked
  `x-body-truncated: true`, and the ledger keeps the page text up to the
  existing 262,144-code-point cap. A long page that an earlier build stored
  but never staged is planned and staged again.
- Sync run receipts and `kizuki doctor` name the underlying reason when a
  source fails, instead of only "connector <id> sync failed" or an error
  count. The reason passes through the receipt redactor.
- HTTP 429, 502, 503 and 504 retries back off exponentially from two seconds,
  or wait for the provider's `Retry-After`, capped at 30 seconds per wait. A
  wait the request deadline cannot cover reports the provider's refusal
  instead of a timeout, and an HTTP 200 body with an `error` object and no
  choices is treated as that HTTP failure. A request still refused with 429
  ends the pass as `model:rate_limited` (status `stopped`, not `failed`), and
  the next pass resumes from the durable cursor.
- A sync pass no longer holds the vault writer across a model request, so
  `undo`, `tell`, purge and `kizuki serve stop` go through while a request is
  in flight. `kizuki serve stop`, SIGTERM and SIGINT end a pass before its
  next step.
- With `max_calls_per_pass` set to 2 or more, one record can no longer hold
  the extraction cursor. A rejected response is asked again in the next step
  for its first record alone, and a record rejected on its own twice is
  skipped, named in the receipt errors and counted in `records_skipped`. With
  the default of 1, the next pass sends the same request again, as in 1.0.1.
- Doctor judges a pass by its final request, so a rejection that a later
  request answered past no longer shows as a current failure.
- A typed claim that parsed but failed the journal-time check "resolved claim
  is not a canonical typed assertion" failed the whole sync run after earlier
  steps had filed. It is now dropped and counted under
  `claims_rejected.invalid_claim`, like other invalid typed claims, and its
  siblings are filed.
- A typed claim with an explicit or observed time basis but no start is
  dropped as `invalid_claim` instead of failing the run.
- A typed request next to a record its source grant holds back failed filing
  with "extraction inputs changed during model call". The journal now
  rebuilds the request from the records it actually sent.

## 1.0.1 (2026-09-24)

### Fixed

- The background service no longer runs out of memory during sync. Bun's
  `query()` cache keeps only 20 SQL strings, and every other query prepared a
  new statement that the connection tracked until the next full collection. A
  sync pass that wrote canon pages prepared about 32,000 statements per write
  and reached the service's 2 GiB limit, so the service was killed and
  restarted every 15 minutes. Each connection now keeps a bounded statement
  cache (512 SQL strings) in front of Bun's, and a statement left mid-iteration
  is finalized. On a vault with about 2,700 canon pages, one sync pass now
  peaks near 300 MB instead of passing 3 GB.
- The receipt for a sync run that was killed after its model call now says
  "sync interrupted after model decision" instead of blaming extraction.

## 1.0.0 (2026-09-23)

First public release. See [docs/CURRENT.md](docs/CURRENT.md) for what this
version ships and its known limits.

### World model

- Typed extraction (`kizuki.producer-response/v2`) admits source-anchored
  claims about Concepts and Situations when a model and a source grant that
  permits extraction are configured. Each call takes at most four records. A
  well-formed claim that breaks its own rules is dropped and counted instead
  of rejecting the whole response, and the configured model timeout bounds
  the call.
- `kizuki world` discovers Concepts and Situations and reads one card. The
  same projection is served as the MCP `world_view` tool, loopback HTTP
  `/v1/world_view` and the World views in `kizuki app`.
- `kizuki tell --world-claim` and MCP `correct` correct a world claim. The
  preview and the result name the predicate and the old and new values.
- The ledger schema is now version 33. `kizuki init <vault> --no-default`
  migrates an existing vault; `doctor` and `serve` name that command until it
  has run.

### Telegram

- Native sign-in uses the project app credentials compiled into the release
  package. The AES code is an MIT `node:crypto` implementation instead of a
  GPL dependency.
- Connect, the first state probe, `getMe` and sign-out each have a 45-second
  deadline. A network that never opens fails in seconds instead of hanging,
  and closed clients no longer leave a keep-alive timer running.
- Ctrl-C during sign-in prints one line, and a refused phone number gets an
  example of the expected format.

### Daemon and recovery

- Canon-write recovery classifies each staged file against the write intent.
  Exact stages are removed, foreign stages of an ordinary write are
  quarantined rather than deleted, and unsafe stages hold recovery.
  Withdrawal, purge and erasure also remove the stage traces of the receipts
  they erase.
- A held recovery no longer stops `kizuki serve`: the other rails keep
  running, and `doctor` and `recover` report the reason and the next step.
- Startup refusals that repeat on every start exit 78, and the user unit does
  not restart on that status; a possibly transient custody failure exits 1.
  The unit gains a start limit and `MemorySwapMax=0`, and doctor names the
  command that follows from the unit's last result.
- The broker removes stale custody sockets before it listens, and the native
  helper is compiled once per process instead of on every call.

### Fixes

- Historical World migration, ledger migration of deferred extract rows,
  audit page read cost, a module import cycle, and the legacy-revision
  provenance reason.

### Known limits

- The release package is an unsigned Linux x64 build. Nothing is published to
  npm. Other platforms run from a source checkout.
- Sign-in connectors, including Telegram, have no recorded live-account
  qualification on this version.
- World Slice, World Diff, revision resume, outcomes, attention, forecasts and
  Atlas are still roadmap.
