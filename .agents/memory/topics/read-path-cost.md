# Read-path cost and per-read memory

Recorded 2026-11-16.

A read must serve the same rows as an uncached read. Remember a validated
event row only while that connection has seen no write since the stamp read
(any commit, a purge, or the call's own audit row). Return a copy only when
every column and the native request digest still match, and cap the
remembered text so one read cannot grow the process across the serve loop.
Issue that stamp read every time: a hit must not change the statement count.
`tableExists` stays one `pragma_table_list` lookup per call. A schema memo
that was cheaper on a hit changed the count and read `db.inTransaction`,
which breaks a proxy around the database. Inside one token read, answer each
subject once and load canon once, and drop that state when the call ends.

Why: on a vault of about 81k events, 46k claims and 10k pages, query,
context, search and doctor spent 75–127s of CPU re-reading `sqlite_master`
and re-validating events. The first memo then grew RSS batch after batch,
kept purged text, and could disagree with a later read after the page,
receipt or grant changed.

Commits: `5bac281d`, `8a4b8591`, `de6dc91a`, `71ad0598`, `b0e50c21`
(2026-11-12). The sibling pin that a served read runs no whole-vault pass is
`6177840c`; that rule is already in `docs/derived-health.md`.
