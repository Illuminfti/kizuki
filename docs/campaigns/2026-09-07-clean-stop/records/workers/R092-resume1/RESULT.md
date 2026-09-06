# Result R092

Outcome: FINDINGS. Scope: read-only install-to-doctor recovery transcript adapter on frozen base `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7`; no repository edits.

- Repository/worktree/branch: `/repo` git archive of exact base (no Git metadata; `FLEET-SOURCE-IDENTITY.json`). Remote/host state not verified here (controller-owned).
- Base, input head, final head and tree: base `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7`; archive sha256 `187e004334b2aa998dd3ac9d29057e1725d635a00faab24d75bf092eef8b8f36`; no checkout mutation.
- Dirty/local-only state and owned files: `/work/out/*` only.
- Applicable instruction/skill paths and effective discovery: `/work/AGENTS.md`, `/work/ROLE.md`, `/work/packet.json`, `orient-repository`, `issue-pickup-execution`, `cli-terminal-ux`, `release-readiness`, `test-strategy`, `handoff-work`; repo `docs/CURRENT.md`, `docs/decision-log.md`, RFC 0002, `docs/cli.md`, `docs/service-lifecycle.md`, `packages/cli/AGENTS.md`.
- What changed and why: mapped public `init`, `--no-service`, stopped-daemon reads, and `doctor` into a two-section script plus health-state map. Did not add CLI tests: piecewise coverage already exists.
- Ownership/dependencies: P003 evidence design, P015 source-B schema/recovery, P006 docs, Astra/external doctor owners remain reserved. Feeds P090 and P099 after review/rebase. No native/account/model/human qualification claim.

| Check | Exact command, head, runtime, time and evidence | Result |
| --- | --- | --- |
| Focused/public behavior | `bun /repo/packages/cli/src/main.ts help` on 2026-09-06T21:48:05Z, Bun 1.3.14, base `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7` | NOT_RUN (Cannot find module `@kizuki/tui`; no `node_modules`; install forbidden) |
| Safe rehearsal script | `sh /work/out/install-to-doctor-recovery.sh rehearsal` writing `/work/out/rehearsal/` | UNEXECUTED CLI steps labeled; adapter ran |
| Native section | default `KIZUKI_ALLOW_NATIVE_SERVICE` unset; no `dist/`; no `systemctl` | UNEXECUTED (missing binary, supervisor, authorization) |
| Package/type/full gate | not in scope; no source edits | NOT_RUN |
| Privacy/diff integrity | no vault/owner data; synthetic paths only under `/work/out` | PASS (static) |
| Independent review | not assigned | NOT_RUN |
| Retained package/consumer | no native package in archive | NOT_RUN |

Findings first, severity ordered: no confirmed product defect. Limitation: local CLI rehearsal cannot run without workspace dependencies. Limitation: native install-to-doctor is red until rails emit receipts (`packages/cli/test/serve/install.test.ts:43-49`); a green doctor immediately after install would be a false expectation. Existing tests already pin `--no-service`, opted-out doctor, canon-writing-off, supervisor-none init hint, and `serve stop` when not running.

Remaining risk, failed/interrupted checks, unavailable accounts/platforms, and next smallest action: P090/P099 should execute the rehearsal section on a tree with `bun install --frozen-lockfile` already present, keep native behind an explicit service-allow flag on a Linux x64 user systemd session, and must not treat this packet as qualification or release evidence.

Do not infer integrated, released, live-account tested, unfamiliar-user accepted, or elapsed observation from another row.
