# Scoped writes and served-text matching

Agent filing compares only claims in the caller's current read grant. Sensitivity,
type, subject, time and live source recall permission constrain exact duplicates,
corroboration, conflicts, authority checks and retirement. Hidden peers contribute
neither identifiers nor counts and remain unchanged. Source permission to derive
or correct evidence does not grant permission to recall an existing claim.

Legacy exact filing uses an immediate SQLite transaction to deduplicate within
that read scope. The ledger migration replaces the global unique exact-body
index with a lookup index: identical text can exist in disjoint read scopes.
Owner filing still compares against the complete owner-readable set. Historical
staging signatures and typed world semantic identities keep their existing rules.
Scoped filing uses structural deduplication because the v1 vector nomination
window cannot express the complete read grant. Readable claims still publish
through the host's retrieval port; retry selection also uses the read scope.

A correction authorizes each existing canon page before changing it or returning
its diff, path, receipt or recovery details. If the readable claim lives on an
unreadable mixed page, the claim correction is recorded while that page stays
unchanged; the response does not name the page or add it to an unreached list.
Readable pages continue through the existing receipted writer. This adds no
client page writer or owner approval step.
Typed correction rematerialization uses the same read scope before its candidate
cap. Unpublished hidden claims stay absent from the page and retain their receipt
state. The writer may include the caller's exact newly recorded correction
statement; this does not widen the statement's private evidence label or admit
any unrelated support. Shared correction calls resolve an agent's current stored
grant even when a caller omits a grant argument. Unknown or revoked relays fail
closed. A hidden recording does not change a correction retry's refusal.

For agents, search nominations must also match the redacted title and excerpt
or captured text that the response serves. The check uses the existing FTS query
grammar against an ephemeral in-memory document; it adds no durable index or
retrieval implementation. A nomination that matched only a credential-shaped
span is dropped without incrementing the response's redaction tally. Candidate
previews use detached redactors; only selected results contribute to that tally. Owner
search retains its existing matching behavior. Matching an excerpt can omit a
raw match beyond its bound; ledger search honors `full_text` when requested.
An agent's engine nomination,
including a fuzzy match, is dropped when the served text does not satisfy the
floor's query grammar.

Entity title, handle and projected-label matching, and world discovery label
matching and ordering, use served labels. Local graph traversal authorizes edges
before counting them or following their endpoints. The response cap and
`truncated` describe admitted edges. A retrieval provider's raw overflow flag
does not prove authorized overflow; the local graph floor checks that separately.
Agent traversals supplement provider results with that floor whether the provider
reports overflow or not, so its raw flag cannot change the admitted edge set.

These rules constrain public serving responses and mutations. They do not promise
constant execution time: canon snapshots and derived candidate scans still do
internal work before admission. Raw storage helpers require trusted database
access and are not authenticated agent interfaces.

Verification lives in `packages/core/test/serving/write-visibility.test.ts`,
`packages/core/test/serving/authorization-oracles.test.ts` and
`packages/core/test/claims/scoped-idempotency.test.ts`. The cases cover mixed-page
correction, hidden duplicate and conflict oracles, source-grant visibility,
corroboration and retirement, prefix probing, served-label matching, graph caps,
retry refusals, stored relay grants, returned-result redaction counts, fresh
databases, upgrades, rollback and prepared retries. Typed rematerialization is
covered in `packages/core/test/serving/world-correct-modes.test.ts`.
