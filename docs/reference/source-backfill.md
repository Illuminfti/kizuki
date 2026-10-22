# Bounded additive source backfill

`kizuki serve backfill-source --plan /absolute/private-plan.json --plan-sha256 SHA256 --json`
re-extracts one explicitly selected window of an already processed external
record. It is for enriching source claims that remain true but are incomplete.
It does not replace correction, revoke consent, retire old claims, or relax the
empty-segment replay contract.

The versioned `kizuki.source-prefix-backfill/v1` plan binds the vault, event and
content/text hashes, source grant revision/policy/epoch, genuine factory producer
fingerprint, model binding, fixed UTF-16 window and completed cap, token budget,
full prior inventory/state hashes, immutable prior run receipt hashes, and
compatibility/qualification/producer review hashes. `sourceBackfillSnapshot`
provides only inventory/state commitments; it does not assess natural-language
compatibility. Compatibility review must establish that prior claims remain
true and that additive enrichment is appropriate. Opposite-polarity claims of
the same semantic identity are rejected; Core does not invent a semantic grader.

The window must fit the current completed extraction progress, preserve UTF-16
boundaries and contain at most 24,000 UTF-16 units. Its model request contains
only that window and supplied references witnessed within it. It adds no global
canon, unrelated event bodies or additional grounding context. The configured
input/output budgets and trusted input reservation apply, with one producer invocation
maximum and measured overflow refusing the entire answer. Transport retries
remain the configured LlmPort's policy; its `max_retries=0` setting is required
for a physical single-request bound.

Schema 49 stores an immutable attempt before calling the model and an immutable
terminal admission result atomically with newly accepted claims. A unique
`(event_id, producer_fingerprint, model_binding_digest)` prevents another operation
ID or shifted window from retrying the same extraction identity. A separately
qualified, different identity can bind the latest terminal predecessor's receipt
hash and the same original source/window, using a fresh inventory commitment.
An interrupted attempt without a terminal result cannot resume or be bypassed.
In-flight attempts reserve their configured daily output ceiling; known terminal
usage replaces that reservation, while unknown usage consumes the conservative
ceiling without pretending it was measured usage.

Every candidate uses the production wire decoder, guards, admission mapper and
shared prepare/commit writer. Existing live semantic identities are fully
validated and carried forward without attaching new support or observations,
changing confidence, or rewriting their old claim rows. Only new meanings are
inserted. Event bytes, extraction progress, rail cursors, old settlements and
prior receipts are unchanged. A consent/source/inventory/state change during
the model request rejects admission; transaction failure rolls back all new
claims. Failure to persist a terminal refusal returns `failed` with
`terminal_unavailable`, retaining the unresolved no-retry reservation and any
known usage in the returned result.

The immutable admission result's `settled` outcome describes claims admission,
not filesystem projection. The CLI then runs the existing canon-only rail,
which cannot capture or issue another model call, and returns separate
`admission`, `canon` and `projection_complete` fields. Consumer acceptance requires
successful canon receipts, no pending recovery/projection and the intended
consumer evidence. Canon failure can leave admitted claims awaiting the
supported `serve run sync --canon-only` recovery; it does not authorize another
backfill attempt.

Exports include the ordered attempt/result streams and validate their complete
predecessor chain on restore. Supported event/source purge erases this journal
through the source/event boundary. Plans and result receipts contain hashes and
bounded accounting metadata, not source bodies, raw model responses or secrets.

## Verification

Synthetic tests exercise the genuine factory/wire/admission path, nonzero
window offsets, prior row preservation, canon receipts, source/inventory races,
transaction rollback, token overflow, malformed answers, no-retry reservations,
new model-binding predecessor chains, private plan parsing, and schema backup
and purge. No provider or private vault is needed.
