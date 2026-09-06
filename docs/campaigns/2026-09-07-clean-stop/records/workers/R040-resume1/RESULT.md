# Result R040

Outcome: FINDINGS (prepared baseline; CLI process unexecuted). Scope: current-main `kizuki doctor` exit/output/health map for SHA `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7` only. Not the lmvdz fork. No repository edits.

- Repository/worktree/branch: read-only git archive `/repo`; no Git metadata; identity `FLEET-SOURCE-IDENTITY.json`
- Base, input head, final head and tree: base = `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7`; no worker commits
- Dirty/local-only state and owned files: `/work/out/**` only
- Applicable instruction/skill paths: `/work/AGENTS.md`, `/work/ROLE.md`, orient-repository, issue-pickup-execution, test-strategy; binding `docs/CURRENT.md`, RFC 0002 D12 doctor-off-when-no-model
- What changed and why: preparation artifacts — truth table, JSON/human shape, expected fixtures, coverage map
- Ownership/dependencies: P006 owns docs; Astra/external doctor reserved; this feeds P039 and P040; P038 fork is out of scope

| Check | Exact command, head, runtime, time and evidence | Result |
| --- | --- | --- |
| Focused/public behavior | `bun /work/out/capture-doctor-baseline.ts` on archive; stderr `Cannot find module '@kizuki/tui'` | NOT_RUN (doctor never entered) |
| Core doctor units | `cd /repo && bun test packages/core/test/serve/doctor.test.ts packages/core/test/ledger-health.test.ts packages/core/test/sqlite-runtime.test.ts packages/core/test/page-provenance.test.ts` Bun 1.3.14; log `/work/out/test-logs/core-doctor-default-tmp.txt` | PASS |
| CLI package tests | `bun test packages/cli/test/doctor/*.ts …` | NOT_RUN (workspace graph missing) |
| Package/type/full gate | `bun run verify` | NOT_RUN |
| Privacy/diff integrity | static: provenance tests forbid evidence text in diagnostics; no /repo writes | PASS (static) |
| Independent review | not assigned | NOT_RUN |
| Retained package/consumer | none | NOT_RUN |

Findings first:

1. **Execution blocker (this container).** Git archive has no `node_modules`. CLI cannot start. Not a doctor health failure.
2. **Docs vs code (characterization).** `docs/cli.md:231` usage is `kizuki doctor [--json]`; code usage is `doctor [--json] [--integrity]`. Docs mention `canon writing: on\|off` only; code has `unverified`. P006 owns docs.
3. **Envelope `degraded` vs serve failures.** `degraded` is `problems[].error` only. Supervisor/rail/model failures can yield exit 1 with empty `degraded`.
4. **Identity authority line does not fail.** `identity-authority-unavailable` is always in `stores.degraded` and printed; it is not a `serve.failure`. Confirmed by executed core test `packages/core/test/serve/doctor.test.ts:52-57`.

Remaining risk: expected human/JSON fixtures are reconstructed from source and existing test assertions, not live CLI stdout. Re-run `/work/out/capture-doctor-baseline.ts` after `bun install` on this SHA before treating fixtures as process-captured. Next smallest action: P039/P040 consume `/work/out/command-health-truth-table.md` and `/work/out/command-health-matrix.json` for fork comparison; do not wait on this lane to install dependencies.
