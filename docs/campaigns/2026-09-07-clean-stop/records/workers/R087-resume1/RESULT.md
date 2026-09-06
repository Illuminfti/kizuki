# Result R087

Outcome: PREPARED. Scope: execution-gated argv/state observation adapter for ordinary `agent revoke`, `purge`, and `rebuild`, with independent unrelated-source preservation observations. No repository source edits.

- Repository/worktree/branch: read-only git archive `/repo`; no Git metadata; write scope `/work/out` only
- Base, input head, final head and tree: `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7` (FLEET-SOURCE-IDENTITY.json). Archive sha256 `187e004334b2aa998dd3ac9d29057e1725d635a00faab24d75bf092eef8b8f36`. Remote not fetched.
- Dirty/local-only state and owned files: repository untouched. Owned outputs listed under `/work/out`.
- Applicable instruction/skill paths: `/work/AGENTS.md`, `/work/ROLE.md`, `/work/packet.json`, `orient-repository`, `issue-pickup-execution`, `provenance-invalidation`, `cli-terminal-ux`, `test-strategy`, `handoff-work`. Binding: `docs/CURRENT.md`, `docs/decision-log.md`, `rfcs/0002-autonomous-canon.md`.
- What changed and why: drafted a standalone classifier and preservation map for the current public CLI seams. Existing tests that already prove pieces are cited, not duplicated.
- Ownership/dependencies: feeds P085 and P099. P003 evidence design, P015 source-B, P006 docs remain reserved.

| Check | Exact command, head, runtime, time and evidence | Result |
| --- | --- | --- |
| Adapter self-check (21 argv cases) | `bun /work/out/observe-revoke-purge-rebuild.ts --self-check` at archive `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7`, Bun 1.3.14, 2026-09-06T22:06:43Z, `/work/out/checks/argv-self-check.json` | PASS |
| Execute without permit | same binary `--execute --workspace /work/out/synth`; exit 2 | PASS |
| Gated mutation spawn | `--execute --permit-synthetic-mutation --workspace /work/out/synth`; status unexecuted, spawn refused | PASS (honest UNEXECUTED) |
| CLI package tests | `bun test packages/cli/test/{agent,purge,purge-subject-scope,rebuild}.test.ts` | NOT_RUN |
| Package/type/full gate | `bash scripts/verify.sh` | NOT_RUN |
| Privacy/diff integrity | no repository diff; adapter writes only under `/work/out`; no owner vault opened | PASS |
| Independent review | not assigned | NOT_RUN |
| Retained package/consumer | none built | NOT_RUN |

Findings first, severity ordered:

1. Coverage gap (not a confirmed CLI defect): no existing CLI test chains two independent sources through targeted revoke/purge then rebuild while asserting source B event/query/grant/canon snapshots. Pieces exist (`purge-subject-scope.test.ts:72-107`, `rebuild.test.ts:10-65`, `source-grants.test.ts:399-438`, `agent.test.ts:119-144`). The gated longitudinal plan in the adapter is the integration artifact; a new repository test was not added.
2. UX note: `packages/cli/src/help.ts` GROUPS/EXAMPLES omit `rebuild` while `packages/cli/src/commands/index.ts:59` registers it. `help rebuild` still prints usage. Not a readiness claim.

Remaining risk: repository tests and any synthetic vault mutation remain unexecuted because `/repo/node_modules` is absent, bun install is forbidden, and this packet forbids spawning purge or revoke. Next smallest action is P085 reviewing this adapter and, after a workspace install plus an explicit synthetic `/work/out` permit, running the unexecuted two-source chain without duplicating existing single-seam tests.

No merge, deploy, release, live-account, native qualification, or unfamiliar-user acceptance.
