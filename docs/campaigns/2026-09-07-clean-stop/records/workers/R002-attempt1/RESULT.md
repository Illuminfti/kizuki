# Result R002

Outcome: FINDINGS. Scope: evidence-index read/parse/diagnostic map plus three ordinary fixtures (absent, empty, well-formed incomplete) on archive `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7`. No repository edits.

- Repository/worktree/branch: git-archive `/repo` (no Git metadata). Live branch/HEAD/remotes unverified in this container.
- Base, input head, final head and tree: base `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7`; archive sha256 `187e004334b2aa998dd3ac9d29057e1725d635a00faab24d75bf092eef8b8f36`. No worker commits.
- Dirty/local-only state and owned files: `/work/out/**` only. `/repo` untouched.
- Applicable instruction/skill paths: `/work/AGENTS.md`, `/work/ROLE.md`, `/repo/AGENTS.md`, `/repo/docs/CURRENT.md`, `/repo/docs/decision-log.md`, `/repo/rfcs/0002-autonomous-canon.md`, `/repo/docs/release-acceptance.md`, skills orient-repository, issue-pickup-execution, test-strategy, handoff-work.
- What changed and why: preparation artifacts for P004/P010. No public product behavior changed.
- Ownership/dependencies: P003 evidence design, P006 docs, P015 source-B, Astra/doctor reserved. This packet does not absorb them.

| Check | Exact command, head, runtime, time and evidence | Result |
| --- | --- | --- |
| Focused/public behavior | `bun /repo/scripts/go-no-go.ts --profile rc --evidence … --out …` at archive `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7`, Bun 1.3.14, 2026-09-06 | NOT_RUN (ReadOnlyFileSystem; missing node_modules) |
| Replica index-load draft | `bun /work/out/run-fixtures.ts` 2026-09-06T21:41:45.739Z exit 0; `/work/out/runs/summary.json` | PASS for independent field checks on replica only |
| Package/type/full gate | `bun test scripts/go-no-go.test.ts`, `bun run typecheck`, `bun run verify` | NOT_RUN (same blockers; no source change) |
| Privacy/diff integrity | Read-only archive; fixtures are synthetic 0-byte / 124-byte JSON / absent path; no vault paths | PASS (static) |
| Independent review | Not assigned; self-prep only | NOT_RUN |
| Retained package/consumer | None | NOT_RUN |

Findings first: missing index overwrites `index-missing` with `evidence-unreadable-or-invalid` (`scripts/go-no-go.ts:151,176-180`). Empty file → `invalid-json`. Incomplete four-key JSON → `invalid-schema`. Public CLI unexecuted.

Remaining risk: replica is not the public module graph; CLI exit 1 is statically inferred; live GitHub/issue #541 state unverified. Next: P004 add the three ordinary tests and pick one missing-file reason token; rebase before production use.
