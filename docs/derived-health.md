# Derived search and graph health

Search and graph are disposable projections of current evidence. Their owner
metadata describes the last completed indexing pass, including incremental
passes. `rebuilt_at` retains its compatibility name but is the time that pass
refreshed the stamp. Search's `ledger_watermark` records a contiguous indexed
ledger prefix, using durable companion and FTS coverage. Closing an old gap or
retrying after an upgrade reconciles the watermark; indexing a later event alone
does not certify an earlier gap. Tombstoned evidence is outside the live corpus.
Doctor includes the watermark alongside the layer's current counts and status.
An idle pass preserves the graph stamp when its input and health are unchanged.

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
allows the next incremental pass to retry it and clear its search and graph
skip status. An idle pass retries repaired pages even without a new receipt.
No model or network request is needed for these projections.

Public search and graph query flags describe omissions in the calling
principal's permitted corpus. A vault-wide degraded stamp is an owner
operational diagnostic, not an agent disclosure channel. Pages excluded by
sensitivity, subject, type, time or source consent do not add degradation flags
or counts to that principal's answer. A visible unrecorded revision can report
`index-degraded` while remaining withheld; reporting health never admits it.
Unreadable paths whose durable receipt labels, source permissions or current
receipted subject assignments put them outside the caller's grant do not affect that caller's
reply. Doctor still reports those failures for the owner. Unclassified or permitted unreadable paths refuse the read under
fail-closed admission rules. Permission filtering precedes health provenance
reconstruction; ledger health checks the authorized live corpus against both
the companion and the FTS rows actually served. An incremental pass restores
recreated FTS contents and repairs every known page during a partial walk.
Configured retrieval-port availability and ranking have their own declarations and are unchanged by this floor health.
