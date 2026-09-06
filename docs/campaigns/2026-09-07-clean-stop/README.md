# Kizuki campaign clean-stop checkpoint

The owner requested a clean stop and preservation of all current work on
7 September 2026 (Europe/London). New work and the twelve-hour fleet schedule
stopped at that instruction. Resume only after an explicit new instruction.
This checkpoint is a preservation record, not a release or merge recommendation.

## Saved source

The checkpoint branch is `agent/kizuki-clean-stop-20260907`. Its code parent is
`3dfefd2810cec850b110343ea2973928a0b0a823`, tree
`adb4c4e13eec9f0e3a11567798962d4f8cee7a2e`. This contains the ten previously
accepted Grok candidates and the earlier accepted campaign integration on
fleet base `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7`.

All eighteen current code candidates were imported without merging into
separate `agent/checkpoint-20260907-pNNN` branches in the same repository.
Their normal correction history, including failed earlier attempts, is retained.
The interrupted supervisor edits were committed as a snapshot at
`96315320fafb4645a1b96f47ee6cc469fda4d788`. Snapshotting does not accept those edits.
[The candidate manifest](candidates.json) binds each branch, full SHA, tree,
changed path set and retained bundle digest.

Upstream `main` was fetched at stop and remained
`32713ad98899a8d1e8ac21a2ebbe3170f6af51a0`. It is an ancestor of the saved
integration. No campaign branch was merged to `main`; no release, deployment,
account change or cutover was performed as part of the stop.

## Candidate state at stop

| Packet | Saved HEAD | Disposition | Latest focused check |
| --- | --- | --- | --- |
| P004 | `78574f47b3c123f11e28fb43ad063340260b0607` | Tests failed; unaccepted | 58 pass / 1 fail |
| P006 | `b1ff2d812bb3cd0384d0f0f6f98ed32704774cac` | Accepted; composed in 3dfefd2 | See first-ten manifest |
| P015 | `5d21ed6eea9f7f9bc93ca288096b59c7201f1397` | Tests failed; unaccepted | 230 pass / 6 fail |
| P048 | `771f7c774096e86c2402f7fa54635f889d5fc3aa` | Accepted; awaiting composition | 18 pass / 0 fail |
| P053 | `bca137d398ada6bce612d668f4377f50dc29628c` | Accepted; composed in 3dfefd2 | See first-ten manifest |
| P057 | `85778e3f343f854e227f744aff0c13a47051278f` | Accepted; composed in 3dfefd2 | See first-ten manifest |
| P067 | `3d76afb63af4bf112b40811e534e97d2fc0fbe9c` | Accepted; composed in 3dfefd2 | See first-ten manifest |
| P069 | `a0705a0adca4ecf8f38233d873f4398812003224` | Accepted; composed in 3dfefd2 | See first-ten manifest |
| P071 | `a90db5339762f2436bb446b805d8fc81cdeeada8` | Accepted; composed in 3dfefd2 | See first-ten manifest |
| P072 | `3dd49027a764e4b5e0c73674de33fcf578bb5678` | Accepted; awaiting composition | 4 pass / 0 fail |
| P073 | `1a29c7fa06dbff33e34f2b7d035a480295241c80` | Accepted; composed in 3dfefd2 | See first-ten manifest |
| P075 | `7df5d889b52360df879b52a63ef53205aacb1701` | Accepted; composed in 3dfefd2 | See first-ten manifest |
| P101 | `7a217b3f274068b8bdb4b471811692622fcccf85` | Accepted; awaiting composition | 39 pass / 0 fail |
| P102 | `96539a8a2a978ff4a1b174148098c3ecd3190309` | Accepted; awaiting composition | 16 pass / 0 fail |
| P103 | `c7484874913df3ccab72a66f51310942e4daf3c5` | Accepted; composed in 3dfefd2 | See first-ten manifest |
| P104 | `5241086864fb23c2153693be94e20087ddb982be` | Focused tests passed; independent review pending | 7 pass / 0 fail |
| P105 | `10adfb41c882b9f7bacd4c89c8510ec5307abcf0` | Accepted; composed in 3dfefd2 | See first-ten manifest |
| P106 | `96315320fafb4645a1b96f47ee6cc469fda4d788` | Interrupted snapshot; unreviewed and untested | Not run |

