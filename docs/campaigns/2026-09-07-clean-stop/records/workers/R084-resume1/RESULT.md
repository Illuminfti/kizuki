# Result R084

Outcome: FINDINGS. Scope: static accounting of Screenpipe local read queries, limits, and row-to-cursor progress on base `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7`, plus a tiny in-memory row sequence. No repository edits. No live Screenpipe or owner vault.

- Repository/worktree/branch: `/repo` git archive of exact base; no Git metadata; worker lane `grok-R084`; write scope `/work/out` only
- Base, input head, final head and tree: base `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7`; archive sha256 `187e004334b2aa998dd3ac9d29057e1725d635a00faab24d75bf092eef8b8f36`; no HEAD movement
- Dirty/local-only state and owned files: repository untouched; owned outputs listed in `result.json` artifacts
- Applicable instruction/skill paths and effective discovery: `/work/AGENTS.md`, `/work/ROLE.md`, `/work/packet.json`, `orient-repository`, `issue-pickup-execution`, `connector-work`, `sqlite-data-modeling`, `test-strategy`, `handoff-work`; root `AGENTS.md`, `docs/CURRENT.md`, `docs/decision-log.md`, RFC 0002, RFC 0000, `packages/connectors/AGENTS.md`
- What changed and why: preparation artifacts only. Public read contract is unchanged.
- Ownership/dependencies: feeds P082. P003 evidence, P015 source-B, P006 docs remain reserved.

| Check | Exact command, head, runtime, time and evidence | Result |
| --- | --- | --- |
| Focused/public behavior | `cd /repo && bun test ./packages/connector-screenpipe/test/backfill.test.ts ./packages/connector-screenpipe/test/sync.test.ts ./packages/connector-screenpipe/test/cursor.test.ts ./packages/connector-screenpipe/test/p1-regressions.test.ts ./packages/connector-screenpipe/test/open.test.ts` on archive `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7`, bun 1.3.14, 2026-09-06T22:01Z | NOT_RUN as a passing suite (exit 1: missing `@kizuki/core` / no `node_modules`). Existing assertions mapped statically in `existing-coverage.md`. |
| In-memory accounting draft | `bun /work/out/row-sequence-draft.ts` bun 1.3.14, 2026-09-06T22:05:41Z, exit 0, trace `/work/out/row-sequence-trace.json` | PASS |
| Package/type/full gate | `bun run typecheck` / `bash scripts/verify.sh` | NOT_RUN (no workspace install; read-only prep; full gate not assigned) |
| Privacy/diff integrity | No source diff. Draft uses synthetic Notes App / Mic One rows. No owner DB. | PASS for this lane |
| Independent review | Not assigned | NOT_RUN |
| Retained package/consumer | None | NOT_RUN |

Findings first, severity ordered:

1. `read.ts:254-258` — `since` is max id among `iso < since`, so a later id with an earlier time seeds past in-range earlier ids. Draft: `seed_after_since=4` dropped frames 1–2. Independent expected: time predicate. Existing tests are monotonic only.
2. `walk.ts:24-32` + `connector.ts:256-267` — merge is two id-ordered heads. Settle pause on frame 3 held frame 4 (09:50) while transcription 3 (10:00:40) emitted. README claims global occurrence order.
3. `cursor.ts` skip counters vs `walk.ts:162-164` — malformed settled rows throw; skip counters never increment on the read path. Matches current README; contradicts stale wave1 spec skip-and-count.
4. `walk.ts:145` — page size 64 is an unnamed literal. Bounded, but untested as its own contract.
5. `DISTINCT_SCAN_CAP` unused in the read path.

Remaining risk: connector tests and full gate not executed in this archive. No live-account, native, or unfamiliar-user claim. Next smallest action: P082 reviews these findings and adds only the missing tiny cases (non-monotonic `since`, pause vs held earlier-time later-id across streams) after a contract choice on skip-and-count vs fail-closed.
