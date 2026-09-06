# Result R043

Outcome: FINDINGS. Scope: current local-app `AppProtocol` kinds joined to `createAppHost` dispatch and serialized result fields on frozen base `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7`.

- Repository/worktree/branch: `/repo` git archive of exact base; no Git metadata. Packet owner grok-R043, write scope `/work/out` only.
- Base, input head, final head and tree: `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7` (FLEET-SOURCE-IDENTITY.json). No source edits.
- Dirty/local-only state and owned files: only `/work/out/*` written.
- Applicable instruction/skill paths: `/work/AGENTS.md`, `/repo/AGENTS.md`, `/repo/packages/cli/AGENTS.md`, `/repo/docs/CURRENT.md`, `/repo/docs/decision-log.md`, `/repo/rfcs/0002-autonomous-canon.md`, `/repo/docs/local-app.md`, skills orient-repository, issue-pickup-execution, api-contract-design, test-strategy, handoff-work.
- What changed and why: preparation artifacts only. Map of 15 request kinds, compile-time adapter draft, coverage inventory. No protocol or host edit.
- Ownership/dependencies: feeds P041 and P043. Does not replace P044, P006 docs, P003 evidence, or app source.

| Check | Exact command, head, runtime, time and evidence | Result |
| --- | --- | --- |
| Focused/public behavior | `bun /work/out/static-join-check.ts` on base `f57acb3` Bun 1.3.14; `/work/out/static-join-check.json` | PASS |
| Adapter load | `bun -e 'await import("/work/out/compile-time-adapter.draft.ts")'` | PASS (parse only) |
| Adapter tsc | `tsc --noEmit` | NOT_RUN (no TypeScript binary; no install) |
| Existing app tests | `bun test packages/cli/test/app-host.test.ts` (and service/client) | NOT_RUN (temp vaults); statically verified in coverage-inventory.json |
| Package/type/full gate | `bunx tsc --noEmit` / `bash scripts/verify.sh` | NOT_RUN |
| Privacy/diff integrity | no source diff; no credentials; synthetic names only | PASS |
| Independent review | not assigned | NOT_RUN |
| Retained package/consumer | none | NOT_RUN |

Findings first, severity ordered:

1. `packages/cli/src/app/host.ts:93-332` — `execute` is an if-chain returning `Promise<unknown>` with fallback `invalid_request`. `ROUTES` is exhaustive for keys; execute is not. A new `AppProtocol` key can compile after updating `ROUTES` and still miss a handler.
2. `packages/cli/src/app/host.ts:50-55` plus `packages/core/src/ledger/source-grants.ts:413` — `source_purge_pending` (and `invalid_source_policy`) are not in the host allowlist, so they serialize as `unavailable`.
3. `packages/cli/src/app/protocol.ts:11` — `APP_API_PREFIX` is unused; host/client/http hardcode `/app/v1/`.
4. Coverage holes (not duplicate of existing journeys): host `catalog` payload, `enroll` google-calendar, `capture` mode `sync`, `query` withheld/degraded, `undo` cascade true.

Remaining risk: adapter TypeScript never-check is unexecuted without `tsc`. Existing behavioral tests were not re-run. Next smallest action: P041 fold `ROUTE_KEYS` + `never` into `host.ts` execute without adding a second dispatcher; add only the uncovered host cases if proof is required. No merge, docs, or app edit from this packet.
