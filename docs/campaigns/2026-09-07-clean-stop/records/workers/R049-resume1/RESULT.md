# Result R049

Outcome: FINDINGS (preparation complete; no source edits). Scope: MCP advertised input field names/types/defaults vs serving `*Args` on base `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7`.

- Repository/worktree/branch: read-only git archive at `/repo`; no Git metadata; identity from `FLEET-SOURCE-IDENTITY.json`
- Base, input head, final head and tree: `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7` (archive SHA-256 `187e004334b2aa998dd3ac9d29057e1725d635a00faab24d75bf092eef8b8f36`). Head did not move. No source edits.
- Dirty/local-only state and owned files: only `/work/out/**`
- Applicable instruction/skill paths and effective discovery: `/work/AGENTS.md`, `/work/ROLE.md`, `/work/packet.json`, `orient-repository`, `issue-pickup-execution`, `mcp-tool-design`, `api-contract-design`, `test-strategy`, `handoff-work`; binding `docs/CURRENT.md`, `docs/decision-log.md`, RFC 0002; scoped `packages/mcp/AGENTS.md`
- What changed and why: no public behavior change. Produced a schema-field join and a pure contract fixture for ordinary valid and missing-required arguments.
- Ownership/dependencies: P003 evidence design, P015 source-B, P006 docs remain reserved. Feeds P037 and P046.

| Check | Exact command, head, runtime, time and evidence | Result |
| --- | --- | --- |
| Focused/public behavior | `bun /work/out/scripts/verify-schema-field-join.ts` at base `f57acb3` Bun 1.3.14 2026-09-06T22:04:44Z `/work/out/checks/schema-field-join-verify.json` | PASS (exit 0) |
| Zod schema draft | `bun test /work/out/fixtures/mcp-serving-input-contract.test.ts` Bun 1.3.14 2026-09-06T22:04:48Z exit 1: missing `@kizuki/core` / no `node_modules` | NOT_RUN |
| Existing MCP/core tests | not executed; needles statically present in cited files | NOT_RUN |
| Package/type/full gate | not in scope; no source change; no test slot | NOT_RUN |
| Privacy/diff integrity | no vault, credentials, or source edits | PASS (static) |
| Independent review | not assigned | NOT_RUN |
| Retained package/consumer | none | NOT_RUN |

Findings first, severity ordered:

1. **schema_optional_engine_required** — `get_page` id/path XOR (`packages/mcp/src/schemas.ts:68-71` vs `packages/core/src/serving/page.ts:24-28`). Engine already tested.
2. **schema_optional_engine_required** — `correct.target` optional in MCP (`schemas.ts:149`), required by `resolve()` (`packages/core/src/serving/target.ts:57-59`). Engine and MCP already tested.
3. **coverage_gap** — advertised-schema missing `search.query`, `graph_neighbors.id`, `propose.kind|body|provenance`, `correct.statement` have no existing test. Drafted, not executed.
4. **observation** — engine defaults are not advertised (`z.default()` absent). Do not add defaults without reviewing `auditArguments`.
5. **schema_looser_than_engine** — MCP `ID`/RFC3339/`min(1)` vs identifier/calendar/`text()` blank rules. Ordinary examples align.

Remaining risk: zod draft unexecuted until `bun install` in a writable worktree. Next smallest action: P037/P046 consume the join; if adding a test, only `draft_new_test` `safeParse` cases.

No merge, deploy, release, or docs claim.
