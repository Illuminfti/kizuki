# Result R017

Outcome: FINDINGS. Scope: read-only source-B authority/admission/erasure field map for P015; no repository edits, no competing schema.

- Repository/worktree/branch: `/repo` git archive of exact base; no Git metadata; live branch/HEAD/dirty unavailable in this container
- Base, input head, final head and tree: base `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7`; archive sha256 `187e004334b2aa998dd3ac9d29057e1725d635a00faab24d75bf092eef8b8f36`; no source head movement
- Dirty/local-only state and owned files: `/work/out` only (`orientation.md`, `source-b-authority-read-map.md`, `source-b-authority-read-map.json`, `existing-coverage.md`, `RESULT.md`, `result.json`, `checks/*`)
- Applicable instruction/skill paths and effective discovery: `/work/AGENTS.md`, `/work/ROLE.md`, `/work/packet.json`, `orient-repository`, `issue-pickup-execution`, `test-strategy`, `docs/CURRENT.md`, `docs/decision-log.md`, RFC 0002, `packages/core/AUTHORITY.md`, `docs/provenance-admission.md`
- What changed and why: no public behavior change. Produced a line-referenced caller/callee/field map of existing admitted-source lineage checks and available input fields.
- Ownership/dependencies: P015 owns source-B schema/recovery/authority/export; P003 shared evidence; P006 docs; this packet feeds P015 and P016

| Check | Exact command, head, runtime, time and evidence | Result |
| --- | --- | --- |
| Focused/public behavior | `bun test packages/core/test/positive-provenance.test.ts packages/core/test/page-provenance.test.ts packages/core/test/canon/authority-projection.test.ts` on archive of `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7`, Bun 1.3.14, 2026-09-06T21:46:59Z, `/work/out/checks/focused-authority-provenance.log` | mixed: 19 pass then 1 fail/error loading `authority-projection.test.ts` (`Cannot find module 'js-tiktoken/lite'`). `positive-provenance` 12 PASS, `page-provenance` 7 PASS. Combined command is not a clean PASS. |
| Mixed source-B tests | `bun test packages/core/test/source-grants.test.ts -t "receipted mixed canon preserves independently supported B text"`; `/work/out/checks/mixed-source-b.log` | NOT_RUN as product proof: file failed to load (`js-tiktoken/lite`). Missing input: `/repo/node_modules`. |
| Write-page source erasure | `bun test packages/core/test/canon/write-page.test.ts -t "source erasure"`; `/work/out/checks/write-page-source-erasure.log` | PASS (3 tests, 0 fail) |
| Claims authority + apply | `bun test packages/core/test/claims/authority.test.ts packages/core/test/canon/apply.test.ts`; `/work/out/checks/claims-authority-apply.log` | PASS (17 tests, 0 fail) |
| Package/type/full gate | `bun test`, `bun run typecheck`, `bash scripts/verify.sh` | NOT_RUN: read-only prep; root owns full-suite slot; `node_modules` absent |
| Privacy/diff integrity | no repository diff | NOT_RUN (no source edits) |
| Independent review | not assigned | NOT_RUN |
| Retained package/consumer | none | NOT_RUN |

Findings first, severity ordered:

1. Observation (P015 must preserve, not redesign): dual authority read — `resolve()` vs `basis()` at `packages/core/src/canon/authority.ts:67-73`. Serving `loadCanon` publishes `resolve()`; positive admission uses `basis()`. Unrecorded hash is `owner_authored` for overwrite protection and not positive evidence.
2. Unresolved field handling: `event:` prefix stripped by `eventIdFromReference` in admission (`vault/provenance.ts:22`) and some writer filters, but `eraseSourceCanon` page-source match (`source-canon-erasure.ts:168`), search `pageDocument.provenance`, and graph source edges use raw strings.
3. Unresolved fields: `source_event_bindings.grant_revision` and `policy_digest` stored at capture (`source-grants.ts:680-685`) and unused by `assessLivePageEvidence`.
4. Unresolved residue: after source-B path sanitization (`source-canon-erasure.ts:289-293`) SQLite/JSONL still keep `authority` and `provenance`.
5. Mixed independence uses claim body presence plus provenance⋈bindings (`source-canon-erasure.ts:40-100`), not `page.sources ∩ bindings`. Existing tests cover this; do not duplicate.

These are current-code observations for P015, not executed product-bug proofs. No competing schema is proposed.

Remaining risk: mixed source-B and authority-projection suites were not executed here because `js-tiktoken/lite` is absent. Full gate NOT_RUN. No live-account, native, or unfamiliar-user claim. Next smallest action: P015 implements source-B schema/recovery/authority/export against this map and the existing tests listed in `existing-coverage.md`, rebased on the live base.
