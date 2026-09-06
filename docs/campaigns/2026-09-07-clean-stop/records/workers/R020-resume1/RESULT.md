# Result R020

Outcome: PREPARED. Scope: current-code inventory of `kizuki.backup/v3` table/column/manifest-version mapping with ordinary nullable/default JSON representation. No repository edits. P015 portable schema untouched.

- Repository/worktree/branch: read-only git archive `/repo` (no Git metadata)
- Base, input head, final head and tree: `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7` (FLEET-SOURCE-IDENTITY.json); no product HEAD movement
- Dirty/local-only state and owned files: only `/work/out/**`
- Applicable instruction/skill paths: `/work/AGENTS.md`, `/work/ROLE.md`, `/work/packet.json`, `orient-repository`, `issue-pickup-execution`, `test-strategy`, `handoff-work`; binding `docs/CURRENT.md`, RFC 0002, RFC 0000, `docs/export-inventory.md`, `docs/portable-connection-restore.md`
- What changed and why: preparation artifacts mapping export streams to SQLite columns and JSON null/default rules for P028/P015
- Ownership/dependencies: P015 owns export implementation; P006 docs; P003 evidence design; this packet does not replace them

| Check | Exact command, head, runtime, time and evidence | Result |
| --- | --- | --- |
| Focused/public behavior | bun 1.3.14 @ `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7`; generate-empty-export.ts exit 0; generate-nullable-rows.ts exit 0; `bun test packages/core/test/export.test.ts --test-name-pattern "writes a complete kizuki.backup/v3"` exit 0; export-connections null-state exit 0; event-backup-v2 empty intent exit 0; export-purge-history source-only batch exit 0; export.test claim restore exit 0 | PASS |
| Package/type/full gate | `bunx tsc --noEmit` / `bash scripts/verify.sh` | NOT_RUN |
| Privacy/diff integrity | no repository diff | NOT_RUN |
| Independent review | not assigned | NOT_RUN |
| Retained package/consumer | not assigned | NOT_RUN |

Findings first, severity ordered: contract facts, not product defects. `events.sensitivity_hint` SQL NULL is omitted from JSONL (`export.ts:846-848`); claim nullable columns emit JSON null (`export.ts:874-907`); connections synthesize disconnected null-state (`export.ts:1231-1240`); new v3 always declares empty streams including purge history.

Remaining risk: full gate not run. Next smallest action: P015/P028 consume `export-table-column-manifest-map.json` and `expected-export-manifest.json` without collapsing omit-key vs json-null.

Exact filenames: `export-table-column-manifest-map.json`, `expected-export-manifest.json`, `existing-coverage.json`, `empty-export-capture.json`, `nullable-row-samples.json`, `result.json`, `RESULT.md`.
