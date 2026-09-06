# Result R069

Outcome: FINDINGS. Scope: current-code join of Markdown selected-folder CLI/app inputs and source consent into `MarkdownFolderConfig`; no repository edits.

- Repository/worktree/branch: `/repo` git archive of `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7` (no Git metadata; remote not verified here)
- Base, input head, final head and tree: base `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7`; no checkout mutation
- Dirty/local-only state and owned files: `/work/out` only
- Applicable instruction/skill paths and effective discovery: `/work/AGENTS.md`, `/work/ROLE.md`, `/work/packet.json`, `orient-repository`, `issue-pickup-execution`, `connector-work`, `test-strategy`, `handoff-work`; `/repo/AGENTS.md`, `packages/cli/AGENTS.md`, `packages/connectors/AGENTS.md`, `docs/CURRENT.md`
- What changed and why: preparation artifacts mapping `--source PATH` / app `path` to host `{ path }`, grant policy to capture admission, and constructor-only `page_size`/`exclude`
- Ownership/dependencies: feeds P068 and P083; do not take HostConnectionState, source-grant schema, lockfiles, or P006 docs

| Check | Exact command, head, runtime, time and evidence | Result |
| --- | --- | --- |
| Focused/public behavior | `bun /work/out/validate-fixtures.ts` on archive `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7`; Bun 1.3.14; receipt `/work/out/validate-fixtures.receipt.json`; exit 0; 22 local rule checks | PASS |
| Package/type/full gate | `bun test` / `bunx tsc --noEmit` / `bash scripts/verify.sh` | NOT_RUN (no workspace `node_modules`; `/repo` read-only; no installs) |
| Privacy/diff integrity | static read of assigned sources; synthetic notes only under `/work/out/fixtures/notes` | PASS |
| Independent review | not assigned | NOT_RUN |
| Retained package/consumer | none | NOT_RUN |

Findings first, severity ordered:

1. CLI/app persist only `config.path`. `MarkdownFolderConfig.page_size` and `exclude` exist on the constructor (`packages/connectors/src/markdown-folder/index.ts:52-58`) but `encodeHostState` keeps `{ path }` (`packages/cli/src/connections.ts:52-53`) and `decodeHostState` refuses extra keys (`connections.ts:113-124`).
2. Markdown `loadConnector` does not join catalog `required_fields` to `grant.allowed_fields` before opening the folder (`connections.ts:443-446`). Gmail/Calendar do. Capture denial for omitted `text` already exists (`packages/cli/test/source-consent.test.ts:116-126`).
3. App markdown enroll persists path without a health-check (`packages/cli/src/app/host.ts:276-286`); CLI `connect` constructs and health-checks first (`connect.ts:290-304`). Missing-directory CLI refusal already exists (`packages/cli/test/connect.test.ts:55-73`).

Remaining risk: existing CLI/connector tests were statically inventoried, not executed. Workspace import of `@kizuki/core` failed (`Cannot find module '@kizuki/core'`). Draft `draft-host-state-path-only.test.ts` is unexecuted. Next smallest action: P068 implement against this join without expanding shared host-state or grant schema unless assigned; rebase before production use.

Do not infer integrated, released, live-account tested, unfamiliar-user accepted, or elapsed observation from another row.
