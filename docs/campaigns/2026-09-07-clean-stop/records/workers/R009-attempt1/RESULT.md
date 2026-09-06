# Result R009

Outcome: FINDINGS plus prepared artifacts. Scope: static source-class map and labeled rehearsal versus actual-observation-required pairs for journey/stranger evidence. No repository edits. No native, account, model, or human qualification claim.

- Repository/worktree/branch: `/repo` read-only git archive of `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7`; no Git metadata. Remote not verified here.
- Base, input head, final head and tree: base `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7`; archive sha256 `187e004334b2aa998dd3ac9d29057e1725d635a00faab24d75bf092eef8b8f36`; this lane wrote only `/work/out`.
- Dirty/local-only state and owned files: `/work/out/**` only.
- Applicable instruction/skill paths and effective discovery: `/work/AGENTS.md`, `/work/ROLE.md`, `/work/packet.json`, `orient-repository`, `issue-pickup-execution`, `test-strategy`; binding `docs/CURRENT.md`, `docs/decision-log.md` D19, `rfcs/0002-autonomous-canon.md`.
- What changed and why: preparation artifacts that keep synthetic artifact/qualification rehearsal from being read as complete product journeys.
- Ownership/dependencies: P003 evidence design, P015 source-B, P006 docs, Astra/doctor reserved. Feeds P007, P009, P099.

| Check | Exact command, head, runtime, time and evidence | Result |
| --- | --- | --- |
| Focused/public behavior | `bun /work/out/scripts/check-source-class-isolation.ts` and empty-index `bun /repo/scripts/go-no-go.ts --profile rc\|1.0 ...` on `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7`, Bun 1.3.14, 2026-09-06T21:39Z, `/work/out/checks/` | PASS isolation; CLI exit 1 NO-GO as required |
| Package tests without vault-init imports | `bun test scripts/stranger-proof.test.ts scripts/artifact-proof.test.ts packages/core/test/serve/qualification.test.ts` | PASS 51/0 |
| go-no-go.test.ts / qualification.test.ts | same bun test; missing `js-tiktoken/lite` | NOT_RUN |
| Package/type/full gate | `bun run typecheck` / `bun run verify` | NOT_RUN |
| Privacy/diff integrity | no repo diff; empty index and reports contain no vault paths or source text | PASS for this lane |
| Independent review | not assigned | NOT_RUN |
| Retained package/consumer | no native package in this archive | NOT_RUN |

Findings first, severity ordered:

1. Confusion risk, `scripts/stranger-proof.ts` and `docs/stranger-proof.md`: filename and historical stranger language overlap `human.unfamiliar-user`. CURRENT.md:52-53 already says the automated artifact check is not a human stranger proof. Evaluator keeps `human.unfamiliar-user` `NOT_IMPLEMENTED`.
2. Confusion risk, `scripts/artifact-proof.ts:115`: comment “Validate a successful recorded journey” plus init/import/query/restore steps overlap `journey.install-recover` while credited scope is `automated-fixture-integrity`.
3. Coverage gap, `scripts/go-no-go.test.ts`: no assertion that all eight `journey.*` and fifteen `connector.*` rows stay `NOT_IMPLEMENTED` after an artifact PASS. Static `evaluateRelease` body never looks those rows up. The suite was not executed here because `js-tiktoken/lite` is absent.
4. Confirmed isolation: empty v2 inventory → 41 gates, all journeys `NOT_IMPLEMENTED` / `complete-product-journey`, CLI exit 1. Qualification `release_qualified` is `false as const`.

Remaining risk: P007/P009/P099 could add a producer that copies artifact-proof steps into journey credit. That would be a new contract, not current behavior. Missing `node_modules` blocked two existing test files. Full verify, native packages, live accounts, and unfamiliar-user runs remain unrun.

Next smallest action: P007/P009/P099 consume `/work/out/source-class-dataflow.md` and `/work/out/rehearsal-vs-observation-pairs.json`; keep new journey producers off `kizuki.artifact-proof/v2` and `kizuki.qualification/v1`.
