# Result R057

Outcome: FINDINGS. Scope: Google Calendar page/sync-token cursor, batch `count`, and ordinary completed/incomplete `SyncBatch` shapes on base `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7`. No source edits.

- Repository/worktree/branch: read-only git archive `/repo` (no Git metadata). Identity `FLEET-SOURCE-IDENTITY.json` base_sha `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7`.
- Base, input head, final head and tree: base = input = archive snapshot `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7`. This lane wrote only `/work/out`.
- Dirty/local-only state and owned files: repository untouched. Owned outputs listed in `result.json`.
- Applicable instruction/skill paths and effective discovery: `/work/AGENTS.md`, `/work/ROLE.md`, `/repo/AGENTS.md`, `/repo/packages/connectors/AGENTS.md`, `/repo/docs/CURRENT.md`, `/repo/docs/decision-log.md`, RFC 0002 E11, skills `orient-repository`, `issue-pickup-execution`, `connector-work`, `test-strategy`. Remote/issue/PR state was not fetched (controller owns host git).
- What changed and why: preparation artifacts only. Public capture contract unchanged.
- Ownership/dependencies: feeds P054 and P055. Excludes P053 temporal event fidelity and P051 shared OAuth. P006 keeps canonical docs.

| Check | Exact command, head, runtime, time and evidence | Result |
| --- | --- | --- |
| Focused/public behavior | `cd /repo && TMPDIR=/work/out bun test packages/connector-google-calendar/test/bounds.test.ts --timeout 15000` on archive `f57acb3…` with Bun 1.3.14 at 2026-09-06. Stderr: Cannot find module `@kizuki/core`. 0 pass, 1 fail, 1 error. | NOT_RUN |
| Fixture runner | `cd /repo && TMPDIR=/work/out bun /work/out/run-two-page-fixture.ts` same missing module, exit 1. | NOT_RUN |
| Cursor JSON/digests | `bun /work/out/compute-cursor-json.ts` and `node:crypto` sha256 of JSON.stringify values. Exit 0. Evidence `cursor-json-computed.json`. | PASS |
| Provider docs | `bun /work/out/extract-provider-docs.ts` Bun.fetch 2026-09-06; HTTP 200 on list, sync, pagination. Curated quotes in `provider-quotes.json`. | PASS |
| Package/type/full gate | Full `bun run verify` / typecheck not run: missing workspace install, and this packet is read-only preparation. | NOT_RUN |
| Privacy/diff integrity | No repository diff. Fixture omits OAuth tokens and event bodies. Fingerprints not invented. | PASS |
| Independent review | Not assigned. | NOT_RUN |
| Retained package/consumer | None. | NOT_RUN |

Findings first, severity ordered:

1. Coverage gap (P054/P055): no existing test inspects two-page `cursor.page/sync/count` or `pending.input/request/next`. `bounds.test.ts:11-27` only checks event totals and cursor byte size. Draft fixture is `two-page-state-fixture.json`. Do not duplicate the 45-event walk.
2. Documented limitation, not a R057 code change: HTTP 410 sets `gap` and rescans without deleting ledger evidence, contrary to Google's "clear storage" wording. README already states this.
3. Stale wave1 text: `docs/wave1/specs/connector-google.md` says Google forbids sending `pageToken` with `syncToken`. Current official sync guide (2026-09-06) and `capture()` both send them together. P006 owns docs; do not "fix" the adapter to the wave1 sentence.
4. Empty intermediate pages do not persist `pending`; a crash during drain loses that progress. Bound is already tested at `validation.test.ts:28-37`.

Remaining risk: connector unit tests and the two-page runner were not executed here. Fingerprints in the fixture are marked unexecuted. No live Google account. No native/release qualification.

Next smallest action: P054 implement the missing two-page cursor/pending assertions against `CalendarFixture` on a workspace-installed checkout; rebase onto live main before production use.
