# Result R093

Outcome: FINDINGS. Scope: Linux systemd user-service identity and an unexecuted isolated-account observation script for install/start/stop/restart/no-service/uninstall with vault preservation.

- Repository/worktree/branch: read-only git archive `/repo`; no Git metadata; FLEET-SOURCE-IDENTITY base `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7`
- Base, input head, final head and tree: base_sha `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7`; archive_sha256 `187e004334b2aa998dd3ac9d29057e1725d635a00faab24d75bf092eef8b8f36`; no source edits
- Dirty/local-only state and owned files: only `/work/out/*` written
- Applicable instruction/skill paths: `/work/AGENTS.md`, `/repo/AGENTS.md`, `docs/CURRENT.md`, `docs/decision-log.md` D15/D19, RFC 0002 §11.1, `docs/service-lifecycle.md`, skills orient-repository, issue-pickup-execution, reliability-engineering, release-readiness
- What changed and why: preparation artifacts only; no product contract change
- Ownership/dependencies: feeds P091; P006 docs, P003 evidence, native packaging remain reserved

| Check | Exact command, head, runtime, time and evidence | Result |
| --- | --- | --- |
| Focused unit/supervisor/doctor | `bun test packages/core/test/serve/units.test.ts packages/core/test/serve/service-arguments.test.ts scripts/native-platform.test.ts` then `bun test packages/core/test/serve/supervisor.test.ts packages/core/test/serve/doctor.test.ts` at base `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7`, Bun 1.3.14, 2026-09-06 | PASS (6+21 pass; 1 darwin skip) |
| CLI fakeSystemd install tests | `bun test packages/cli/test/serve/install.test.ts` | NOT_RUN (no node_modules; install forbidden) |
| Native systemd script | `observe-linux-systemd-lifecycle.sh` | NOT_RUN / unexecuted (no systemctl, no user systemd, no dist package; packet forbids operating systemd) |
| Package/type/full gate | `bun run verify` / typecheck | NOT_RUN (preparation packet; no source change; no test slot) |
| Privacy/diff integrity | no repo diff | N/A |
| Independent review | not assigned | NOT_RUN |
| Retained package/consumer | no native package in archive | NOT_RUN |

Findings first: after `kizuki serve stop`, systemd `Restart=on-failure` leaves the unit enabled and inactive. Source maps that to `state=disabled` with `enabled=true`, which is neither `confirmedActive` nor `confirmedStopped`, so both `--install` and `--uninstall` refuse (`packages/core/src/serve/supervisor.ts`). Static trace only; native result unobserved.

Remaining risk: native start/stop/restart/uninstall and vault preservation are unproven on a real user manager. Next smallest action: P091 runs `/work/out/observe-linux-systemd-lifecycle.sh` on a disposable Linux x64 user with a frozen stable-path native package.

No merge, deploy, release, linger, or owner-vault action taken.
