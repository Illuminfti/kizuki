# Result R014

Outcome: FINDINGS. Scope: ordinary create/revise/archive/delete input validation and error ordering for `applyCanonWrite` / `applyRevertWrite` on base `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7`. Preparation only; no source edits.

- Repository/worktree/branch: read-only git archive `/repo` (no Git metadata). Packet owner grok-R014. Write scope `/work/out` only.
- Base, input head, final head and tree: base `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7`; archive sha256 `187e004334b2aa998dd3ac9d29057e1725d635a00faab24d75bf092eef8b8f36`. Head did not move. Remote not fetched (Git absent).
- Dirty/local-only state and owned files: repository untouched. Owned outputs under `/work/out`.
- Applicable instruction/skill paths and effective discovery: `/work/AGENTS.md`, `/work/ROLE.md`, `/work/packet.json`, `orient-repository`, `issue-pickup-execution`, `test-strategy`, `handoff-work`; binding `docs/CURRENT.md`, `docs/decision-log.md`, `rfcs/0002-autonomous-canon.md`, `packages/core/AGENTS.md`.
- What changed and why: mapped ordinary writer preconditions; cited existing tests; drafted only uncovered table-driven rows; recorded two confirmed RFC/error-type gaps.
- Ownership/dependencies: feeds P018 and P019. P015 retains schema. P003 evidence design, P006 docs, Astra/doctor remain reserved.

| Check | Exact command, head, runtime, time and evidence | Result |
| --- | --- | --- |
| Focused/public behavior | `bun test /repo/packages/core/test/canon/apply.test.ts` at archive `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7`, bun 1.3.14, 2026-09-06, `/work/out/evidence/checks.md` | PASS 9/9 |
| Related existing canon tests | `bun test` receipt-totality, undo, purge-review-retirement, arbiter, vault-containment | PASS 43/43 |
| New ordinary draft | `bun test /work/out/apply-ordinary-preconditions.draft.test.ts` | PASS 9/9 |
| RFC gap draft | `bun test /work/out/apply-rfc-gaps.draft.test.ts` | FAIL 0/2 (findings) |
| Package/type/full gate | `bun run typecheck` / `scripts/verify.sh` | NOT_RUN (not assigned; no full-suite slot) |
| Privacy/diff integrity | no source diff; synthetic fixtures only | PASS (static) |
| Independent review | not assigned | NOT_RUN |
| Retained package/consumer | none | NOT_RUN |

Findings first, severity ordered:

1. **Medium — `apply.ts:478-493`.** RFC 0002 §4.4: `deletion` requires an existing page. A caller-built `{action:"create"}` with a live `kind=deletion` claim creates an active page (`page_action=create`, `status=active`) instead of refusing. Observed via `bun /work/out/observe-deletion-create.ts`. Affected invariant: structural refusal before mutation. Smallest correction: refuse `page_required` or `page_missing` before `prepareCreate` when `kind` is not a create kind. Do not change schema.

2. **Low — `apply.ts:643` / `vault/write.ts:242`.** Ordinary revert-delete of a missing page with a named hash throws `CanonWriteRefused` instead of `CanonWriteError("page_missing")`. `expected_hash=null` already uses `CanonWriteError`. Affected invariant: typed writer errors. Smallest correction: map that `writePage` refusal to `CanonWriteError` before callers see it.

Spec note, not a defect: RFC 0002 §4.5 says `budget.chargeWrite()` is first; implemented preflight and `apply.test.ts:99-127` require unknown-claim/skip to fail without spending a write unit. Keep the tests.

Remaining risk: full repository gate NOT_RUN; Git/remote unverified; no native/account/model qualification. Next smallest action: P018 adopt the new ordinary draft (do not duplicate cited rows) and the RFC-gap assertions as regressions.
