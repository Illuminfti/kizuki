# Result R073

Outcome: FINDINGS. Scope: current `kizuki.import-claude` entry recognition, ordinary structural exclusions, and parse-count bounds on base `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7`, with P071 content/role/quote fidelity left unchanged.

- Repository/worktree/branch: read-only git archive `/repo`; no Git metadata. Packet owner `grok-R073`. Write scope `/work/out` only.
- Base, input head, final head and tree: base `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7` (`FLEET-SOURCE-IDENTITY.json`). No source edits. No commit.
- Dirty/local-only state and owned files: `/work/out/**` only. Repository unchanged.
- Applicable instruction/skill paths and effective discovery: `/work/AGENTS.md`, `/work/ROLE.md`, `/work/packet.json`, `orient-repository`, `issue-pickup-execution`, `connector-work`, `test-strategy`, `/repo/AGENTS.md`, `/repo/packages/connectors/AGENTS.md`, `/repo/docs/CURRENT.md`. `vps-nav` / live GitHub / host git not run (controller certificate).
- What changed and why: preparation artifacts only — inventory table, tiny fixtures, coverage map, provider-doc extract, unexecuted verify script.
- Ownership/dependencies: feeds P072. P071 fidelity must be preserved. P006 owns docs (README tombstone sentence mismatch). P003/P015/Astra untouched.

| Check | Exact command, head, runtime, time and evidence | Result |
| --- | --- | --- |
| Focused/public behavior | `bun /work/out/verify-claude-fixtures.ts` after fixture JSON parse; import of `/repo/packages/connectors/src/import-claude/index.ts` | Fixture JSON: pass. Parser: NOT_RUN (missing workspace `node_modules`; install forbidden) |
| Package/type/full gate | `cd /repo && bun test packages/connectors/test/claude.test.ts packages/connectors/test/source-id.test.ts packages/connectors/test/util.test.ts` (Bun 1.3.14) | NOT_RUN / command fail-to-load: `Cannot find module '@kizuki/core'` and `@kizuki/connector-beeper`. Not a test assertion failure. Full `bun run verify` not run. |
| Privacy/diff integrity | Static: fixtures are synthetic; no owner data; no credentials | PASS (static) |
| Independent review | Not assigned | NOT_RUN |
| Retained package/consumer | N/A — no package built | NOT_RUN |

Findings first, severity ordered:

1. `MAX_RECORD_BYTES` (1 MiB) is documented as applying to every snapshot parser (`util.ts` 62–69) but is not applied by `parseClaudeExport`. A single message can exceed the event contract (`EVENT_LIMITS.textBytes` 1_048_576) and fail only at ledger accept.
2. `MAX_RECORDS` (1_000_000) counts **conversations**, not messages. One conversation may carry an unbounded `chat_messages` array.
3. Official Anthropic export article (2026-09-06) does not publish a `conversations.json` schema. Recognition keys are in-tree only.
4. Claude tests omit several diagnostics already proven for ChatGPT (`invalid_timestamp`, `duplicate_id`, `conflicting_id`) and omit `missing_messages` / `malformed_messages` / `malformed_content` / content-block image-document / quote join.
5. README still says snapshot importers never emit tombstones; Claude manifest `tombstones: true` and tests emit them.

Remaining risk: parser expected-results are static traces, not executed. Next smallest action: P072 implements only the missing Claude cases from `coverage-map.md`, keeps fixture 01–02 fidelity, and uses tiny `maxRecords` stand-ins rather than huge files.

No live-account, native, or release-acceptance claim.