P006 is documentation and was accepted by static review. The other first-ten
receipts and review bindings remain in
[the first-ten manifest](records/book/GROK-FIRST10-INTEGRATION-MANIFEST.json).
Four further candidates (P048, P072, P101 and P102) passed their independent
reviews but were not composed because the stop instruction arrived first.
P104's independent review had not begun; its passing focused run is not acceptance.

## Verification and open failures

Exact code head `3dfefd2` passed the sealed `bun run typecheck` run
`4decb0cc3f4c48329de6965eb4570ead` in 26.415 seconds with stable head and cleanup.
The independent integration review accepted its precise 22-path composition.
The full Bun suite and full `bun run verify` on that head were not run.
No new product tests were launched after the stop instruction.

[Latest test results](latest-test-results.json) record the seven latest sealed
runs, original receipt/log hashes and their actual owned-overlay scope.
They are not whole-package or release proofs.

- P004 (`78574f4`): 58 pass, 1 fail. The v1/v2 index-compatibility test expected
  rejection after adding `gate_receipts` but observed PASS. Corrective source
  review was not started. Complete that review before accepting the custody
  implementation; imported command-definition byte bindings remain a question.
- P015 (`5d21ed6`): 230 pass, 6 fail. Two existing receipt-custody expectations
  did not reach their intended premise; four lineage cases failed around
  retained authority, interruption recovery and backup-format diagnostics.
  Static review also found an omitted live-child-path condition in the shared
  portable semantic validator. Preserve every failure and finish diagnosis;
  do not weaken assertions or claim the source-survivor gap closed.
- P104 (`5241086`): 7 pass, 0 fail; independent review pending.
- P106 (`9631532`): user-interrupted snapshot; no tests or independent review.

The first integration still has the known source-survivor requirement pending.
The MCP raw-canon fixture inventory identifies further positive fixtures that
need review after broad test receipts; its recommendations were not executed.
The full-suite harness plan was stopped before clone creation or execution.

## Worker and record preservation

All four independent review agents stopped. The only remaining Grok worker,
P106, was stopped by root; its controller terminated with exit 137 and
`failed_or_incomplete`. Root verified no campaign worker/test containers
remained. No continuation, timer or replacement worker was scheduled.
Unrelated host services and other owners' worktrees were preserved.

The initial research fleet has 100 distinct completed task/session pairs in
[its result manifest](records/book/GROK-FLEET-100-RESULT-MANIFEST.json).
Those were task completions, not 100 accepted fixes. The archived worker
results remain unreviewed except where a separate exact-head review accepts
the relevant work.

[The record manifest](records-manifest.json) preserves packet, review and worker
result copies with original and copy hashes. Operator-specific paths and any
credential-shaped literals are removed from these archival copies. Original
receipts, logs, controller scripts, output material, independent clones and
bundles remain in the operator's existing private campaign directories.
Private runtime data, databases, authentication state and dependency caches
are excluded from the repository snapshot.

## Resume order

1. Reconcile current upstream, all named branches and process/worktree ownership.
   The existing saved branches are the starting points; do not duplicate them.
2. Finish P004/P015 corrections and reviews, P104 review, and P106 implementation
   and testing. Preserve the original failed and interrupted evidence.
3. Compose only accepted leaves in an isolated integration worktree, preserving
   normal ancestry and the separate held owner lanes (including #519 and #530).
4. Complete pinned typecheck, full verification, independent review and exact
   packaged-artifact/consumer qualification for the resulting head.
5. Continue the remaining issue #403 product/connector/platform and stranger-use
   requirements through their existing owners. Capability producer work and the
   remaining evidence families were not activated by this checkpoint.

D19 remains binding: readiness requires executable stranger proof, zero live
P0s on the exact candidate and an honest install path. Seven-/fourteen-day
observations are optional post-ready diagnostics. Operational cutover still
requires separate authorization. This stop does not grant any readiness credit.
