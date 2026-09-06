# Result R068

Outcome: FINDINGS. Scope: static export/call-site graph of shared X native identities and the exact root-integration checklist for a later P063 identity-helper change; no source edits, no second P065 lineage oracle.

- Repository/worktree/branch: `/repo` read-only git archive of `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7` (`FLEET-SOURCE-IDENTITY.json`). No Git metadata. Live remotes/PRs/worktrees were not inspected here; root owns that.
- Base, input head, final head and tree: base `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7`. No repository HEAD movement. Outputs only under `/work/out`.
- Dirty/local-only state and owned files: repository untouched. Owned: `/work/out/*` listed in `result.json`.
- Applicable instruction/skill paths and effective discovery: `/work/AGENTS.md`, `/work/ROLE.md`, `/work/packet.json`, `/repo/AGENTS.md`, `/repo/packages/connectors/AGENTS.md`, `/repo/docs/CURRENT.md`, `/repo/docs/decision-log.md` (D19), `/repo/rfcs/0002-autonomous-canon.md`, `/repo/rfcs/0000-constraints.md`, `/repo/docs/architecture.md`, `/work/.grok/skills/{orient-repository,issue-pickup-execution,connector-work,api-contract-design,handoff-work}/SKILL.md`.
- What changed and why: preparation artifacts only. Public behavior of `@kizuki/connector-x` is unchanged.
- Ownership/dependencies: R068 feeds P063 and P066. P003 evidence design, P015 source-B, P006 docs, Astra/doctor remain reserved. `kizuki.x` is not CLI-registered.

| Check | Exact command, head, runtime, time and evidence | Result |
| --- | --- | --- |
| Focused/public behavior | `bun /work/out/static-identity-scan.ts` on archive `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7`, Bun 1.3.14, 2026-09-06T22:00:37.915Z, `/work/out/static-identity-scan.json` | PASS (static map + validator matrix) |
| Existing `ids.test.ts` | `bun test /repo/packages/connector-x/test/ids.test.ts`; exit 1; `/work/out/ids-test.attempt.log` | NOT_RUN (missing `@kizuki/core`; installs forbidden) |
| Package/type/full gate | `bun run typecheck`, `bash scripts/verify.sh` | NOT_RUN (no workspace install; archive has no Git metadata for `verify.sh`) |
| Privacy/diff integrity | read-only `/work/out`; no vault, credentials, or provider calls | PASS (static) |
| Independent review | not assigned | NOT_RUN |
| Retained package/consumer | none built | NOT_RUN |

Findings first, severity ordered:

1. **Confirmed.** `packages/connector-x/src/ids.ts:3,12` `nativeId` `/^[0-9]{1,20}$/` vs `packages/connector-x/src/api/state.ts:30-33` `id` `/^[1-9][0-9]{0,18}$/`. Ordinary values `0`, `0123`, and 20-digit strings are accepted by archive and refused by API (`static-identity-scan.json` mismatches). Shared subject/record prefixes therefore do not imply a shared native validator. P063 must choose before unifying helpers.
2. **Confirmed.** API path never imports `ids.ts`. `x:user:` and `post:` are rebuilt as literals in `api/parse.ts:96-104`. Inverse `source_record_id.slice(5)` at `api/parse.ts:126,133` and `api/connector.ts:255,265,286` hard-codes prefix length `post:`.
3. **Confirmed.** Namespace selection is event `connector_id` (`map.ts:131` `kizuki.import-x-archive` vs `parse.ts:104` `kizuki.x`), not `ids.ts`. Registry/CLI enroll archive only.
4. **Confirmed.** `test/ids.test.ts` covers only `parseArchiveDate`. No existing test compares the two native regexes. Event-shape tests use IDs valid under both.
5. **Hypothesis, not required for R068.** `map.ts:131` hardcodes the archive connector id instead of `X_ARCHIVE_CONNECTOR_ID` (`connector.ts:34`). Adjacent drift risk if that constant changes.

Remaining risk, failed/interrupted checks, unavailable accounts/platforms, and next smallest action: package tests and full gate unexecuted for missing workspace install. No live X account. Next: P063 rebases and applies the checklist; do not register `kizuki.x` or rewrite origin/lineage tests.

No credentials, private records, raw provider payloads, or owner-vault paths.
