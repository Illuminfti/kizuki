# Result R082

Outcome: FINDINGS. Scope: Omnivore is an unzipped-export snapshot importer; selected inputs, silent exclusions, and public health projection are mapped from current source. No live provider claim. No P079 goldens duplicated. No repository edits.

- Repository/worktree/branch: read-only git archive `/repo` of `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7` (FLEET-SOURCE-IDENTITY.json). No Git metadata. Remote state not verified.
- Base, input head, final head and tree: base `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7`; this lane wrote `/work/out` only.
- Dirty/local-only state and owned files: `/work/out/*` listed in result.json artifacts.
- Applicable instruction/skill paths and effective discovery: `/work/AGENTS.md`, `/work/ROLE.md`, `/work/packet.json`, `/repo/AGENTS.md`, `/repo/packages/connectors/AGENTS.md`, `/repo/docs/CURRENT.md`, skills orient-repository, issue-pickup-execution, connector-work, test-strategy, handoff-work.
- What changed and why: preparation artifacts only — layout/count/report map, compiled-command manifest, local accounting draft.
- Ownership/dependencies: P080/P087 consume this map. P006 owns docs. Shared registry/lockfiles untouched.

| Check | Exact command, head, runtime, time and evidence | Result |
| --- | --- | --- |
| Focused/public behavior | `bun /work/out/draft-omnivore-accounting.ts` (bun 1.3.14); evidence `/work/out/accounting-result.json`; selected 2 metadata files, 6 root exclusions, 3 objects, 1 silent not_object; projection `records=3; 1 record errors (not_object=1)` | PASS |
| Existing Omnivore unit tests | `bun test packages/connectors/test/omnivore.test.ts` at archive `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7`; bun 1.3.14; `Cannot find module '@kizuki/core'`; EXIT 1 | NOT_RUN |
| Package/type/full gate | `bash scripts/verify.sh` | NOT_RUN (no workspace install; full-suite slot not owned) |
| Privacy/diff integrity | static: refusals name file/index; import-report forbids captured text; no private records in `/work/out` | PASS (static) |
| Independent review | not assigned | NOT_RUN |
| Retained package/consumer | none | NOT_RUN |

Findings first, severity ordered:

1. `packages/connectors/src/import-omnivore/index.ts:126-140` — health is a 64-byte probe with no `records=` and no `ImportRecordError`. `import-report.ts` is unused. ChatGPT/Claude/markdown-folder already project through `importHealthReport`. Affected invariant: public import accounting. Required fix (P080/P087, not this lane): wire or explicitly document the absence.
2. `packages/connectors/README.md:194-197` vs `packages/core/src/util/hash.ts:57-63` and `importers-tombstones.test.ts:269-307` — README says a later `content/` unzip re-stores nothing; v2 content_hash includes attachments and the test stores a new revision. P006 docs vs importer identity.
3. `packages/connectors/src/import-omnivore/metadata.ts:95` — non-plain-object array elements are dropped with no count. No existing Omnivore test. ChatGPT reports `not_object`.
4. `docs/wave1/specs/importers-exports.md:861` — spec says health follows `fsOmnivoreFiles`; code uses `probeOmnivoreExport`. Stale spec; P006.

Remaining risk: existing package tests and full gate were not run on this host (missing `@kizuki/core` workspace install). Live Omnivore access is not claimed. Next smallest action: P080 consume the map; if public accounting is in scope, reuse `importHealthReport` rather than a new report type; reconcile README identity sentence before copying it.

No merge, deploy, release, account, or model action taken.
