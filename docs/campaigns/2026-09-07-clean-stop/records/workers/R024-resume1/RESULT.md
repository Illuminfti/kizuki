# Result R024

Outcome: PREPARED. Scope: mapped one ordinary `kizuki tell --claim` correction through parse, native evidence, and epoch update, with before/after public-read fixtures.

- Repository/worktree/branch: `/repo` git archive of `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7`; no Git metadata; remote not verified
- Base, input head, final head and tree: base `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7`; no source edits
- Dirty/local-only state and owned files: only `/work/out/*`
- Applicable instruction/skill paths: `orient-repository`, `issue-pickup-execution`, `test-strategy`; RFC 0002 §6, D14
- What changed and why: preparation artifacts only; no production contract change
- Ownership/dependencies: feeds P022 and P084; P003 keeps shared evidence; P015 keeps source-B authority

| Check | Exact command, head, runtime, time and evidence | Result |
| --- | --- | --- |
| Focused/public behavior | `cd /repo && bun test packages/core/test/correction/correct.test.ts` (Bun 1.3.14, 10 pass / 0 fail) | PASS |
| Local parse/epoch/correct seam | `bun /work/out/generate-fixtures.ts` stored 0→1, computed 0→2 | PASS |
| Package/type/full gate | not assigned; node_modules absent | NOT_RUN |
| Privacy/diff integrity | no source diff | NOT_RUN |
| Independent review | not assigned | NOT_RUN |
| Retained package/consumer | not assigned | NOT_RUN |

Findings first: stored `getClaimsEpoch` and packet `claimsEpoch` are different numbers on this revision (1 vs 2 after one ordinary correction). CLI `correct()` bumps the stored counter; MCP `serveCorrect` does not. Packet staleness uses the computed count. CLI vs MCP also differ in `target_json`, event `kind`, and parse (`objectFromStatement` vs explicit `object`). Confirmed from source and the local seam; not redesigned here.

Remaining risk: packet.test.ts, tell.test.ts, source-consent.test.ts, and `bun run verify` were NOT_RUN (missing `js-tiktoken` / workspace install). Next smallest action: P022/P084 consume the sequence and matrix without duplicating `correct.test.ts:71-127`.
