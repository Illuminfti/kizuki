# Positive canon admission

An active Markdown page qualifies for positive serving and local projections
only when its bounded, nonempty source list resolves to live, validated external
ledger events and its exact byte hash has an existing canon receipt basis.
Source liveness uses the ledger replay predicate, including later source tombstones.
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

This is Packet A of issue #49. Truthful owner-page recording, its durable proof,
mixed-page erasure dependencies and portable recovery remain required Packet B
work. This change does not complete issue #49 or change ledger/backup formats.
