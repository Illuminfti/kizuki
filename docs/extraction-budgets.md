# Extraction budgets and durable progress

Model extraction uses budgets separate from canon writing. Each serving pass
allows at most two model calls, 8,000 estimated input tokens and 2,000 reserved
output tokens. Canon write limits do not increase these model allowances.

The serving host selects the largest authorized event prefix that fits one
request. It checks at most eight candidate prefixes. Each request stays within
eight events and 24,000 escaped characters of quoted record text. Input
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

A record that cannot fit by itself is refused without an LLM call. Its text is
not truncated, and it is not treated as successful empty extraction. The
checkpoint remains before it so the unprocessed record stays visible to a
later run. Processing an individually oversized record requires a separate
chunking decision; these limits are not silently raised.

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
bun test packages/core/test/serve/extraction-budget.test.ts packages/core/test/producer/model.test.ts packages/core/test/source-model-egress.test.ts
bun test packages/core/test
bun run typecheck
bun run verify
```

The focused tests cover rich role metadata, complete context, split text,
impossible records, denied interleaving, grant changes, successful abstention,
deferred retries and partial journal replay across restart. All fixtures are
synthetic; they make no provider or account calls.
