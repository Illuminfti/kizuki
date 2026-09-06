# Result R056

Outcome: FINDINGS. Scope: Gmail ordinary API transport, history-unavailable, and configuration errors mapped to user-visible recovery action. Shared Google auth is not redesigned.

- Repository: `/repo` git archive of `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7` (no Git metadata, no node_modules).
- Base = input head = `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7`. No source edits.
- Dirty/local-only: `/work/out/*` only.
- Skills: orient-repository, issue-pickup-execution, connector-work, cli-terminal-ux, test-strategy, handoff-work.

Public behavior today: `getJson` maps 403 quota reasons and 429 to `rate_limited`, other parseable 403 to `provider_error`, unparseable 403 to `source_schema`, and every other non-200 to `HttpFailure(status)`. `capture()` then prints `Gmail ${code}; check enrollment, permissions or bounded source coverage` for `KizukiError`, and `Gmail unavailable; check permissions or source coverage` for `HttpFailure`. History list 404 and message GET 404 already return honest gap details without inferring deletion.

| Check | Command / evidence | Result |
| --- | --- | --- |
| Existing Gmail error tests | `bun test --cwd /repo packages/connector-gmail/test/{http,boundaries,connector}.test.ts packages/cli/test/gmail-enrollment.test.ts` | NOT_RUN — `@kizuki/core` unresolved; see `evidence/bun-test-missing-modules.txt` |
| Local classifier replica | `bun /work/out/gmail-error-classifier.ts` | PASS — 20 fixtures, 0 mismatches, `evidence/classifier-run.json` |
| Live package import of `getJson` | blocked on workspace install | NOT_RUN |
| Provider docs | Bun fetch 2026-09-06 | PASS — `provider-docs.json` |
| Independent review / full gate | not in scope | NOT_RUN |

Findings: generic capture/CLI sentences hide timeout vs 5xx vs residual 401 vs `domainPolicy`; `HttpFailure` drops status; `loadConnector` swallows connect codes; 403 `rateLimitExceeded`/`dailyLimitExceeded`/`domainPolicy`/string-body are untested. History 404 and message 404 must stay success+gap.

Next: P051/P052 implement class-specific stderr/detail using this table without changing the one 401 refresh. Canonical docs stay P006.
