# Result R038

Outcome: FINDINGS recorded as current-code representation facts; packet status `prepared`. Scope: line-referenced map of copied support references from `CaptureEvent` through deterministic staging into `ProposalInput` / `StagedProposal` / compat claim rows, plus neutral schema fixtures. Semantic attribution remains with P034/Astra. No repository edits.

- Repository/worktree/branch: read-only git archive `/repo` of base `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7` (`FLEET-SOURCE-IDENTITY.json`). No Git metadata in this container. Remote state not fetched.
- Base, input head, final head and tree: base = `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7`; no product checkout mutation; owned outputs under `/work/out` only.
- Dirty/local-only state and owned files: `/work/out/**` only.
- Applicable instruction/skill paths: `/work/AGENTS.md`, `/work/ROLE.md`, `/work/packet.json`, `/repo/AGENTS.md`, `/repo/packages/core/AGENTS.md`, `/repo/docs/CURRENT.md`, `/repo/docs/decision-log.md`, `/repo/rfcs/0002-autonomous-canon.md` §4.3, `/work/.grok/skills/orient-repository/SKILL.md`, `issue-pickup-execution`, `test-strategy`, `handoff-work`.
- What changed and why: preparation artifacts only. Public staging contract unchanged.
- Ownership/dependencies: P003 evidence design, P015 source-B schema, P006 docs, Astra/P034 attribution remain reserved. Feeds P032 and P033.

| Check | Exact command, head, runtime, time and evidence | Result |
| --- | --- | --- |
| Focused staging + subject-role tests | `cd /repo && bun test ./packages/core/test/staging/producers.test.ts ./packages/core/test/staging/proposals.test.ts ./packages/core/test/staging/page-candidate.test.ts ./packages/core/test/staging/origin-guard.test.ts ./packages/core/test/producer/subject-roles.test.ts` at base `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7`, bun 1.3.14, 2026-09-06T21:46:48Z, 89 pass / 0 fail | PASS |
| `no-return.test.ts` (core index import) | same bun test adding `./packages/core/test/staging/no-return.test.ts` at 2026-09-06T21:46:30Z | FAIL / unavailable: `Cannot find module 'js-tiktoken/lite'` from `packages/core/src/serving/packet-tokenizer.ts`. Not treated as a staging-contract failure. |
| Local fixture emitter | `bun /work/out/emit-staged-support-fixtures.ts` 2026-09-06T21:59:54Z, in-memory SQLite, outputs under `/work/out/fixtures/` | PASS (exit 0) |
| Package/type/full gate | `bun test` workspace / `bunx tsc --noEmit` / `bash scripts/verify.sh` | NOT_RUN (read-only preparation; no full-suite slot) |
| Privacy/diff integrity | synthetic fixture ids only; no owner vault, credentials, or private records | PASS (static) |
| Independent review | not assigned | NOT_RUN |
| Retained package/consumer | none | NOT_RUN |

Findings first: role is dropped at `proposalsForEvent`; capture-note subjects are not uniqued while page-candidate subjects are; corroboration merges provenance only; compat `claim.subject` is `subjects[0]` with null predicate/object/claim_key; model extract uses raw subject ids via `insertClaim`, not this namespaced staging path.

Remaining risk: full repository gate not run; `no-return` import failed on missing `js-tiktoken/lite` in this archive runtime; Git remotes unverified. Next smallest action: P032/P033 consume `/work/out/support-reference-map.md` and `/work/out/fixtures/` without assuming role or v2 support roots on staged rows.
