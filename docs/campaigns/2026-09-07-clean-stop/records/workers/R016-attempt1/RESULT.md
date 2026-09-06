# Result R016

Outcome: FINDINGS. Scope: independent field round-trip matrix and golden frontmatter fixtures for documented canon provenance values; no source edits; no P015 authority redesign.

- Repository/worktree/branch: `/repo` git archive of `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7` (no Git metadata). Lane writes `/work/out` only.
- Base, input head, final head and tree: base `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7`; archive sha256 `187e004334b2aa998dd3ac9d29057e1725d635a00faab24d75bf092eef8b8f36`; no product HEAD movement.
- Dirty/local-only state and owned files: product tree untouched. Owned outputs listed in `result.json`.
- Applicable instruction/skill paths and effective discovery: `/work/AGENTS.md`, `/work/ROLE.md`, `/work/packet.json`, `orient-repository`, `issue-pickup-execution`, `test-strategy`, `handoff-work`; binding `docs/CURRENT.md`, `docs/decision-log.md`, `rfcs/0002-autonomous-canon.md`.
- What changed and why: no product change. Prepared lossless-representation goldens and an absent/empty/unknown matrix for P022/P028.
- Ownership/dependencies: P015 retains authority/schema/recovery/export; P003 evidence design; P006 docs; this packet feeds P022 and P028.

| Check | Exact command, head, runtime, time and evidence | Result |
| --- | --- | --- |
| Focused/public behavior | `bun /work/out/verify-round-trip.ts` and `bun test /work/out/draft-round-trip.test.ts` on `f57acb3…`, Bun 1.3.14, 2026-09-06T21:46:47Z; also existing `page-provenance` sources-shape and `canon/origin` tests | PASS |
| Package/type/full gate | not requested / no test slot / archive missing `js-tiktoken` for public index | NOT_RUN |
| Privacy/diff integrity | synthetic ordinary values only; no owner vault, credentials, or provider calls | PASS (static) |
| Independent review | C2 other-model lens not this worker | NOT_RUN |
| Retained package/consumer | none published | NOT_RUN |

Findings first, severity ordered:

1. Confirmed — `validatePage` does not require `sources`; `parsePageSources` does (`schema.ts:47-54` vs `118-132`). Absent and empty-active sources are distinct. Existing test `page-provenance.test.ts:41-58` (executed, exit 0).
2. Confirmed — whitespace-only `id` (`" "`) passes `validatePage` because `isNonEmptyString` does not trim (`validate.ts:102-104`). Sources blankness does trim. Gap; golden `fixtures/distinctions/whitespace-id.md`.
3. Confirmed — `stringArray` collapses absent/invalid/empty to `[]` (`pages.ts:45-48`). Parse/serialize still distinguish. Do not use the helper as the page contract.
4. Confirmed — padded source ids (`" event:01 "`) survive `parsePageSources`. They will not match a trimmed ledger id and must not be auto-trimmed into one.
5. Hypothesis / downstream — `apply.ts` maps unknown taint to `"clean"` on revision/purge. Parse layer preserves unknown taint. P015/P022; not redesigned here.

Remaining risk: full repository gate NOT_RUN; public-index tests blocked on `js-tiktoken/lite`; live admission (`assessLivePageEvidence`) not re-executed in the independent verifier. Next smallest action: P022 adopts gap goldens without collapsing absent/empty/unknown and without granting authority.

No merge, deploy, publication, or qualification claim.
