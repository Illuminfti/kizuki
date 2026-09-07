# Positive canon admission

An active Markdown page qualifies for positive serving and local projections
only when its bounded, nonempty source list resolves to live, validated external
ledger events and its exact byte hash has an existing canon receipt basis.
Source liveness uses the ledger replay predicate, including later source tombstones.
Serving metadata and claim provenance use that same ordering: a later recapture
is live, including when equal acceptance timestamps require the event-ID tie break.
Write, valid revert and purge-rewrite history share one receipt resolver.
Missing receipt history retains the protective `owner_authored` fallback for
overwrite decisions, but does not provide positive evidence.

Serving additionally checks current source permissions, labels and purge
holds. Local FTS and graph writes require derivation permission. A full or
incremental rebuild withdraws inadmissible pages; graph maintenance also
withdraws incoming relations to unrecorded active pages, including known
aliases during an incomplete scan. Purge-held aliases remain suppressed even
for inactive pages. Other inactive pages leave ordinary unresolved prose links
unchanged. Page identity and owner bytes remain available to the arbiter.
Schema-only FTS recovery restores ledger rows and withholds canon companion
rows until a rebuild supplies a current page snapshot.

Unrecorded owner edits and generated status briefs remain files on disk.
They gain no invented source, permission exception or authored claim. A purge
redaction receipt cannot turn an unrecorded residual into positive canon.
Undo and portable restore retain historical bytes and reapply admission.

A selected retrieval rebuild records its admitted document fields, complete
source membership, page byte hash and receipt basis, and claim revision before
publication. After the port settles, it rereads bounded authoritative state and
requires those revisions and current derivation permission to still match.
Changed or withdrawn documents are removed in batches of at most 100, with
absence proved against the original store identity. Each completed cleanup
rechecks the remaining original documents. Refusal retains pending source-store
obligations; unproven cleanup invalidates the port capability. The writer fence
continues through late settlement and cleanup after a caller timeout.

This is Packet A of issue #49. Truthful owner-page recording, its durable proof,
mixed-page erasure dependencies and portable recovery remain required Packet B
work. This change does not complete issue #49 or change ledger/backup formats.
