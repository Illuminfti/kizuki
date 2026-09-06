# Result R094

Outcome: FINDINGS (prepared draft; native launchd unexecuted). Scope: extract current launchd label/plist/domain assumptions and produce an isolated Darwin arm64 observation script plus schema for P092. No repository edits. No release or native qualification claim.

- Repository/worktree/branch: frozen `/repo` git archive of `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7` (FLEET-SOURCE-IDENTITY.json). No Git metadata. Remote/issue/PR not refreshed.
- Base, input head, final head and tree: base `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7`; this lane wrote only `/work/out`.
- Dirty/local-only state and owned files: `/work/out/*` listed in result.json artifacts.
- Applicable instruction/skill paths and effective discovery: `/work/AGENTS.md`, `/work/ROLE.md`, `/work/packet.json`, orient-repository, issue-pickup-execution, reliability-engineering, release-readiness, handoff-work; binding CURRENT / decision-log / RFC0002 / RFC0000.
- What changed and why: preparation artifacts for launchd lifecycle observation; existing systemd fakes and plist-render tests were not duplicated.
- Ownership/dependencies: feeds P092. P006 docs, P003 evidence design, Astra/doctor owners untouched.

| Check | Exact command, head, runtime, time and evidence | Result |
| --- | --- | --- |
| Focused/public behavior | `OUT=/work/out bash /work/out/macos-launchd-lifecycle.sh` on Linux x86_64 Bun 1.3.14 at 2026-09-06T22:00:37Z host probe; expected exit 78 | see `/work/out/launchd-observation.json` after the local run |
| Package/type/full gate | `bun test` / typecheck / `scripts/verify.sh` | NOT_RUN (`/repo/node_modules` absent; no installs) |
| Privacy/diff integrity | no repo diff; synthetic ordinary note only | PASS for this lane |
| Independent review | not assigned | NOT_RUN |
| Retained package/consumer | no native `bun-darwin-arm64` package in this container | NOT_RUN |

Findings first, severity ordered: coverage gap that real launchd install/bootout is untested; untested parser concern that substring `disabled` precedes `state = running`; launchctl(1) warns `print` is not a production API. Confirmed on this host: Darwin/launchctl/plutil/KIZUKI_BIN missing.

Remaining risk: P092 must run the script on macos-15 arm64 with `KIZUKI_BIN` from the native package and a working `gui/<uid>` session. Do not promote Linux or plist-render results.

Do not infer integrated, released, live-account tested, unfamiliar-user accepted, or elapsed observation from another row.
