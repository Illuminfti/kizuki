# Result R053

Outcome: FINDINGS. Scope: ordinary Telegram sign-in / cancel / unavailable CLI diagnostic handoff on base `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7`; mapping table and unexecuted fixture draft only; no `/repo` edits.

- Repository/worktree/branch: read-only git archive `/repo`; no Git metadata; remote not verified; `vps-nav` not run (container adaptation).
- Base, input head, final head and tree: base `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7`; no product HEAD movement; worker writes only under `/work/out`.
- Dirty/local-only state and owned files: `/repo` untouched. Owned: mapping table, fixture draft, static verifier receipt.
- Applicable instruction/skill paths and effective discovery: `/work/AGENTS.md`, `/work/ROLE.md`, `/repo/AGENTS.md`, `/repo/packages/cli/AGENTS.md`, `/repo/docs/CURRENT.md`, `/repo/docs/decision-log.md` D19, skills orient-repository, issue-pickup-execution, connector-work, cli-terminal-ux, test-strategy, handoff-work.
- What changed and why: preparation artifacts mapping current `telegramFailure` / `telegramSignInIo` / process exit codes to user-visible classes `sign_in`, `cancel`, `unavailable`.
- Ownership/dependencies: feeds P048 and P049. P003, P015, P006, Astra, doctor remain reserved.

| Check | Exact command, head, runtime, time and evidence | Result |
| --- | --- | --- |
| Focused/public behavior | `bun /work/out/verify-mapping.ts` at 2026-09-06T22:04:33.238Z, Bun 1.3.14, base `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7`, receipt `/work/out/verify-mapping.receipt.json` | PASS (static source match, 19 snippets, 25 table rows) |
| Fixture bun:test | `bun test /work/out/telegram-signin-diagnostics.fixture.ts`; missing `@kizuki/connector-telegram`; `/work/out/fixture-execution.receipt.json` | NOT_RUN |
| Existing CLI tests | `bun test packages/cli/test/connect.test.ts` / `telegram-enrollment.test.ts`; no `/repo/node_modules` | NOT_RUN (statically read) |
| Package/type/full gate | not in scope; no source change | NOT_RUN |
| Privacy/diff integrity | static read only; fixture uses synthetic strings, no phone/session/provider payloads | PASS (review of artifacts) |
| Independent review | not assigned | NOT_RUN |
| Retained package/consumer | none | NOT_RUN |

Findings first, severity ordered:

1. `packages/cli/src/commands/connect-telegram.ts:67` wraps every enroll error in `telegramFailure`. Ctrl-C is `UsageError("interactive sign-in cancelled")` (`main.ts:76`) then becomes `ConnectionError` “did not complete” (`connect-telegram.ts:40`), process exit 1 not 2. Independent expected class: **cancel**. IMAP preserves `UsageError`.
2. `flood_wait` without positive `retry_after` (`connect-telegram.ts:29-38`) uses connectivity copy, losing the wait class.
3. `sign_in_aborted` (`connect-telegram.ts:32`) collapses owner abandon, refused credentials, and unoccupied-number abort (`client.ts:254-262`) into one cancel sentence.
4. Inner `ConnectionError` values such as `Telegram state is missing` (`connect-telegram.ts:62`) are rewritten to generic incomplete.
5. `closed` / `missing_session` / `parse_error` / `unreachable` share the connectivity sentence.

Remaining risk: fixture and repository tests were not executed against the live helpers. No live Telegram account, no native binary, no qualification claim. Next smallest action: P048 land the mapping test at `packages/cli/test/telegram-signin-diagnostics.test.ts` and decide whether cancel preserves `UsageError` like IMAP.
