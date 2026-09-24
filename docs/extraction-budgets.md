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
truncated`. Because a truncated request is retried unchanged on the next pass,
such a model stalls extraction at that record. Choose a non-reasoning model,
lower `[ports.llm] reasoning_effort`, or reserve more output tokens.

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
```

A value outside its range, a fraction or a string keeps that key's default.
`kizuki doctor` and `kizuki serve status` print the effective values on one
`throughput` line, and `doctor --json` and `serve status --json` report them as
`serve.throughput`.

- **Steps per pass.** A pass takes up to `max_calls_per_pass` extraction steps.
  A step files a pending decision if one exists; otherwise it makes at most one
  model request, journals the accepted decision, files its claims and commits
  the cursor in one transaction before the next step starts. A kill therefore
  loses at most the request in flight, and the next pass resumes from the
  durable cursor. A rejected response (malformed, truncated or refused) is
  asked for once more in the next step, because a nondeterministic model often
  answers the same records on a second request; a second rejection in a row
  ends the pass, and the rejected records wait for the next one. A pass also
  ends early when the ledger is drained, a request is refused before it is
  sent, a commit finds the cursor moved, or the model is unavailable. A typed
  record too large for one request is asked for one segment per step, or
  skipped with a receipt when it cannot be split; see
  [records too large for one request](#records-too-large-for-one-request).
  Steps that make no request, such as advancing over records a source grant
  does not cover or skipping a record, still count toward the limit, so the
  default pass is the same single step as before.
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
  most 32 canon writes per pass.
- **The writer during a pass.** A pass holds the vault writer from its first
  step to its last canon write. Owner verbs that need the writer, such as
  `undo` and `tell`, answer `writer_busy` and ask for a retry while it runs,
  so a pass of many slow requests delays them for its whole length. Prefer
  several short passes to one long one.

Requests stay sequential. Each step's input is planned from the durable state
the previous step left: the committed cursor, the deferred queue and its scan
marker, and the current source revision. The journal holds one pending
decision whose previous cursor must equal the committed one. Concurrent
requests would have to be planned against state that does not exist yet and
thrown away whenever an earlier request fails, and filing would no longer
follow a single order.

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
  segment request as they do to any request.
- **Skips.** A window with no word boundary, such as a single 30,000-character
  token, cannot be split without cutting it. The loop then skips the rest of
  the record without a request, writes a receipt with reason
  `record_oversized_skipped`, and moves the cursor on. The receipt holds the
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

When not even a small segment fits `max_input_tokens`, the request is refused
before it is sent, as it would be for any record, and the cursor holds.

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
bun test packages/core/test/serve/extraction-budget.test.ts packages/core/test/serve/extraction-throughput.test.ts packages/core/test/serve/oversized-records.test.ts packages/core/test/producer/model.test.ts packages/core/test/source-model-egress.test.ts
bun test packages/llm/test/openai-compatible.test.ts packages/cli/test/serve/extraction-throughput.test.ts packages/cli/test/serve/oversized-records.test.ts
bun test packages/core/test
bun run typecheck
bun run verify
```

The focused tests cover rich role metadata, complete context, split text,
impossible records, denied interleaving, grant changes, successful abstention,
deferred retries and partial journal replay across restart. The throughput
tests cover setting bounds, one committed cursor per request, a rate-limited
stop and its resumption, one retry of a rejected response, an unsplittable
record skipped with a receipt, a real kill during a request, flat statement
and memory use over 64-request passes, retry backoff and the sync period
applied at service start. The oversized-record tests cover split boundaries,
a 60,000-character record extracted in three segments whose anchors match the
original text, segments shrunk to fit `max_input_tokens`, a real kill between
segments, replay of a journaled segment, a skip with its receipt, doctor line
and retry, records under the limit, purge, and backup and restore. All
fixtures are synthetic; they make no provider or account calls.
