# Recovering a legacy extraction decision

Evidence date: 5 September 2026. This document describes the atomic extraction
compatibility contract. It is not live migration or release approval.

## Why replay can refuse

New durable decisions store `atomic-v1:<64 lowercase hexadecimal characters>`
in `extract_batches.integrity`. The digest is SHA-256 of the UTF-8 domain
`kizuki.extract-filing/atomic-v1\0` followed by the existing ordered JSON
decision encoding: previous cursor, cursor, model reference, input IDs, batch
mode, model inputs, deferred inputs, outcome, and draft fields. The domain's
final `\0` is one NUL byte. The envelope occupies 74 bytes. It uses the existing
column and consumes no database or serve schema version. Old readers reject
the envelope instead of replaying it with per-draft commits.

An older pending decision has a bare digest or null integrity. Its writer could
have committed any prefix of its drafts before stopping. Structural
corroboration changed an existing claim's count, confidence and confirmation
time without retaining the incoming provenance. Neither the current counter,
matching claim text, a matching input ID nor absence of a new claim proves which
draft effects committed. Even an apparently unfiled legacy batch is refused.

Effectful extraction and write-pass entry points therefore raise
`LegacyExtractReconciliationError`, with code
`legacy_extraction_reconciliation_required` and this fixed message:

> Legacy extraction needs reconciliation. Preserve this vault and reconcile a separate copy; see docs/extraction-recovery.md.

The sync rail records the same code in `stopped` and the same safe message in
`errors`. It records failure rather than successful replay. It can still record
one new failed-run audit receipt and that receipt's normal schedule transition.
It does not recover earlier receipts or usage records, settle reservations or
invoke connector, model or retrieval hooks. Refusal does not
change claims, corroboration, supersessions, the pending decision, extraction
frontiers, deferred inputs or the retrieval outbox. It does not call the
producer, file the remaining drafts, publish retrieval or write canon.

Current envelopes also undergo full row-shape and digest validation before
write-pass or sync-rail maintenance, including a pass with no model configured.
One pure parser validates bounded scalar fields, timestamps, cursors, draft and
input shapes, stored input relationships and the domain-bound digest. The same
parser supplies the later durable reader, whose separate live checks own event
existence, source authorization, origin and the current input partition. The
early parser reads no events, refreshes no origin annotations and calls no port.
Malformed current rows refuse before old claims can revive or reservations can
settle. Non-RFC timestamps and scalar fields exceeding the existing archive
bounds are treated as corrupt.

## Preserve the recovery evidence

Keep the original complete vault and a consistent database snapshot, including
any SQLite WAL state. Use the supported export operation when it validates the
vault, or an offline copy made after all vault writers have stopped. Copy canon
and its receipts together with the database. Never copy only a live main SQLite
file and assume that it contains committed WAL data.

Storage-only export and restore retain valid legacy rows exactly, including
null fields. They do not grant replay authority or upgrade a row's envelope.
The restored copy still refuses extraction. Unknown versions and malformed
envelopes fail validation without being rewritten. Authorized purge may remove
affected legacy inputs under the existing purge transaction; a surviving
decision retains its legacy version and still refuses replay.

Do not delete the pending batch, advance a checkpoint, replace its digest, lower
a corroboration count or ask the model to regenerate the decision as a recovery
shortcut. Those operations cannot reconstruct effects that were never recorded.

## Reconcile a separate copy

There is no automatic legacy reconciliation command in this revision. An
operator must keep the refused original and work in a separate copy. A trusted
snapshot from before the batch, plus retained later events and receipts, can
provide a baseline for an explicitly designed rebuild. A complete independently
auditable history of every committed claim effect could also prove a bounded
reconciliation. The old pending batch and current claims alone provide neither.

Any reconciliation must account for the complete affected claim state,
confidence, authority, corroboration, confirmation times, supersessions, canon
receipts and files, source authorization, completed and deferred extraction
state, and retrieval. Validate the resulting copy before selecting it as the
active vault. Restoring a pre-batch snapshot alone can omit subsequent evidence,
corrections and canon work; that loss must be measured and explicitly resolved.

The old structural path could also omit the retrieval refresh. A reconciled copy
must enqueue or rebuild retrieval from its final verified claim state. This
refusal does not automatically refresh that old effect, and an index rebuild
alone does not repair authoritative claims. If exact reconciliation cannot be
proved, preserve the vault and keep extraction refused. No convergence of the
legacy prefix is claimed.

## Verification

With the repository-pinned Bun 1.3.10, run:

```bash
bun test packages/core/test/serve/extract-legacy.test.ts \
  packages/core/test/serve/extract-atomic.test.ts \
  packages/core/test/source-model-egress.test.ts
```

The legacy regression constructs a pre-atomic two-draft prefix with a committed
structural increment, reopens the database and verifies refusal leaves the
counter at two with exact claim, journal, checkpoint, deferred and outbox rows.
Current atomic batches retain their whole-batch transaction and publish through
the retrieval outbox only after completion commits.
