# Extraction budgets and durable progress

Model extraction uses budgets separate from canon writing. By default typed
world extraction (producer v2, every consented source) makes one model request
per serving pass, with at most two records, 8,000 estimated input tokens and
8,192 reserved output tokens per request: a typed response carries anchors and
perspective for every claim, and a truncated response is rejected whole. The
epoch-zero legacy producer keeps at most two model calls, 8,000 estimated input
tokens and 2,000 reserved output tokens per request. Canon write limits do not
increase these model allowances.

Reasoning models count their hidden reasoning against the same output
reservation. A model that spends it all before answering returns a truncated
response, which doctor reports as `model response rejected: response
truncated`. The next request asks for the first record alone, even when it is
the next pass's, and a record whose answer is still rejected on its own is
skipped without claims, so one bad record cannot stall the queue. A model that
rejects every record the same way is stopped by a
[systemic breaker](#rejected-responses-and-daily-budgets) rather than being
allowed to skip the ledger. Set `reasoning_effort = "low"` (or `"minimal"`) under
`[ports.llm]` in `serve.toml` to shorten the hidden reasoning, choose a
non-reasoning model, or reserve more output tokens. Doctor and `serve status`
show the effective setting next to the model, and once three passes in a row are
rejected as truncated the `extraction` line says which of the two settings to
change. See the
[LLM port configuration](../packages/llm/README.md#config-portsllm).

## Owner throughput settings

The owner can raise throughput in `<vault>/.kizuki/serve.toml`. Every key is
optional, and the defaults below are the behavior described above:

```toml
[serve]
sync_period_s = 900        # 60..86400; sync rail period

[extraction]
max_calls_per_pass = 1     # 1..256; extraction steps one sync pass may take
records_per_request = 2    # 1..8; typed extraction only
max_input_tokens = 8000    # 2000..32000; typed extraction only
max_output_tokens = 8192   # 1024..16384; typed extraction only, reasoning included
max_pass_seconds = 60      # 30..600; no step starts after this many seconds
max_calls_per_day = 1000   # 1..100000; model requests per UTC day, rejected ones included
max_output_tokens_per_day = 4000000  # 1024..1000000000; billed output tokens per UTC day

[budget]
canon_writes_per_run = 32  # 0..10000; canon pages one sync pass may write
```

A value outside its range, a fraction or a string keeps that key's default.
`kizuki doctor` and `kizuki serve status` print the effective extraction and schedule values on one
`throughput` line, and `doctor --json` and `serve status --json` report them as
`serve.throughput`.

- **Steps per pass.** A pass takes up to `max_calls_per_pass` extraction steps.
  A step files a pending decision if one exists; otherwise it makes at most one
  model request, journals the accepted decision, files its claims and commits
  the cursor in one transaction before the next step starts. A kill therefore
  loses at most the request in flight, and the next pass resumes from the
  durable cursor. A rejected response (malformed, truncated or refused) is
  asked for once more, for the first record of the rejected request alone,
  because a nondeterministic model often answers a smaller request well. The
  decision to narrow is stored with the extraction cursor, so it holds when the
  next request is the next pass's, as it is at the default of one step. A
  record rejected again on its own is skipped: the cursor moves past it without
  claims, the receipt names the reason (`record skipped: rejected on its own
  twice`) and counts it in `records_skipped`, and the pass goes on. A typed
  record too large for one request is asked for one segment per step, or
  skipped with a receipt when it cannot be split; see
  [records too large for one request](#records-too-large-for-one-request).
  Whatever the number of steps, one record cannot hold every later one. A pass
  ends early when the ledger is drained, the epoch-zero producer refuses a
  request before sending it, a commit finds the cursor moved or its inputs
  purged, or the model is unavailable. Steps that make no request, such as
  advancing over records a source grant does not cover or skipping a record,
  still count toward the limit, so the default pass is the same single step as
  before.
- **Time per pass.** Once `max_pass_seconds` have passed, the pass starts no
  further step; the request in flight finishes and is filed, and the next pass
  resumes from the cursor. Rails run one at a time, so this bounds how long a
  pass keeps retrieval, purge and embedding catch-up waiting. Passes run back
  to back while the sync rail is due, so for continuous extraction set
  `sync_period_s` no longer than `max_pass_seconds`.
- **Per-request limits.** `records_per_request` and the two token reservations
  bound each typed request. More records per request need a larger output
  reservation: an ordinary record's anchored response runs to one to three
  thousand output tokens. The per-request input estimate, the quoted-character
  bound and the rejection of a truncated response stay in force.
- **Sync period.** The sync rail's period lives in the persisted schedule. A
  service start (`kizuki serve`, including the installed unit) applies
  `sync_period_s` to it after replaying the receipt journal. A shorter period
  also brings a later due slot in to one new period from now; a longer one
  never pushes a due slot back. Until the next start, the `throughput` line
  shows the configured value beside the effective one.
- **Memory.** Each step reuses the connection's cached statements and finalizes
  the ones it prepares itself, so a long pass does not accumulate statements
  or heap. Canon writing after extraction keeps its own limits, including at
  most `canon_writes_per_run` canon writes per pass (see
  [canon writes per pass](#canon-writes-per-pass)).
- **The writer during a pass.** A pass holds the vault writer only for local
  durable work: filing a step's decision and cursor, and each canon write. It
  takes and releases the writer for every page, and stays away from it for a
  moment between pages, so waiting `tell` and `undo` commands can acquire it
  before the pass finishes. Other operations can acquire it during the same
  gap, but keep their existing busy-writer behavior.
  `kizuki tell` and `kizuki undo` wait up to 30 seconds for a write in progress
  before they report `writer_busy`. The pass never holds the writer across a
  model request either. An answer that arrives after a purge or
  another pass changed its inputs or the cursor is discarded, never filed. An
  answer waits up to five seconds for a writer another operation holds; after
  that the pass stops as `lock:busy` and the next one asks again.
- **Stopping.** `kizuki serve stop`, SIGTERM and SIGINT end a pass before its
  next step, and before the next canon page. The request in flight finishes and
  is filed, the page being written finishes, later pages wait for the next
  start, and the receipt stops as `serve:stop_requested`. The
  service's stop timeout therefore needs to cover one request, not a pass.
- **Model health.** A pass is judged by how it ended. The receipt's
  `model.answered` counts the requests the model answered, and
  `model.last_request` says whether the final one was answered; its
  `model.diagnostic` belongs to that final request. Doctor treats a pass with
  any answered request as a success for `last_success`, and reports a current
  failure only when the latest pass's final request failed. A rejection that a
  later request in the same pass answered past stays counted in
  `claims_rejected` and the receipt's errors. Rails that waited behind a
  multi-request pass get `max_pass_seconds` of extra grace before doctor calls
  them stale, and the `throughput` line shows `records_skipped` for the doctor
  window. A shell that cannot bind the model reads the same receipts under the
  model reference with its host, so `doctor` prints the daemon's `last_success`,
  `last_failure` and `consecutive_failures` from there, and a rail whose last
  five passes all ended degraded is down with the error most of them share.

Requests stay sequential. Each step's input is planned from the durable state
the previous step left: the committed cursor, the deferred queue and its scan
marker, and the current source revision. The journal holds one pending
decision whose previous cursor must equal the committed one. Concurrent
requests would have to be planned against state that does not exist yet and
thrown away whenever an earlier request fails, and filing would no longer
follow a single order.

## Canon writes per pass

After extraction the pass writes canon one page at a time, up to
`[budget] canon_writes_per_run` pages (default 32; the daily ceiling
`canon_writes_per_day` still applies). A value below 32 stops the pass at that
many pages as `budget:canon_writes_per_run`. From 32 up the pass ends `ok` when
it reaches the number and the next pass continues; a value above 32 used to
change nothing, because the pass ended at 32 whatever the setting. A vault with
a long queue can raise it, and one with a slow model can lower it.
`doctor --json` reports it as `serve.model.budget.canon_writes_per_run.limit`.

After the graph registry has been initialized, a receipted write assesses
only that page's evidence and refreshes its edges and the incoming links whose
resolution changed. Indexed page names resolve those links without loading
the entire registry or walking the vault. A cold or discarded registry takes
one full reconciliation before writer acquisition. Changed source consent and
source tombstones reassess affected pages before acquisition as well. Ordinary
derived refresh and rebuild still reconcile files added, removed or rewritten
outside the writer; a canon write does not
scan unrelated files for edits. Serving checks current evidence on each read.
Pass accounting reads only receipts appended during the page's writer hold,
plus live reservations and intents.

Ordinary receipt checkpoints reuse process-local validation only while the
journal's file identity, size, permissions and modification metadata match.
Completion appends and reads back the exact new receipt line. Restart recovery,
external journal changes and receipt redaction retain full prefix validation.

A typed page group that fails three passes is named in the receipt's typed
`canon_quarantined` entries with its handle, generated page path, failure
count and retry time. Error strings remain fully redacted. After
three failed passes in a row the page is set aside for 24 hours: later passes
skip it, so groups behind it are written, and the receipt says
`set aside until <time>`. When the day is over the page is tried once more; a
failure sets it aside for another day, a success forgets it.
`kizuki doctor` and `kizuki serve status` print `quarantined typed pages=N`,
and doctor adds a `quarantined` line with the path, handle, failed passes, end
of the wait and last error of each. A set-aside page is not a service failure.
Restored reasons receive the same redaction and length bound before display.
The state is one `rail_cursors` row per handle, so it survives a restart and a
backup.

## Rejected responses and daily budgets

A rejected response is a response the port refused whole: truncated at its
output reservation, refused by the provider, or not a valid typed response.
The provider still billed it.

- **Metering.** A rejected response that carries a `usage` block, including
  one that ended with `finish_reason=length`, records its input and output
  tokens in the run receipt and in the pass's usage row, like an answered
  request. A provider that sent no usage block, or a malformed one, counts
  zero tokens; the request itself is always counted.
- **Systemic breaker.** A record rejected on its own twice is skipped, but the
  same rejection for three different records in a row, with no answer between
  them, means the model may be failing, not the records. The pass then stops as
  `model:systemic_rejection` and skips nothing further. Records passed over
  since the streak began are put back on the deferred queue, so they are
  decided again once the model answers, and the pass's receipt does not count
  them in `records_skipped`. Receipts of earlier passes already reported those
  skips: `records_skipped` is a per-pass tally, so a total summed across
  receipts can include records a later trip queued again. Rejections that
  differ, such as a truncated response followed by a malformed one, do not add
  up. Any answered request ends the streak.
- **Backoff and probes.** After the breaker trips no request leaves for 15
  minutes, then 30, 60 and so on up to 6 hours. The wait is stored with the
  extraction cursor, so it survives restarts. A pass inside the wait makes no
  request and stops as `model:systemic_rejection` with a receipt error that
  names when it ends. A trip is a pause, not a verdict: it forgets the three
  records it counted, and the first request after the wait is a probe for one
  record alone. The probe record is narrowed and, refused alone twice, skipped
  for good; the pass then stops and the wait doubles. A run of poison records
  therefore drains at most one record per wait, and the first answered request
  ends the streak and resets the wait. A model that fails everything costs the
  same bound: one record per wait, at most a handful per day at the cap. A
  stored history that cannot be read is treated as a fresh 15 minute wait, never
  as no history, so a damaged row cannot lift a backoff.
- **Daily budgets.** `max_calls_per_day` counts model requests (a legacy producer that makes
  several requests per record charges each one) and
  `max_output_tokens_per_day` counts output tokens the provider billed, per
  UTC day, across every pass and including rejected responses. Each is checked
  before a request leaves; the pass that finds one spent makes no request and
  stops as `model:budget_day` (receipt status `stopped`), and the next UTC day
  starts again from zero. A request is charged when it leaves, so a kill
  mid-request still counts, and tokens when it returns, so a day can end at
  most one request past its token cap. The defaults bound spend without
  slowing the default one-step pass; raise them together with
  `max_calls_per_pass` to drain a backlog.
- **Receipts.** A run receipt's `model` block carries `consecutive_rejections`
  and `last_rejection_rule` (for example `response_truncated`) while the
  refusal streak lasts, and omits them once the model has answered. Older
  receipts omit them too.

## Rate limits and transient provider failures

The OpenAI-compatible port retries HTTP 429, 502, 503 and 504, network
failures and timeouts up to `[ports.llm].max_retries` times (default 2, at most
8) inside the request's `timeout_ms` deadline. It waits for the provider's
`Retry-After` when one is given, and otherwise backs off exponentially from
two seconds; each wait is capped at 30 seconds. A wait the deadline cannot
cover is not slept: the request fails with the provider's refusal instead of a
timeout. A gateway that answers HTTP 200 with an `error` object and no choices
is treated as that HTTP failure.

A request that is still refused with 429 after those retries ends the pass as
the typed stop `model:rate_limited` (receipt status `stopped`, not `failed`).
Other exhausted failures stop as `model:<reason>`, for example `model:http`.
Work filed by earlier steps in the same pass stays filed, and the refused
record stays behind the cursor for the next pass.

The serving host selects the largest authorized event prefix that fits one
request. It checks at most eight candidate prefixes. Each request stays within
eight events and 24,000 escaped characters of quoted record text. Typed world
extraction takes at most `records_per_request` records per request (two by
default), because its anchored response runs to one to three thousand output
tokens per ordinary record. Input
estimation includes the complete system and user messages: event headers,
per-event subject roles, subject keys, authorized known claims, predicates,
fences and record text. Context is selected for each prefix before its
32-claim cap, so a later record cannot cause the earlier prefix to lose its
context during planning.

Source authorization is applied before both the per-subject and shared
known-claim limits. The claim reader streams candidates in deterministic
order and retains at most the requested accepted count. A subject with many
denied claims can require a longer local database scan; there is no silent
scan cutoff that presents incomplete authorized context as complete.

The current budget estimate is the full message character count divided by
four, rounded up. It is not a measurement of provider token usage. Usage
returned by the provider remains separate from these preflight reservations.
The producer prepares all intended requests and checks their combined
reservations before its first LLM call. A later request that cannot reserve
output therefore cannot invalidate an already paid first request merely
because of the local budget.

## Refusals and retained input

A refusal reports `budget_exhausted` with a fixed diagnostic naming
`max_calls`, `max_input_tokens`, `max_output_tokens` or `max_quoted_chars`,
and numeric `used`, `requested` and `limit` values. Producer contract minor 3
adds the quoted-character diagnostic. Older failed-receipt formats remain
readable. A planning refusal has zero actual calls and reports its planned
requirement with `used=0`.

Record text is never truncated and the per-request limits are never raised.
The epoch-zero legacy producer still refuses a record that cannot fit by
itself without an LLM call and keeps its checkpoint before that record.
Typed world extraction decides such a record itself, as described next.

### Records too large for one request

A typed record that no request can carry whole, because its text exceeds
24,000 escaped characters or its request exceeds `max_input_tokens`, is
handled by the loop without an owner step.

- **Segments.** The loop splits the record into segments of at most 24,000
  escaped characters whose requests also fit `max_input_tokens`, and sends
  each segment as a request of its own that carries no other record. A split
  falls on the last paragraph break in the second half of the window, else the
  last line break there, else the last word boundary. It never falls inside a
  grapheme, so never inside a surrogate pair, and never inside a fence
  look-alike that escaping would lengthen.
- **Anchors.** The model sees only the segment. Before the decision is
  journaled, every anchor is moved to record offsets, and each must fall on
  UTF-16 boundaries of the original record and quote exactly the text the
  model saw. Claims then cite the record like any other, and the claim writer
  checks them against the stored record text again.
- **Progress.** `extract_oversized_records` keeps each record's extracted
  prefix. A segment's decision is journaled together with its end, and filing
  its claims moves the prefix in the same transaction. The extraction cursor
  stays before the record until its last segment is filed. A kill loses at
  most the segment in flight: the next pass resumes at the next unfinished
  segment, and a journaled segment replays without a new request. Neither
  files a finished segment's claims again. A record with filed segments never
  joins a whole-record request. Source consent, the model binding, the retry
  of a rejected response and the per-request reservations apply to every
  segment request as they do to any request. Each segment is one step of the
  pass: the writer is held only to file it, and a stop request or the pass's
  time budget ends the pass between segments.
- **Skips.** A window with no word boundary, such as a single 30,000-character
  token, cannot be split without cutting it. The loop then skips the rest of
  the record without a request, writes a receipt with reason
  `record_oversized_skipped`, and moves the cursor on. A segment the model
  rejects on its own twice is skipped the same way. The receipt holds the
  event id, the record's UTF-16 length and the offset already extracted, never
  its text. Claims filed from earlier segments stay.
- **Reversal.** `kizuki doctor` and `kizuki serve status` print an
  `oversized records` line with the counts of records being segmented and
  records skipped, and name `kizuki serve retry-skipped` while any record is
  skipped. `--json` reports them as `oversized` in the serve doctor report.
  That command puts every skipped record back on the deferred queue; the loop
  decides each one again from the offset it already extracted, and skips it
  again when nothing has changed. A larger `max_input_tokens` can make a
  skipped record splittable.
- **Receipts and backups.** A sync run that segmented or skipped a record
  reports `oversized.segments` and `oversized.skipped` in its run receipt.
  Backups at serve schema 9 carry segment progress and skip receipts, and
  restore checks each against the restored record's length.

When not even a small segment fits a request, for example because the
supplied references at the head of a record outgrow `max_input_tokens`, the
record is skipped the same way, with a `record_oversized_skipped` receipt and
no request. After `max_input_tokens` is raised, `kizuki serve retry-skipped`
lets the loop decide it again.

## Restart and authorization

When only a prefix fits, the durable journal records that exact raw ledger
boundary, its authorized model inputs and any denied eligible inputs inside
the boundary. Every remaining raw event stays beyond the extraction cursor.
Successful empty extraction commits the same limited boundary.

Deferred input is already durable. A successful deferred prefix removes only
its selected rows and advances its scan marker in the same transaction.
Unselected or denied rows remain eligible for later scans. A failed request or
interrupted filing does not advance the selected prefix's scan marker.

The complete accepted decision is journaled before its first claim write.
After interruption, the writer replays that decision without asking the model
again. Current source grants, bindings and policy epoch are checked before
durable completion. A revision change during extraction refuses filing and
advancement; a permission-preserving revision can replay an existing journal
under the current authorization checks.

## Verification

Use the repository's pinned Bun version:

```bash
bun test packages/core/test/serve/write-pass-release.test.ts packages/core/test/serve/write-pass-stuck.test.ts packages/core/test/canon/write-scaling.test.ts packages/core/test/graph/registry-refresh.test.ts packages/cli/test/tell-writer-busy.test.ts
bun test packages/core/test/serve/extraction-budget.test.ts packages/core/test/serve/extraction-throughput.test.ts packages/core/test/serve/extraction-rejections.test.ts packages/core/test/serve/oversized-records.test.ts packages/core/test/producer/model.test.ts packages/core/test/source-model-egress.test.ts
bun test packages/llm/test/openai-compatible.test.ts packages/cli/test/serve/extraction-throughput.test.ts packages/cli/test/serve/oversized-records.test.ts
bun test packages/core/test
bun run typecheck
bun run verify
```

The focused tests cover rich role metadata, complete context, split text,
impossible records, denied interleaving, grant changes, successful abstention,
deferred retries and partial journal replay across restart. The throughput
tests cover setting bounds, one committed cursor per request, a rate-limited
stop and its resumption, one narrowed retry of a rejected response, a record
skipped after two rejections on its own, doctor health after a retried
rejection and after a rate-limited end, a stop request and a real SIGTERM
ending the pass at the next step, owner writes and `serve stop` during a
request, the pass time budget, rail grace behind a long pass, a real kill
during a request, flat statement and memory use over 64-request passes, retry
backoff and the sync period applied at service start. The rejection tests cover
narrowing across single-step passes, a poison record skipped after two
rejections, three records rejected alike stopping the pass with nothing
skipped and the persisted backoff and probe, records passed over during a
systemic streak decided again once the model answers, differing rejections not
adding up, usage recorded for rejected responses, the daily call and output
token budgets, and the receipt fields. The oversized-record
tests cover split boundaries, a 60,000-character record extracted in three
segments whose anchors match the original text, segments shrunk to fit
`max_input_tokens`, a stop request between segments, the writer free during a
segment request, a real kill between segments, replay of a journaled segment,
a skip with its receipt, doctor line and retry, records under the limit,
purge, and backup and restore. All fixtures are synthetic; they make no
provider or account calls.
