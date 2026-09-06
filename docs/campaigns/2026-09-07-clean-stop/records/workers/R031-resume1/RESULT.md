# Result R031

Outcome: FINDINGS. Scope: read-only model of serve writer-lease expiry and clock units on frozen base `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7`; no repository edits.

- Repository/worktree/branch: `/repo` git archive (no Git metadata). Packet owner grok-R031. Write scope `/work/out` only.
- Base, input head, final head and tree: base `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7` (packet + `FLEET-SOURCE-IDENTITY.json`). Archive sha256 `187e004334b2aa998dd3ac9d29057e1725d635a00faab24d75bf092eef8b8f36`. Head/branch/dirty not observable here.
- Dirty/local-only state and owned files: only `/work/out/*` written by this lane.
- Applicable instruction/skill paths: `/work/AGENTS.md`, `/work/ROLE.md`, `/work/packet.json`, `orient-repository`, `issue-pickup-execution`, `test-strategy`, `handoff-work`; `/repo/AGENTS.md`, `packages/core/AGENTS.md`, `docs/CURRENT.md`, `docs/decision-log.md` D19, RFC 0002 §9.7 / §11.3, RFC 0000.
- What changed and why: preparation artifacts only — time-unit/transition matrix, arithmetic replica, and a non-duplicative fixed-timestamp unit-test draft.
- Ownership/dependencies: feeds P020 then P091. P003/P015/P006/Astra/external doctor reserved. No P-packet wait.

| Check | Exact command, head, runtime, time and evidence | Result |
| --- | --- | --- |
| Pure arithmetic replica | `bun /work/out/lease-expiry-arithmetic.ts` on archive base, Bun 1.3.14, 2026-09-06T22:00:11Z, exit 0, `/work/out/evidence/arithmetic.stdout.txt` | PASS |
| Existing public lease tests | `TMPDIR=/work/out/tmp bun test /repo/packages/core/test/serve/leases.test.ts`, Bun 1.3.14, exit 0, 7 pass / 0 fail, `/work/out/evidence/existing-leases.stderr.txt` | PASS |
| Draft expiry tests (characterization of HEAD) | `TMPDIR=/work/out/tmp bun test /work/out/leases-expiry.test.ts`, Bun 1.3.14, exit 0, 8 pass / 0 fail, `/work/out/evidence/draft-expiry.stderr.txt` | PASS |
| Existing `isRfc3339` tests | `bun test /repo/packages/core/test/time.test.ts`, exit 0, 29 pass, `/work/out/evidence/time.stderr.txt` | PASS |
| Package/type/full gate | `bun test` workspace / `bunx tsc --noEmit` / `bash scripts/verify.sh` | NOT_RUN (root test slot; this packet is `/work/out` only) |
| Privacy/diff integrity | no `/repo` writes; synthetic PIDs and fixed timestamps only | PASS (static) |
| Independent review | not assigned | NOT_RUN |
| Retained package/consumer | none | NOT_RUN |

Findings first, severity ordered:

1. **Medium — coverage gap vs RFC §9.7.3.** `packages/core/test/serve/leases.test.ts:84–94` is named `a dead holder's lease is reclaimed with a receipt` but uses `boot-a` → `boot-b`, so reclaim is the boot-id short-circuit (`leases.ts:106–110`), not `ageSeconds < 30`. Same-boot dead-PID 29s/30s/31s was untested until the draft. Affected invariant: dead holder past 3×heartbeat is reclaimable. Required fix (P020): land the draft cases; do not treat the existing named test as heartbeat-window proof.
2. **Low — inclusive 30s vs “older than”.** `leases.ts:112–113` reclaims when `ageSeconds >= 30`. RFC 0002 §9.7.3 “older than 3 × HEARTBEAT” and §11.3 “past 3 × heartbeat”, plus qualification `now - hb > ttl_s * 1000` (`scripts/qualification.ts:248`), leave exactly 30000 ms unstale. Draft characterizes HEAD (reclaim at 30000 ms). P020 must keep or change the boundary explicitly.
3. **Low — `ttl_s` persist-only.** Column written at `leases.ts:140,176–178`; `isBusy` ignores it. Qualification uses the row value. Default insert is 30, so they agree only while that stays true.
4. **Note — clock parsers.** Lease reclaim uses lenient `Date.parse` and does not call `isRfc3339`. Leap second `23:59:60Z` is RFC-valid (`time.ts:37–38`) and NaN under Bun 1.3.14 `Date.parse` → age 0 → busy. Qualification requires `.sssZ`. Observer `lease-stale` on a live holder is not a steal signal (`leases.test.ts:113–126` already proves live beats stale).

Remaining risk: full repository gate NOT_RUN; archive has no live git/PR; RFC inclusive-vs-strict 30s is unresolved policy for P020. Next smallest action: P020 copy `leases-expiry.test.ts` into `packages/core/test/serve/leases.test.ts` (new cases only) and decide the 30000 ms boundary before any reclaim-logic change.

No merge, deploy, qualification, or release-acceptance claim.
