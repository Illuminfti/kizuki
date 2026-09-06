# Result R021

Outcome: FINDINGS. Scope: restore command preflight and public outcome
reporting on frozen base `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7`.

- Repository/worktree/branch: `/repo` git archive; no Git metadata, remotes, or dirty tree
- Base, input head, final head and tree: `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7` (unchanged; no source edits)
- Dirty/local-only state and owned files: `/work/out` only
- Applicable instruction/skill paths: `/work/AGENTS.md`, `/work/ROLE.md`, orient-repository, issue-pickup-execution, test-strategy, backup-restore, cli-terminal-ux, handoff-work, elegance-review
- What changed: preparation artifacts only (table, fixtures, receipts)
- Ownership: feeds P028, P090; P003/P015/P006/Astra reserved

| Check | Exact command, head, runtime, time and evidence | Result |
| --- | --- | --- |
| Focused/public behavior | `bun /work/out/invoke-restore-fixtures.ts` on base `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7`, Bun 1.3.14, 2026-09-06T22:02:05Z–22:02:07Z, `invocation-receipts.json` | 21/21 handler+core PASS; CLI process NOT_RUN |
| Package/type/full gate | not assigned | NOT_RUN |
| Privacy/diff integrity | synthetic empty vault only; no owner data | PASS (scoped) |
| Independent review | not assigned | NOT_RUN |
| Retained package/consumer | no native artifact | NOT_RUN |

Findings first: verify-only accepts future serve schema that restore-into refuses (`export.ts:2308-2336`, I4 executed); `--verify` does not block `--into` (`restore.ts:13,19-29`, A9); `--json` unknown on restore; occupied target uses export wording; CLI process spawn blocked by missing `@kizuki/tui` node_modules.

Remaining risk: process-level stdout/stderr of `bun packages/cli/src/main.ts` not observed. Next: P028 CLI tests from these fixtures; optionally align verify and restore serve ceilings.
