# Result R019

Outcome: FINDINGS. Scope: read-only inventory of capture-event source tombstone consumers and terminal states, with grant revoke/purge labeled separately. No repository edits.

- Repository/worktree/branch: `/repo` read-only git archive; no Git metadata; packet owner `grok-R019`
- Base, input head, final head and tree: `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7` (packet + `FLEET-SOURCE-IDENTITY.json`). Head did not move. No commits.
- Dirty/local-only state and owned files: source unchanged. Outputs only under `/work/out`
- Applicable instruction/skill paths and effective discovery: `/work/AGENTS.md`, `/work/ROLE.md`, `/work/packet.json`, `/work/.grok/skills/orient-repository/SKILL.md`, `issue-pickup-execution`, `test-strategy`, `handoff-work`; `/repo/docs/CURRENT.md`, `docs/decision-log.md`, `rfcs/0002-autonomous-canon.md`, `rfcs/0000-constraints.md`, `docs/architecture.md`, `docs/event-identity-origin.md`, `docs/provenance-admission.md`; assigned sources `packages/core/src/canon/source-tombstone.ts`, `packages/core/src/ledger/source-grants.ts`, `packages/core/src/ledger/purge.ts`
- What changed and why: preparation artifacts only. Public behavior unchanged.
- Ownership/dependencies: feeds P029, P030. P003/P015/P006/Astra/doctor reserved. No P-packet output read.

| Check | Exact command, head, runtime, time and evidence | Result |
| --- | --- | --- |
| Focused/public behavior | `bun test --cwd /repo` on 15 existing core files; Bun 1.3.14; base `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7`; 2026-09-06T21:59:57Z–22:00:49Z; `/work/out/checks/focused-tests.stderr` | 230 PASS; 1 FAIL/ERROR (`js-tiktoken/lite` missing for `packet-claim-boundaries.test.ts`) |
| Package/type/full gate | `bunx tsc --noEmit`; `bash scripts/verify.sh` | NOT_RUN (not assigned; no test slot) |
| Privacy/diff integrity | read-only; no source diff | PASS (no source writes) |
| Independent review | C2 independent-model lens | NOT_RUN |
| Retained package/consumer | not a packaging task | NOT_RUN |

Findings first, severity ordered:

1. **Limitation, not a product defect.** `packages/core/test/serving/packet-claim-boundaries.test.ts` and `packages/core/test/source-grants.test.ts` did not execute because `js-tiktoken/lite` is absent from this archive. Static reading of those tests still matches the grant/tombstone split in source. Do not treat as PASS.
2. **Hypothesis, not confirmed.** `packages/core/src/query/timeline.ts:78` filters `deleted=0` and does not apply LIVE_PREDICATE. Public serving (`serving/timeline.ts:73-77`) does. No CLI timeline verb. Do not change the internal SQL without a named public-seam task.
3. No confirmed capture-tombstone vs completed-purge confusion in the assigned modules. Existing tests already cover the exact cases; none were duplicated.

Remaining risk: full core suite and verify.sh not run; GitHub issue #53 / P029 / P030 unpublished output not read (forbidden); live connectors not used; native/account/model/human qualification not claimed.

Next smallest action: P029/P030 consume `source-tombstone-consumers.md` and `source-tombstone-state-labels.json` without inventing a second vocabulary.
