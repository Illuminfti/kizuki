# P015 corrective review — stopped, changes required

Status: **REQUEST_CHANGES / REVIEW STOPPED**. The user requested a clean stop before this review was completed. Candidate acceptance is withheld. No merge, release, or full verification claim is made.

## Candidate and scope

- Worktree: `PRIVATE_FLEET/code-repos/P015`
- Last observed candidate HEAD: `5d21ed6eea9f7f9bc93ca288096b59c7201f1397`
- Last observed tree: `860f59d70411250fd3c6bf8bdc9be752511e4a33`
- Original reviewed candidate: `34d02119014e7fd071e5ab3709fd65b7c0a5e065`
- Review base: `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7`
- Last observed candidate worktree was clean. The reviewer made no candidate changes. This is the last observation, not a fresh stop-time status check.
- Scope inspected before the stop: 15 changed files against the base; nine files in the corrective delta. The root amendment explicitly authorized the additional canonical integrity integration and enrollment backup test paths, bringing the allowed write scope to 19 paths. No out-of-scope candidate change was found in that comparison.

## Remaining finding

**P2 — Portable checkpoint validation omits the live child path condition.**

In `canon-source-survivor-lineage.ts`, `assertSurvivorChildReceipt` (last inspected around lines 297–314) validates child receipt metadata without checking `child.page_path`. Portable restore reaches this validator through the lineage binding checks. The producer now classifies archived staging paths correctly, but the portable acceptance boundary still lacks the frozen contract's live child path condition for a nonempty archived child path.

The correction should permit an empty child path when prior erasure has sanitized historical receipts, while requiring every nonempty child path to be a valid live, non-archive page path. The semantic validator should enforce this directly. Reuse the canonical path validation rules without introducing a dependency cycle from the ledger validator into source intent handling.

This finding comes from static source comparison with the lineage contract. No malformed input, hostile archive, vulnerability reproduction, or candidate execution was constructed or run by this reviewer. The finding was sent to the root before the clean stop.

## Original findings resolved in the inspected correction

1. `writeIntent` now accepts and serializes the intended object through its one-argument call sites; the unused database argument was removed and the existing UTF-8 size bound remains.
2. Recursive lineage traversal now checks the shared depth budget at the previously missing recursive boundaries. Static inspection found the 128 participant and 4096 distinct receipt limits remain enforced without fallback to a positive verdict on unavailable lineage.
3. Portable restore uses strict insertion with duplicate accounting and verifies stream, unique, stored, and manifest counts. Runtime idempotent insertion remains limited by the surrounding receipt and intent consistency checks.
4. Normal archive staging uses the shared live-source survivor predicate. Archive staging does not produce a live checkpoint. The remaining portable validator finding above is a separate acceptance-boundary omission.

These are static resolution assessments, not passing test results.

## Other completed static checks

- Canonical schema integrity checks now cover schema 20 through the shared assertion used by normal open, health, and enrollment preview. Older expected schema versions do not require the new table or backfill historical lineage.
- The backup compatibility matrix retains the explicit older schema behavior. Schema 20 portable v3 backups require the lineage stream, including when it is empty. The existing v2 behavior remains explicit in the matrix.
- The historical enrollment backup fixture remains at schema 16. The current schema expectations and required empty lineage stream coverage were updated in the amended test scope.
- The genuine source-grants test was unchanged in the inspected diff.
- Erasure sanitization preserves receipt identity, kinds, hashes, authority, time, and revert relationships while clearing sensitive paths and producer metadata. The checkpoint remains a bounded eight-field record.
- Static inspection covered receipt/checkpoint coupling, intent origin checks, recovery classification, and the capability-protected finalization transaction. Full completion of the requested restore/history/undo composition review had not occurred when the user stopped work.

## Validation state

The root reported **six test failures in run `a698`** at the clean stop. This report records the root-provided short run identifier and failure count; the reviewer did not independently inspect that run's diagnostics. The candidate is preserved as failed and unaccepted. Earlier sealed test results and scope amendments do not establish a pass for this corrected HEAD.

The reviewer performed static reads and comparisons only and ran no candidate tests. No reviewer-owned candidate process, test process, service operation, or investigation remained running when the stop was received. This does not claim that all processes owned by the root or other workers have stopped; the root owns that reconciliation.

## Clean stop

No further source inspection, candidate edit, test, or service action was undertaken after the root relayed the user's clean stop. Only this report and the companion correction handoff were written. The remaining finding, the six root-reported failures, and the unfinished review must be resolved and independently verified before acceptance.
