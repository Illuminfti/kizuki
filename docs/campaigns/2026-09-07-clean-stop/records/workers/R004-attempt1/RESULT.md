# Result R004

Outcome: FINDINGS. Scope: mapped requested BUILD-target labels versus measured `kizuki.sqlite-runtime/v1` identity from current source; existing tests already cover both expected objects.

- Repository/worktree/branch: read-only git archive `/repo`; no Git metadata; container worker `grok-R004`
- Base, input head, final head and tree: base `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7`; archive sha256 `187e004334b2aa998dd3ac9d29057e1725d635a00faab24d75bf092eef8b8f36`; no source edits
- Dirty/local-only state and owned files: repository untouched; outputs only under `/work/out`
- Applicable instruction/skill paths and effective discovery: `/work/AGENTS.md`, `/work/ROLE.md`, `/work/packet.json`, `orient-repository`, `issue-pickup-execution`, `test-strategy`, `handoff-work`; binding `docs/CURRENT.md`, RFC 0002/0000, `docs/stranger-proof.md` effective SQLite engine evidence
- What changed and why: no product behavior change; preparation artifacts separate requested `kizuki.release-build/v1` from measured child SQLite identity
- Ownership/dependencies: feeds P008, P091, P092; P003/P015/P006/Astra remain reserved

| Check | Exact command, head, runtime, time and evidence | Result |
| --- | --- | --- |
| Focused/public behavior | `cd /repo && bun test packages/core/test/sqlite-runtime.test.ts` on archive `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7`, bun 1.3.14, 2026-09-06T21:37:50Z, 27 pass | PASS |
| Artifact proof/engine parsers | `cd /repo && bun test scripts/artifact-proof.test.ts scripts/artifact-engine.test.ts`, bun 1.3.14, 44 pass, 30.50s including the 30s timeout case | PASS |
| Health runtime seam | `cd /repo && bun test packages/core/test/serving/health.test.ts` on archive `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7`, bun 1.3.14, 2026-09-06T21:44:10Z, 7 pass | PASS |
| Synthetic requested-vs-measured evaluator | `bun -e` `validateArtifactProof` matching vs unmatched objects, 2026-09-06T21:38:58Z, receipt `/work/out/validate-artifact-proof-check.json` | PASS |
| Archive-host bun:sqlite row | `bun -e` `readSqliteRuntime` on `:memory:`, 2026-09-06T21:38:04Z, receipt `/work/out/local-bun-sqlite-observation.json` | PASS as host Bun only, not native package |
| Qualification/go-no-go tests | `bun test scripts/qualification.test.ts` and `scripts/go-no-go.test.ts` | NOT_RUN: missing `js-tiktoken/lite`; no install permitted |
| CLI doctor / MCP stdio tests | `bun test packages/cli/test/doctor/legacy-ledger.test.ts packages/mcp/test/stdio.test.ts` | NOT_RUN: missing workspace package links |
| Package/type/full gate | `bun run typecheck` / `bun run verify` / `bun run proof:artifact` | NOT_RUN: no `node_modules`, no `dist/` native package |
| Privacy/diff integrity | read-only `/work/out` writes; synthetic identifiers only | PASS |
| Independent review | not assigned | NOT_RUN |
| Retained package/consumer | no native package in this archive | NOT_RUN |

Findings first, severity ordered: no product defect in the assigned observation contract. Confirmed limitation: this archive has no copied `kizuki`/`kizuki-mcp` binaries, so native child measurement was not executed. Host Bun 1.3.14 on linux/x64 reported sqlite 3.53.0 with the official source ID; that row is not native-package credit.

Remaining risk: Darwin still requires a native receipt because Bun uses system SQLite there. Downstream packets must consume the field map rather than infer SQLite identity from `target`. Next smallest action: P008/P091/P092 rebase onto this map; a retained native package remains a separate producer.

Do not infer integrated, released, live-account tested, unfamiliar-user accepted, or elapsed observation from another row.
