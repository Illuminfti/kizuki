# Bounded canon citations still have to satisfy the gate

Recorded 2026-11-16.

A legacy page names at most 100 sources. Citing a claim's whole provenance
made busy pages unwritable. The page must still cite, for each claim, live
events the canon gate cannot tell from all of that claim's live events: one
per source key, native-evidence bit and filled fields, one per event class,
one per origin, plus the earliest and latest live event by `occurred_at`,
preferring ids the page already names. If those required citations do not
fit, refuse the write. Keep purged ids, tombstones, and versions a deletion
ended. Replace an ended version with the record's current version only after
the record has come back and a claim on the page rests on it. Do not run
that citation rewrite while a deletion of the page is pending, or after the
owner undid one. The claim row keeps its full provenance.

Why: the first bound hid sources from revocation and let a time window or a
default agent grant read a page the claims route denies, because an uncited
credential, class, origin or early event never reached the judgement. A page
that kept citing the ended version after the record returned was never
indexed again.

Commits: `d9cec962`, `ba9755d4` (2026-11-12), merged as #1151.
