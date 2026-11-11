# Derived search and graph health

Search and graph are disposable projections of current evidence. Their owner
metadata describes the last completed indexing pass, including incremental
passes. `rebuilt_at` retains its compatibility name but is the time that pass
refreshed the stamp. Search's `ledger_watermark` records a contiguous indexed
ledger prefix, using durable companion and FTS coverage. Closing an old gap or
retrying after an upgrade reconciles the watermark; indexing a later event alone
does not certify an earlier gap. Tombstoned evidence is outside the live corpus.
Doctor includes the watermark alongside the layer's current counts and status.
An idle pass preserves the search and graph stamps when their inputs and health
are unchanged.

The daemon's sourceless deterministic daily briefs in `dashboards/` are
administrative summaries of rail and canon state, not event-backed evidence.
They remain readable Markdown but are excluded from both evidence indexes,
without counting as skipped or withheld documents. This does not admit a
sourceless page into retrieval or create a canon write path.

Doctor lists at most 16 skipped page paths with reason classes and the total
number of skipped files. This includes schema/walk failures, unrecorded
revisions, unavailable sources, recovery holds and denied derivation consent.
Holds for paths absent from the walk remain separately reported as held pages.
Restoring a page to its receipted bytes or completing a receipted correction
allows the next validated reconciliation to retry it and clear its search and
graph skip status. A receipted writer updates projection counts without clearing
unresolved search health or scanning unrelated files; its canon hash remains
unknown until a complete snapshot validates it. An idle pass retries repaired
pages even without a new receipt. No model or network request is needed for
these projections.

A reconciliation pass reads every page and compares it with its projection on
a read snapshot. It takes the ledger write lock only when it has a difference
to write. Under the lock it first checks that no page file and no ledger input
has moved since it read them, then writes; if one has, it writes nothing and
reads the pages and the ledger again. Page files are compared by stat
signature. Ledger inputs are every table's row count and highest rowid, and
the holds, write intents, canon read generation and health stamps whole. The
audit and run logs are not inputs, so a served call's audit row never sends a
pass back to compare again.

The serve loop skips the pass while none of those inputs has changed since a
pass that left nothing to write. A pass that wrote only health stamps leaves
nothing to write; a pass that wrote rows is followed by one that compares
again. It runs a pass at least every 30 minutes regardless, which bounds
changes those signals cannot show, such as a ledger row edited in place. A
process that has just started always runs a pass. When other writers move the
inputs during both comparisons of one sweep, the sweep writes nothing and the
next sweep tries again. A process's first pass, and the sweep after two in a
row gave way, instead compare under the write lock, so a repair is never
postponed indefinitely.

A degraded graph is projected again only when its stored registry or edges
differ from what the walk projects. The edges are compared directly: after a
walk that skipped a file, a page write projects only its own page, and the
pages linking to it get their edges from the next pass.

Public search and graph query flags describe omissions in the calling
principal's permitted corpus. A vault-wide degraded stamp is an owner
operational diagnostic, not an agent disclosure channel. Pages excluded by
sensitivity, subject, type, time or source consent do not add degradation flags
or counts to that principal's answer. A visible unrecorded revision can report
`index-degraded` while remaining withheld; reporting health never admits it.
Unreadable paths whose durable receipt labels, source permissions or current
receipted subject assignments put them outside the caller's grant do not affect
that caller's reply. Doctor still reports those failures for the owner.
Unclassified or permitted unreadable paths refuse the read under fail-closed
admission rules. Permission filtering precedes health provenance
reconstruction; ledger health checks the authorized live corpus against both
the companion and the FTS rows actually served. An incremental pass restores
recreated FTS contents and repairs every known page during a partial walk.
An idle pass keeps the search stamp degraded while live ledger rows are missing
from the served index, and clears that status once indexing restores coverage.
Configured retrieval-port availability and ranking have their own declarations
and are unchanged by this floor health.
