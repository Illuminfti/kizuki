# Result R077

Outcome: FINDINGS. Scope: mapped `kizuki.ics` file versus URL mode configuration and limits on base `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7`; no source edits; no live calendar fetches.

- Repository/worktree/branch: `/repo` git archive of exact base; no Git metadata; remote not verified here
- Base, input head, final head and tree: base_sha `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7`; no commits
- Dirty/local-only state and owned files: write scope `/work/out` only
- Applicable instruction/skill paths: `/work/AGENTS.md`, `/work/ROLE.md`, `/work/packet.json`, orient-repository, issue-pickup-execution, connector-work, test-strategy
- What changed and why: preparation artifacts only (mode map, fixtures, coverage inventory)
- Ownership/dependencies: feeds P076; does not take P006 docs, shared registry, or P075 event mapping

| Check | Exact command, head, runtime, time and evidence | Result |
| --- | --- | --- |
| Focused/public behavior | `bun /work/out/checks/static-source-check.ts` and `bun /work/out/checks/fixture-check.ts` on archive `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7`, Bun 1.3.14, 2026-09-06 | PASS |
| Package/type/full gate | `cd /repo && bun test packages/connector-ics/test/fetch.test.ts …` | NOT_RUN (missing `@kizuki/core`; no install) |
| Privacy/diff integrity | no source diff; fixtures contain only synthetic acme.example data | PASS |
| Independent review | not assigned | NOT_RUN |
| Retained package/consumer | not a release packet | NOT_RUN |

Findings first: CLI does not enroll ICS URL mode while the connector implements it; catalog labels ICS as a local source; file reads have no 16 MiB stream cap; `credentials: "omit"` is untested. See `ics-mode-config-limit-map.md`.

Remaining risk: package tests were not executed in this container. Next smallest action is P076 consuming this map without advertising CLI URL enrollment or duplicating P075 semantics.
