# Changelog

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
  token, or a segment the model rejects on its own twice, is skipped with a
  `record_oversized_skipped` receipt that holds the event id, length and
  extracted offset, never the text. `kizuki doctor` and `kizuki serve status`
  print an `oversized records` line, and `kizuki serve retry-skipped` puts
  skipped records back in the queue, resuming after text already filed.

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
- One record can no longer hold the extraction cursor. A rejected response is
  asked again for its first record alone, and a record rejected on its own
  twice is skipped, named in the receipt errors and counted in
  `records_skipped`.
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
