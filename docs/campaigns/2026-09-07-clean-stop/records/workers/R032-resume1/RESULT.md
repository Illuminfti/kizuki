# Result R032

Outcome: FINDINGS (prepared). Scope: current-code map of bun:sqlite transaction return/error/nesting plus a stub call-order draft for P018/P030. No repository edits.

- Repository/worktree/branch: read-only git archive `/repo` of `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7` (archive sha256 `187e004334b2aa998dd3ac9d29057e1725d635a00faab24d75bf092eef8b8f36`). No Git metadata. Host navigation not run (controller adaptation).
- Base, input head, final head and tree: base = input = `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7`. This lane wrote `/work/out` only.
- Dirty/local-only state and owned files: `/work/out/*` only. `/repo` untouched.
- Applicable instruction/skill paths: `/work/AGENTS.md`, `/work/ROLE.md`, `/repo/AGENTS.md`, `/repo/packages/core/AGENTS.md`, `/repo/docs/CURRENT.md`, `/repo/docs/decision-log.md`, RFC 0002/0000, skills orient-repository, issue-pickup-execution, sqlite-data-modeling, test-strategy.
- What changed and why: preparation artifacts only. Public product behavior unchanged.
- Ownership/dependencies: feeds P018 and P030. P003/P015/P006/Astra remain reserved.

| Check | Exact command, head, runtime, time and evidence | Result |
| --- | --- | --- |
| Focused/public behavior | `bun test /work/out/sqlite-tx-call-order.draft.test.ts` on Bun 1.3.14 at 2026-09-06; exit 0; 12 pass / 0 fail; `/work/out/draft-execution.txt`. Stub only; no SQLite. | PASS (stub draft) |
| Existing wrapper cases | Static read of `event-causal-origin.test.ts` 81-90, `extract-atomic.test.ts` 261-272, `export-snapshot.test.ts` 132-138, `self-ingest.test.ts` 230-245, `extract-checkpoint.test.ts` 23-36, `ingest.test.ts` 340-361, `sqlite-runtime.test.ts`. Not re-run (no DB stress). | NOT_RUN (static) |
| Package/type/full gate | `bun test`, `bunx tsc --noEmit`, `bash scripts/verify.sh` | NOT_RUN |
| Privacy/diff integrity | No source diff. No credentials, vaults, or private records. | PASS |
| Independent review | Not assigned | NOT_RUN |
| Retained package/consumer | None | NOT_RUN |

Findings first: no confirmed product defect. Notes: (1) `packages/core/src/util/sql.ts` is placeholders, not a transaction wrapper — the wrapper is bun:sqlite `Database.transaction`. (2) Nested `.immediate()` is a SAVEPOINT; begin flavor is ignored. (3) `accept` converts many inner throws into result objects, so only a later throw aborts an outer transaction. Existing tests cover outer-throw rollback of nested `accept` and several top-level `inTransaction` guards; they do not record wrapper call-order.

Remaining risk: stub is not bun:sqlite; auto-abort path is a model of wrapTransaction's `if (db.inTransaction)` guard, not a SQLite trigger. Full gate not run. Next smallest action: P018/P030 consume `/work/out/wrapper-contract-table.md` and the stub draft; do not duplicate `event-causal-origin.test.ts` 81-90; keep top-level guards on claim insert, loop byte intent, export, enrollment, extraction filing.

No merge, deploy, publication, auth retest, or other-model invocation.
