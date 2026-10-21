# Recorded-history foundation

This internal implementation follows **proposed RFC 0004 Amendment 1**. It does
not change that proposal's status or add a public known-at, snapshot, or history
operation. Historical serving must still apply current source consent, class,
principal and held-authority checks; a historically live claim is not necessarily
currently live.

## Durable positions

The schema allocation is `WORLD_MIGRATION_VERSIONS.known`. Database triggers
record world claim insertion, lifecycle changes, receipt attachment, and support
admission in one `claim_lifecycle_history` table. A nullable support key identifies
the transition that first asserts that admission. Repeated admission does not
allocate another position. Ordinary legacy claims do not enter this history.

The singleton clock advances inside the originating transaction. Its UTC time
comes from SQLite, never a source timestamp; time is clamped to the last committed
value, and sequence breaks ties. Both roll back with the claim transaction. Safe
integer exhaustion refuses the originating write. Raw sequences are internal:
they must not appear in serving DTOs, wire references, tokens or fingerprints.

The completion transaction supplies a causing receipt through the persisted canon
intent joined to its newly inserted receipt. An intent without that receipt is
not a cause. Receipt attachment to a supersession is another recorded transition.
Undo and redo therefore retain their own receipt rather than copying the old
receipt on the claim. A newly added support has no causing canon receipt yet.

## Coverage and physical erasure

Existing typed claims receive a present baseline in deterministic claim order,
marked `baseline_only`. Their previous history is not reconstructed from
`asserted_at`, `admitted_at`, or `retracted_at`. A reader must return unavailable
with reason `history` for a cutoff before `complete_from_sequence`; it must not
interpret missing old rows as proof that nothing was known.

A cutoff includes a transition when `recorded_at < cutoff.at`, or when the times
match and `sequence <= cutoff.sequence`. Per-admission history erased by a later
coverage reset is unavailable before that reset, even if the current support
still exists.

Observations retain their original admission position and cannot be reanchored
to a replacement baseline. Erasing that position also removes the dependent
observation and its opaque references. Independently surviving support remains
usable for current meaning; a rebuild does not invent its erased admission time.
The observation-history migration and legacy archive restore remove previously
orphaned observations. Current archives must already satisfy this dependency.

Event or support deletion advances the coverage of affected surviving claims and
replaces their old rows with a present baseline. A surviving history that names an
erased superseding claim also receives a new baseline; later transitions cannot
reintroduce that erased reference. This removes prior support,
receipt and supersession identifiers. Unrelated claims retain identical history
and coverage. Full purge deletes history and coverage, including when a sanitized
claim row remains with a skipped or superseded status and its semantics are
removed. No terminal purge history is retained.

History rows reject updates. Deletion is allowed only behind a newer coverage
boundary or as part of physical claim/semantic erasure. The global clock retains
only a non-identifying watermark; resetting it would reuse recorded positions.

## Restore and rebuild

History and coverage are authority/bookkeeping, so ordinary world rebuild leaves
them unchanged. A current backup preserves exact rows and clock. Restore disables
only these triggers inside its private staging transaction, imports claims and
history without generating transitions, validates positions/dependencies/current
state, and reinstalls triggers before commit or publication. Failed restore rolls
back the DDL too. Older backups receive a new present baseline.

`known-history.test.ts` covers production admission and retries, later support,
status helpers and raw updates, correction/undo/redo receipt causes, clock clamp,
rollback and overflow, baseline migration, partial loss and physical purge,
unrelated-history preservation, corruption refusal, and real export/restore plus
world rebuild. Integration must additionally rerun the recovered source revision
and mirror paths when those changes are composed.
