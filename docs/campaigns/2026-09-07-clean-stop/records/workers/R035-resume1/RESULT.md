# Result R035

Outcome: PREPARED. Scope: map stored claim temporal/history fields to current serving projections and label what main does not emit.

- Repository/worktree/branch: read-only git archive `/repo`; no Git metadata. Packet owner grok-R035. Write scope `/work/out` only.
- Base, input head, final head and tree: base_sha `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7` (FLEET-SOURCE-IDENTITY.json). No commits. Source unchanged.
- Dirty/local-only state and owned files: `/work/out/*` only.
- Applicable instruction/skill paths: `/work/AGENTS.md`, `/work/ROLE.md`, `/repo/AGENTS.md`, `/repo/docs/CURRENT.md`, RFC 0002/0003, skills orient-repository, issue-pickup-execution, test-strategy, handoff-work.
- What changed and why: preparation artifacts only. No repository edits.
- Ownership/dependencies: feeds P035 and P037. P003/P015/P006/Astra/doctor remain reserved.

| Check | Exact command, head, runtime, time and evidence | Result |
| --- | --- | --- |
| Focused/public behavior | `bun test packages/core/test/contracts/claim-v2.test.ts packages/core/test/claims/gaps.test.ts` at base `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7`, bun 1.3.14, 13 pass | PASS |
| Packet tests | `bun test packages/core/test/serving/packet-claim-boundaries.test.ts packages/core/test/serving/packet.test.ts` | NOT_RUN as pass: exit 1, missing `js-tiktoken/lite`; no install |
| collectPieces characterization | `chmod 700 /work/out`; `TMPDIR=/work/out/tmp bun /work/out/project-temporal-examples.ts`; evidence `executed-examples.json` | PASS exit 0 |
| Package/type/full gate | not assigned; no source change | NOT_RUN |
| Privacy/diff integrity | synthetic employment facts; no owner vault; no credentials | PASS (static) |
| Independent review | not assigned | NOT_RUN |
| Retained package/consumer | none | NOT_RUN |

Findings first:

1. Working-knowledge markdown omits stored `valid_from`, `valid_to`, `asserted_at`, `retracted_at`, `last_confirmed_at`, `created_at`, `corroboration`, `superseded_by`. A live closed historical interval and a live open current interval are indistinguishable in the packet except by object text. Source `packages/core/src/serving/candidates.ts:292-295`. Confirmed in `executed-examples.json`.
2. Gap lines are the only claim serving text that carry valid time (`after`/`before`). Confirmed: after=`2021-06-01T00:00:00.000Z`, before=`2022-01-01T00:00:00.000Z`.
3. Conflict lines omit intervals. `listLiveConflicts` then prints the entire live key group once any pair overlaps, so a non-overlapping historical member was included in `live=3`. Source `packages/core/src/claims/identity.ts:334-342`.
4. Grant windows use `valid_from` as `occurred_at` (`serving/claims.ts:64`). Packet `since`/`until` do not filter claims. Windowed grant served only Harbor Desk (`2026-02-28T11:00:00Z`).
5. Unavailable on main: `query_claims`, `as_of_valid`/`as_of_transaction`, ClaimV2 `temporal_basis` storage, structured claim envelope chunks, `graph_edges.valid_from/valid_to` in neighbor output, propose/correct temporal fields.

Remaining risk: full `context_packet` packing (tokenizer, budget) was not executed. Existing packet tests were not run. No native/account/release claim.

Next smallest action: P035 should add a focused characterization that the working-knowledge line omits the four timestamps while the gap line keeps after/before, and decide whether conflict groups should exclude non-overlapping members or print intervals. Rebase on live main before implementation.
