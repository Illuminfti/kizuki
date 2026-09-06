# P067 and P069 failed-test adjudication

Reviewed 2026-09-06 at 22:33 UTC. Both retained failures are **test expectation errors**. Neither establishes a product defect requiring a production change. This review inspected the exact sealed runner inputs, f57 source, existing tests and result/log receipts; it did not rerun or modify either candidate.

| Packet | Candidate | Qualified retained result | Classification |
| --- | --- | --- | --- |
| P067 | `b82dbcbb8d390e3e315d2dbea335f93ef57d0954` | 22 pass, 1 fail, 80 assertions; exit 1 | Incorrect assumption that a mixed update/deletion sweep fits one `sync` batch |
| P069 | `86a3c200b9eba48353fe5540cdfd4dcb50f30702` | 17 pass, 1 fail, 91 assertions; exit 1 | Two hand-authored ID prefixes use the wrong literal character count |

Both receipts report `stale: false`, unchanged before/after input digests, no termination reason and confirmed cleanup. These are actual assertion failures, not dependency or runner-start failures. They remain failing evidence until their owners submit corrected test-only candidates and root executes fresh receipts.

## P067: finish consuming the returned cursor

The failing new test expects `edited.md` and `removed.md` together from its first post-change `sync` call (`fleet-markdown-lifecycle.test.ts:113`). It receives only `edited.md`.

On f57, `packages/connectors/src/markdown-folder/index.ts:261` deliberately returns a nonempty file page before pending tombstones. The returned cursor records the remaining tombstone phase and is not exhausted. At lines 279–302, the next sweep consumes that cursor and emits the pending deletion. The unchanged `removed.md` identity remains in the processed snapshot until its tombstone is returned; it is not dropped by the file update batch. Existing paging and tombstone tests support this multi-batch protocol. The public connector returns `SyncBatch`, and one invocation is not a promise to finish the whole sweep.

Correct only `packages/connectors/test/fleet-markdown-lifecycle.test.ts` under its existing P067 owner. Consume successive returned cursors to finish the small ordinary sweep, then assert the aggregate contains exactly one edit for `edited.md`, exactly one tombstone for the original `removed.md`, no event for `kept.md`, stable identities and subjects, and no repetition once drained. Keep the fresh-backfill-after-deletion assertion. A small test guard may prevent an accidental endless loop, but do not delete the tombstone expectation, accept its absence, or change production batching to satisfy this test.

The new candidate still needs a fresh run of its three assigned test files and independent review. This source trace explains the current failure; it does not claim the currently unreachable later assertions have passed.

## P069: `machine-thread` has 14 characters

`fleet-chatgpt-fidelity.test.ts:175` and line 182 expect `v1:2:15:machine-thread:...`. The source field is the ASCII string `machine-thread`, whose length is 14: `machine` (7), hyphen (1), `thread` (6).

The identity contract in `packages/connectors/src/source-id.ts:1` is length-prefixed: `v1:<arity>:<len>:<part>…`. `encodeSourceRecordId` uses each part's length at line 13. The actual IDs therefore correctly contain `14`, matching both the contract and the existing literal encoding test in `source-id.test.ts`.

Correct only those two expected ID literals in the existing P069-owned `packages/connectors/test/fleet-chatgpt-fidelity.test.ts`, retaining the hand-authored expected envelopes and every role/error assertion. The expected IDs are `v1:2:14:machine-thread:8:system-1` and `v1:2:14:machine-thread:6:tool-1`. Do not regenerate all goldens from the parser or change production encoding. Its two assigned test files need a fresh qualified run; the later error assertions in this failed case were not reached.

## Retained evidence

- P067 run `ff6f91e6d65a4702ada8887aa06c66b9`; input digest `277ae103b9879ffbe9bfa897e5540f39bc03bbdc83f9a14b2e1fc7337ce8b612`; owned test SHA-256 `3fd7cc485ac1c7bb85c56ab9d65a05e04e30360288273a4033c00c3bd92c159b`.
- P069 run `7ae9c21119054c90853265c17947a873`; input digest `1fbf8ba017e34ce5b761ca2a82823b2cc83871d171ddf67df9785d070fde9a92`; owned test SHA-256 `80652019676829906a29ea9028b5156d619a02aae0a2211f1955b085d8c9a188`.

The machine-readable review receipt binds the original runner results, logs, sealed test files and production packet/handoff hashes. No failure artifacts, tests or production source were changed by this review.
