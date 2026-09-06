# Result R074

Outcome: FINDINGS. Scope: Claude snapshot identity, progress counts, and completion markers traced into public import/doctor/status output. No repository edits.

- Repository/worktree/branch: `/repo` git archive of `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7`; no Git metadata; remote not fetched (controller-owned)
- Base, input head, final head and tree: `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7` (archive_sha256 `187e004334b2aa998dd3ac9d29057e1725d635a00faab24d75bf092eef8b8f36`)
- Dirty/local-only state and owned files: `/work/out` only
- Applicable instruction/skill paths: `orient-repository`, `issue-pickup-execution`, `connector-work`, `test-strategy`, `handoff-work`; `packages/connectors/AGENTS.md`, `packages/cli/AGENTS.md`, RFC 0000/0002, `docs/CURRENT.md`
- What changed and why: preparation artifacts mapping current code; no product change
- Ownership/dependencies: feeds P072 and P087; P006 docs, P003 evidence, doctor owners untouched

| Check | Exact command, head, runtime, time and evidence | Result |
| --- | --- | --- |
| Focused/public behavior | `bun /work/out/verify-report-fields.ts` on 2026-09-06T22:02:00Z, bun 1.3.14, exit 0; formulas only | PASS (formulas) |
| Parse/import/doctor E2E | `bun -e` import of `parseClaudeExport` exit 1 missing `@kizuki/core` | NOT_RUN |
| Package/type/full gate | `bun run verify` | NOT_RUN |
| Privacy/diff integrity | Static: error reasons are code phrases; fixtures are synthetic hello/world | PASS (static) |
| Independent review | Not assigned | NOT_RUN |
| Retained package/consumer | None | NOT_RUN |

Findings first:

1. **Public count split.** `kizuki import` prints `runToCompletion` totals (`cli/src/commands/import.ts:137`) while doctor, connect status, and serve health print `checkpoints.last_result` of the last batch (`cli/src/commands/doctor.ts:234`, `cli/src/connect-catalog.ts:77`, `core/src/serving/health.ts:98`). After a completed Claude import the empty identity-match batch leaves `stored=0` on those surfaces while stdout showed `events_stored=N`.
2. **Parse skips are invisible on import stdout.** `ImportRecordError` only reaches `health.detail` (`import-report.ts:41-66`). Partial imports exit 0 with `errors=0`.
3. **Docs vs code on tombstones.** README says snapshot importers never tombstone; Claude/ChatGPT declare `tombstones: true` and emit them on a later clean export. P006 owns docs.
4. **Cursor bound.** Snapshot cursor stores every record hash under 8 KiB (`MAX_CURSOR_BYTES`). A modest export can refuse persist after a successful parse. Not load-tested here.

Remaining: workspace install required to execute parser/CLI. Next: P072 should bind public import completion to this map (do not duplicate P071 parser goldens). P087 should not invent a second count contract.
