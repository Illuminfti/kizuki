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
truncated`. The pass asks again for the first record alone, and a record whose
answer is still rejected on its own is skipped without claims (see
[steps per pass](#owner-throughput-settings)), so such a model loses records
rather than stalling. Choose a non-reasoning model, lower `[ports.llm]
reasoning_effort`, or reserve more output tokens.

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
  asked for once more in the next step, for the first record of the rejected
  request alone, because a nondeterministic model often answers a smaller
  request well. A record rejected again on its own is skipped: the cursor
  moves past it without claims, the receipt names the reason (`record skipped:
  rejected on its own twice`) and counts it in `records_skipped`, and the pass
  goes on. A typed record too large for one request by itself is skipped the
  same way without a request (`record skipped: too large for one request`).
  One record therefore cannot hold every later one. A pass ends early when the
  ledger is drained, the epoch-zero producer refuses a request before sending
  it, a commit finds the cursor moved or its inputs purged, or the model is
  unavailable. Steps that make no request, such as advancing over records a
  source grant does not cover, still count toward the limit, so the default
  pass is the same single step as before.
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
  most 32 canon writes per pass.
- **The writer during a pass.** A pass holds the vault writer only for local
  durable work: filing a step's decision and cursor, and the canon writes that
  end the pass. It never holds it across a model request, so owner verbs that
  need the writer, such as `undo`, `tell`, purge and `kizuki serve stop`, go
  through while a request is in flight. An answer that arrives after a purge or
  another pass changed its inputs or the cursor is discarded, never filed. An
  answer waits up to five seconds for a writer another operation holds; after
  that the pass stops as `lock:busy` and the next one asks again.
- **Stopping.** `kizuki serve stop`, SIGTERM and SIGINT end a pass before its
  next step. The request in flight finishes and is filed, canon writing waits
  for the next start, and the receipt stops as `serve:stop_requested`. The
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
  window.

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

A record that cannot fit by itself is never sent and its text is never
truncated. Typed extraction skips it: the cursor moves past it without claims,
the run receipt records `record skipped: too large for one request` and counts
it in `records_skipped`, and the record stays in the ledger for search, the
timeline and a later extraction with larger limits or chunking. The receipt
keeps the count and reason, not the record's identity, for the receipt
retention window. The epoch-zero legacy producer still refuses such a record
without an LLM call and leaves the checkpoint before it. These limits are not
silently raised.

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
bun test packages/core/test/serve/extraction-budget.test.ts packages/core/test/serve/extraction-throughput.test.ts packages/core/test/producer/model.test.ts packages/core/test/source-model-egress.test.ts
bun test packages/llm/test/openai-compatible.test.ts packages/cli/test/serve/extraction-throughput.test.ts
bun test packages/core/test
bun run typecheck
bun run verify
```

The focused tests cover rich role metadata, complete context, split text,
impossible records, denied interleaving, grant changes, successful abstention,
deferred retries and partial journal replay across restart. The throughput
tests cover setting bounds, one committed cursor per request, a rate-limited
stop and its resumption, one narrowed retry of a rejected response, a record
skipped after two rejections on its own, an oversized record skipped without a
request, doctor health after a retried rejection and after a rate-limited end,
a stop request and a real SIGTERM ending the pass at the next step, owner
writes and `serve stop` during a request, the pass time budget, rail grace
behind a long pass, a real kill during a request, flat statement and memory
use over 64-request passes, retry backoff and the sync period applied at
service start. All fixtures are synthetic; they make no provider or account
calls.
