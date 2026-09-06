# Result R065

Outcome: FINDINGS. Scope: current X API connector rate-window and page-budget numeric fields, how they constrain progress reporting, plus a pure calculation fixture. No source edits, no live provider calls.

- Repository/worktree/branch: read-only git archive `/repo` (no Git metadata). Packet owner `grok-R065`. Write scope `/work/out` only.
- Base, input head, final head and tree: `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7` (FLEET-SOURCE-IDENTITY.json). No checkout mutation.
- Dirty/local-only state and owned files: `/work/out/*` only.
- Applicable instruction/skill paths and effective discovery: `/work/AGENTS.md`, `/work/ROLE.md`, `/repo/AGENTS.md`, `/repo/packages/connectors/AGENTS.md`, `/repo/docs/CURRENT.md`, `/repo/docs/decision-log.md` D19, `rfcs/0002-autonomous-canon.md`, skills `orient-repository`, `issue-pickup-execution`, `connector-work`, `test-strategy`, `handoff-work`. Remote/host `vps-nav` not run (controller forbids it in this container).
- What changed and why: preparation artifacts only. Current GET 429 math, unused `x-rate-limit-limit`/`remaining`, 64-page walk budget, 5-request operation budget, and progress text that does not print remaining/reset.
- Ownership/dependencies: feeds P063, P064. Shared registry, connector interface, lockfiles, P003/P006/P015, Astra, and doctor owners untouched.

| Check | Exact command, head, runtime, time and evidence | Result |
| --- | --- | --- |
| Focused/public behavior | `bun /work/out/rate-window-fixture.ts` on 2026-09-06T22:03:20Z, Bun 1.3.14, base `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7`, report `/work/out/rate-window-fixture-report.json` | PASS (20/20 pure cases, exit 0) |
| Package/type/full gate | `bun test packages/connector-x/test` / `bun run typecheck` / `bash scripts/verify.sh` | NOT_RUN — `/repo` has no `node_modules`; installs forbidden |
| Existing in-repo rate tests | static read of `client.test.ts`, `rate-revoke.test.ts`, `capture.test.ts`, `parse.test.ts` | NOT_RUN (static). Retry-after, token-429, 64-page, request-limit cases already exist; `x-rate-limit-reset` does not |
| Privacy/diff integrity | no repo diff; synthetic headers only; no credentials | PASS (scope) |
| Independent review | not assigned | NOT_RUN |
| Retained package/consumer | none | NOT_RUN |
| Public docs | Bun fetch 2026-09-06 of `https://docs.x.com/x-api/fundamentals/rate-limits.md`, `.../pagination.md`, `.../users/get-posts.md` | PASS (HTTP 200; markdown) |

Findings first, severity ordered:

1. **Untested implemented path.** `client.ts:42-43` reads `x-rate-limit-reset` on GET 429 when `retry-after` is absent. No test under `packages/connector-x/test` mentions that header. Testkit 429 always sends `retry-after` (`testkit.ts:42`). Affected invariant: GET 429 cooldown. Required follow-up: add the seven `proposed_new` fixture rows to `client.test.ts` without duplicating retry-after cases.
2. **Malformed `retry-after` shadows a valid reset.** `retrySeconds` L34-40 returns 60 without consulting L42. Independently expected from the source; not asserted. Official rate-limits.md (2026-09-06) does not mention `Retry-After` and tells callers to wait on `x-rate-limit-reset`.
3. **Past reset clamps to 1s.** `bounded(reset - floor(now/1000))` with floor 1. Official sample wait is `max(..., 60)`. Local 24h ceiling (`X_API_RETRY_SECONDS = 86400`) is documented in `API.md` L135-140.
4. **`x-rate-limit-limit` and `x-rate-limit-remaining` are never read.** Official docs (2026-09-06) expose them on every response. Wave1 spec wanted remaining `0` on 200 to pause; current code does not. Progress text cannot report remaining. Do not add a remaining-0 pause test against current behavior.
5. **Progress reporting is binary, not numeric.** `coverageDetail` (`connector.ts:11-12`) is `available window drained` vs `continuation pending`. Health detail is static coverage. `retry_at` is durable but not copied into `SyncBatch.detail`. Page budget (`pages` 0..64, `max_results=100`, 5 requests / 45s) is local, separate from the provider 15-minute window.

Hypotheses, not confirmed: whether live X still sends `Retry-After` on 429; whether enrolled apps see the documented 900/15min user-posts table. Live qualification is out of scope.

Remaining risk: in-repo tests and full gate NOT_RUN. Fixture is a characterization replica, not the production `retrySeconds` function (that function is unexported; importing `client.ts` needs `@kizuki/core` / `node_modules`). No native/account/model/human qualification. Next smallest action: P063/P064 consume `/work/out/unit-type-count-table.md` and the `proposed_new` rows; land reset-header tests on the exported `request()` seam.
