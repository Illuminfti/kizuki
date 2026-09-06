# Result R054

Outcome: FINDINGS. Scope: current `kizuki.gmail-cursor/v1` history/page-token representation and JSON round-trip, using ordinary provider-shaped identifier strings; no OAuth redesign, no mailbox calls, no repository edits.

- Repository/worktree/branch: read-only git archive at `/repo` (no Git metadata). Packet owner `grok-R054`. Write scope `/work/out` only.
- Base, input head, final head and tree: base `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7`; archive sha256 `187e004334b2aa998dd3ac9d29057e1725d635a00faab24d75bf092eef8b8f36`; no HEAD movement; `/repo` unchanged.
- Dirty/local-only state and owned files: `/repo` not writable; outputs only under `/work/out`.
- Applicable instruction/skill paths and effective discovery: `/work/AGENTS.md`, `/work/ROLE.md`, `/work/packet.json`, `/repo/AGENTS.md`, `/repo/docs/CURRENT.md`, `/repo/docs/decision-log.md` D19, `/repo/rfcs/0002-autonomous-canon.md` (binding, not restated), `/repo/packages/connectors/AGENTS.md`, skills `orient-repository`, `issue-pickup-execution`, `connector-work`, `test-strategy`, `handoff-work`. GitHub issue 545 was not re-fetched (no `gh`, archive has no remotes).
- What changed and why: inspection artifacts only. Cursor remains compact JSON with decimal-string `anchor` and printable-ASCII `page`. Precision depends on keeping those fields strings and comparing history with `BigInt`.
- Ownership/dependencies: feeds P051 and P052. Shared OAuth, registry, lockfiles, P003 evidence design, P006 docs, P015 source-B remain with their owners. No production use without review/rebase.

| Check | Exact command, head, runtime, time and evidence | Result |
| --- | --- | --- |
| Focused/public behavior | `bun /work/out/gmail-cursor-roundtrip.ts` on base `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7`, Bun 1.3.14, 2026-09-06T22:02:03.424Z, `/work/out/roundtrip-report.json` (`failed: 0`, 32 cases, source sha256 `4646e58bfd10aa51cd00ec8bf92e183d92cd63b3effb5646161a158979727535`) | PASS |
| Existing package tests | `cd /repo && bun test packages/connector-gmail/test/boundaries.test.ts packages/connector-gmail/test/connector.test.ts packages/connector-gmail/test/live-retry.test.ts` | NOT_RUN (exit 1: `Cannot find module '@kizuki/core'`; `/repo/node_modules` absent; not a passing result) |
| Package/type/full gate | `bun test` / `bunx tsc --noEmit` / `bash scripts/verify.sh` | NOT_RUN (workspace install forbidden; archive has no `node_modules`) |
| Privacy/diff integrity | Synthetic fixtures only; no credentials, vault paths, or provider payloads; `/repo` unmodified | PASS |
| Independent review | Not assigned; no source diff | NOT_RUN |
| Retained package/consumer | No package built | NOT_RUN |
| Provider docs | Bun fetch 2026-09-06 of Gmail discovery `revision=20260903` and listed developers.google.com pages | PASS (public docs only) |

Findings first, severity ordered:

1. **Coverage hole (confirmed).** `packages/connector-gmail/test/boundaries.test.ts:117-122` proves message `metadata.history_id` stays a 21-digit string. It does not round-trip cursor `anchor`. Fixture profile history is `"100"`. There is no in-tree `encodeCursor`/`decodeCursor` unit test. Do not duplicate the metadata test.
2. **Local historyId ≠ Google uint64 (confirmed).** `state.ts:64-68` `^[1-9][0-9]{0,39}$` refuses `"0"` (valid uint64) and accepts 21–40 digit strings and `2^64` (`18446744073709551616`). Production compares with `BigInt` (`connector.ts:278,292`), so accepted strings do not lose IEEE precision; the bound is simply not the provider type.
3. **Empty `nextPageToken` is not null (confirmed).** `pageToken("")` throws `source_schema`. Discovery omits a maxLength; Gmail docs describe absence of `nextPageToken`, not empty string.
4. **JSON number history is fail-closed (confirmed, desirable).** Unquoted JSON integers above 2^53−1 already lose bits in `JSON.parse`; the codec refuses `typeof !== "string"` instead of coercing.

Hypotheses (not confirmed here): whether live Gmail ever emits historyId `0` or an empty page token; whether any host re-pretty-prints the opaque cursor (would break `encodeCursor(plan.next) === input` at `connector.ts:317`).

Remaining risk, failed/interrupted checks, unavailable accounts/platforms, and next smallest action: no live Gmail account; no workspace install so in-tree tests and full gate are NOT_RUN; GitHub issue/PR state not live-verified. Next: P051/P052 consume `/work/out/fixtures/gmail-cursor-neutral.json` and decide whether to tighten `historyId()` to uint64 or keep the 1–40 digit local bound; if they add a test, use the pure codec fixtures, not a clone of `boundaries.test.ts:117-122`.

Do not infer integrated, released, live-account tested, or unfamiliar-user accepted. No credentials or owner-vault paths.
