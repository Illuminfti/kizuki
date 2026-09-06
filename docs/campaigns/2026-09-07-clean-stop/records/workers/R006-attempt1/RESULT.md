# Result R006

Outcome: PREPARED. Scope: check-run conclusion normalization oracle and exact-head applicability fixture for `candidate.required-checks`, with no release PASS grant.

- Repository/worktree/branch: `/repo` git archive of `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7`; no Git metadata; remote state not verified in this container
- Base, input head, final head and tree: base `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7`; no source edits; archive SHA-256 `187e004334b2aa998dd3ac9d29057e1725d635a00faab24d75bf092eef8b8f36`
- Dirty/local-only state and owned files: repository untouched; outputs only under `/work/out`
- Applicable instruction/skill paths and effective discovery: `/work/AGENTS.md`, `/work/ROLE.md`, `/work/packet.json`, orient-repository, issue-pickup-execution, test-strategy, elegance-review; `docs/CURRENT.md`, `docs/decision-log.md`, `docs/release-acceptance.md`
- What changed and why: added a pure I/O fixture and adapter sketch that maps GitHub check observations to named states and exact-head applicability without inventing a passing receipt
- Ownership/dependencies: feeds P005 and P097; does not take P002, P003, P006, or P015

| Check | Exact command, head, runtime, time and evidence | Result |
| --- | --- | --- |
| Focused/public behavior | `bun /work/out/check-conclusion-adapter.ts` on archive base `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7`, Bun 1.3.14, evidence `/work/out/oracle-execution.json` (34 observation + 11 aggregate cases, `failed: 0`, `release_credit: false`) | PASS |
| Package/type/full gate | `bun run verify` / `bun test scripts/go-no-go.test.ts` | NOT_RUN (Git absent; read-only archive; packet is `/work/out` only) |
| Privacy/diff integrity | no repository diff; synthetic SHAs only | PASS (no private data in outputs) |
| Independent review | not assigned | NOT_RUN |
| Retained package/consumer | none; oracle grants no artifact credit | NOT_RUN |

Findings first, severity ordered: `scripts/go-no-go.test.ts` never mentions `candidate.required-checks` (static probe, empty line hits). That is a coverage gap for the stub, not a failing runtime. No conclusion-normalizer test existed; this packet adds the fixture instead of duplicating YAML/checkout tests.

Remaining risk: GitHub check `name` may be the job name (`test`) rather than `ci / test`; the adapter refuses to guess. A future producer must compose identity from workflow plus job. `bun run verify` was not run. No live Checks API snapshot was fetched.

Next smallest action: P005 consumes `/work/out/check-conclusion-oracle.fixture.json` and `/work/out/check-conclusion-adapter.ts` as the normalizer contract and keeps `candidate.required-checks` `NOT_IMPLEMENTED` until a trusted exact-head producer exists.
