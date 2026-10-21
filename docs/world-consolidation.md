# World summaries and consolidation

World cards contain model-produced summaries only when their complete, currently
eligible evidence matches the stored summary basis. Summaries are disposable
interpretations, not claims or owner corrections. Their admission references
identify the evidence used. The existing relations and definitions remain useful
without a model.

An unsummarized card has `summary: null` and `pending_consolidation`. A previously
completed summary based on a strict subset of the reader's current supports is
withheld with `stale_dependencies`. Evidence outside the reader's authorization
cannot supply a summary or change either gap. Historical reads do not borrow a
future summary. An explicitly accepted complete empty response is persisted, so
an object with no useful summary does not retry forever.

The sync rail runs consolidation after extraction through the configured LLM
port. Each request needs current source consent for derivation and extraction,
including the exact model destination and retention terms. Local-only source
consent does not authorize sending that source to an external model. Native owner
corrections retain their existing no-model-egress rule; a card containing such
supports can remain pending. Captured inputs pass through the shared scrubber and
nonce fence. Context, speaker, holder, addressee, uncertainty, and dates remain
structured in the prompt. Existing lineage accounting prevents copies and known
paraphrases from becoming additional independent witnesses.

The writer releases its SQLite transaction and canon writer before requesting a
summary. Immediately before committing, it recomputes the complete evidence basis
and rechecks consent. A concurrent correction, revocation, purge, or world rebuild
wins. Summary rows, their support links, and admitted attempts are derived state:
world rebuild and restore clear them. Per-day model usage remains in the durable
budget ledger. After a crash, an admitted but unfinished attempt waits for its
bounded lease before retrying. A complete committed result is not requested again
unless its basis changes or its retention expires.

Configure independent limits in `.kizuki/serve.toml`:

```toml
[consolidation]
max_handles_per_pass = 8
max_calls_per_pass = 2
max_input_tokens = 8192
max_output_tokens = 1024
max_pass_seconds = 120
max_calls_per_day = 64
max_output_tokens_per_day = 65536
```

A pass advances a bounded discovery cursor even past sources that cannot be sent.
It requests at most one summary per visited handle, without holding a writer lock.
Input is bounded before egress, and deadline/cancellation signals reach the port.
Failures back off from one minute to one hour. Empty transport responses,
malformed output, partial output, truncation, unavailability, and cancellation
never complete the attempt. Only the closed complete response can do so.

Daily admission reserves one call and the entire requested output allowance
before network access. Failed or interrupted requests keep that reservation.
Observed output above the allowance is rejected and debited to the original
reservation day, even across midnight or source erasure. The port's request limit
is not evidence that every provider enforces a hard generation cap. Doctor reports
charged output separately from observed output; unknown usage remains charged
conservatively. The sync receipt has a separate `consolidation` report so its
calls and usage do not masquerade as extraction attempts. Exhausted daily limits
stop the work as `consolidation:budget_day`.

Doctor reports a bounded pending count, whether that count is capped, retained
last success/failure, next retry, and daily budgets. The daily brief includes the
pending count. Historical basis variants expire seven days after their own
admission. Their retention does not use a shared least-recently-used eviction
count, so adding unrelated hidden evidence cannot evict a reader's matching
summary. The hard daily admission ceiling bounds stored variants.

## Verification

The synthetic tests in `packages/core/test/world/consolidation.test.ts` exercise
freshness, real owner correction during a model request, consent loss, purge,
rebuild, crash/reopen, exact authorization matching, usage across midnight, and a
2,000-handle corpus. The CLI runtime test in
`packages/cli/test/serve/consolidation-runtime.test.ts` connects the configured
model port, scheduled sync rail, and consumer read against a synthetic loopback
endpoint. These are offline integration evidence, not proof that a particular
live provider is configured or currently operational.

Saved known-at snapshots privately pin the exact completed summary records they
admitted, including an explicit empty set. A summary completed later at the same
recorded timestamp cannot enter an earlier snapshot. Expiry, erasure and current
authority still win; an absent historical summary stays pending.
