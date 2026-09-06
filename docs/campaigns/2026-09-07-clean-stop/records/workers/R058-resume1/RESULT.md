# Result R058

Outcome: FINDINGS. Scope: mapped current Google Calendar ID/time-window/limit arguments to events.list query construction; drafted a pure request-construction fixture with neutral calendar IDs.

- Repository/worktree/branch: read-only git archive at `/repo`; no Git metadata; assigned write scope `/work/out` only
- Base, input head, final head and tree: base `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7` (FLEET-SOURCE-IDENTITY.json); no checkout mutation
- Dirty/local-only state and owned files: repository untouched; artifacts only under `/work/out`
- Applicable instruction/skill paths and effective discovery: `/work/AGENTS.md`, `/work/ROLE.md`, `/work/packet.json`, `/repo/AGENTS.md`, `/repo/packages/connectors/AGENTS.md`, `/repo/packages/cli/AGENTS.md`, `/repo/docs/CURRENT.md`, orient-repository, issue-pickup-execution, connector-work, api-contract-design, test-strategy, handoff-work
- What changed and why: preparation map and fixture; no public product behavior changed
- Ownership/dependencies: feeds P054/P055; P003/P015/P006 and registry/lockfiles remain their owners

| Check | Exact command, head, runtime, time and evidence | Result |
| --- | --- | --- |
| Focused/public behavior | `bun /work/out/calendar-request-construction.fixture.ts` on archive base `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7`, Bun 1.3.14, 2026-09-06T22:01:58.602Z, exit 0, 10 passed / 0 failed, `/work/out/calendar-request-construction.results.json` | PASS |
| Package/type/full gate | repository `bun test` / `bunx tsc --noEmit` / `bash scripts/verify.sh` | NOT_RUN (no node_modules in this archive container; not authorized to install) |
| Privacy/diff integrity | static review; fixture uses only `fixture-calendar`, `owner.calendar@example.com`, `en.usa#holiday@group.v.calendar.google.com`; no credentials or owner data | PASS |
| Independent review | not assigned | NOT_RUN |
| Retained package/consumer | no package built | NOT_RUN |

Findings first, severity ordered:

1. Coverage gap (confirmed, static): no in-tree test asserts the full events.list query (`maxResults=20`, `singleEvents=false`, `showDeleted=true`, `maxAttendees=64`, encoded calendar path, absence of `timeMin`/`timeMax`/`orderBy`/`q`). Related tests exist at `packages/connector-google-calendar/test/bounds.test.ts:11-27,71-83` and `packages/cli/test/google-calendar-enrollment.test.ts:159-163` but they are not this case. Required for P054/P055: land the fixture against the public capture URL seam without duplicating those tests.
2. Synthetic harness limitation (confirmed, static): `packages/connector-google-calendar/src/testing.ts:26` compares `url.pathname` to an unencoded calendar id. Encoded `@`/`#` IDs used by production `encodeURIComponent` would fail that equality. Downstream tests should decode the path or compare `href`.
3. Stale wave1 shape (confirmed, static): `docs/wave1/specs/connector-google.md:290-292` still describes `singleEvents=true` and optional `q`. Current `connector.ts:306` sends `singleEvents=false` and never `q`.

Remaining risk: in-tree connector tests were not executed here. Live Google account qualification remains unrun, as on this revision. No CLI time-window exists; that is current contract, not an implementation hole.

Next smallest action: P054/P055 consume `/work/out/calendar-argument-to-query-map.json` and the executed fixture, and add the missing public-seam URL assertions on a writable checkout.
