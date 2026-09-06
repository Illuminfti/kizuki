# Result R095

Outcome: PREPARED. Scope: current CLI/MCP native package is a five-file directory per closed target, with a pure listing validator draft. No source edits, no compile, no release claim.

- Repository/worktree/branch: read-only git archive `/repo` (no Git metadata)
- Base, input head, final head and tree: `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7` (unchanged)
- Dirty/local-only state and owned files: only `/work/out/**`; repository untouched
- Applicable instruction/skill paths and effective discovery: `/work/AGENTS.md`, `/work/ROLE.md`, orient-repository, issue-pickup-execution, release-readiness, test-strategy, handoff-work; `/repo/docs/CURRENT.md`, decision-log D19, RFC 0002 binding
- What changed and why: mapped `scripts/build-release.ts` output into `native-package-expected-manifest.json` and a listing-only validator. Did not duplicate checksum tests or R045 app assets.
- Ownership/dependencies: feeds P094 and P093; P006 owns docs if LICENSE policy changes

| Check | Exact command, head, runtime, time and evidence | Result |
| --- | --- | --- |
| Focused/public behavior | `bun test /work/out/archive-listing-validator.test.ts` (bun 1.3.14, 2026-09-06T22:06:15Z, 9 pass); CLI exit 0/1/2; `check-logs/local-checks.clean.txt` | PASS |
| Existing unit coverage | `bun test /repo/scripts/release-targets.test.ts` and `release-artifacts.test.ts` on archive SHA `f57acb3…` | PASS |
| Package/type/full gate | `bun run verify` | NOT_RUN |
| Native compile/smoke | `bun run build:release` forbidden in this packet | NOT_RUN |
| Privacy/diff integrity | no repository diff | NOT_RUN |
| Independent review | not assigned | NOT_RUN |
| Retained package/consumer | no compiled package retained | NOT_RUN |

Findings first, severity ordered: listing exclusivity is untested in smoke/proof (`scripts/smoke-release.ts:18-24`, `scripts/stranger-proof.ts:148-149`) — extra names currently pass those presence checks; draft extra-file fixture exits 1. LICENSE is absent from the current producer; not added to the expected tree.

Remaining risk: no compiled bytes inspected; macOS native receipt still required for support claims; artifacts must be reviewed/rebased before production use. Next smallest action: P094 add listing exclusivity beside existing checksum tests.

Do not infer integrated, released, live-account tested, or unfamiliar-user accepted from this row.
