# Result R096

Outcome: PREPARED. Scope: local-only hash/architecture/required-file checker draft for already-supplied synthetic archives; no repository source edits.

- Repository/worktree/branch: `/repo` git archive of `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7`; no Git metadata; remote not verified in this container.
- Base, input head, final head and tree: base `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7`; archive sha256 `187e004334b2aa998dd3ac9d29057e1725d635a00faab24d75bf092eef8b8f36`; no product HEAD movement.
- Dirty/local-only state and owned files: repository untouched; owned outputs only under `/work/out`.
- Applicable instruction/skill paths and effective discovery: `/work/AGENTS.md`, `/work/ROLE.md`, `/work/packet.json`, `orient-repository`, `issue-pickup-execution`, `release-readiness`, `test-strategy`, `handoff-work`; binding `docs/CURRENT.md`, `docs/decision-log.md` D19, `rfcs/0002-autonomous-canon.md`.
- What changed and why: added a runnable draft that hashes a supplied tar.gz, checks the closed linux/x64 and darwin/arm64 registry, extracts ustar members, and verifies required files plus inner SHA256SUMS. Current tree already covers directory packages; this draft does not duplicate those tests.
- Ownership/dependencies: feeds P094 and P100. P003/P015/P006/Astra remain reserved. `scripts/release-artifacts.ts` stays the directory checksum helper.

| Check | Exact command, head, runtime, time and evidence | Result |
| --- | --- | --- |
| Focused/public behavior | `bun /work/out/verify-local-archive.ts --run-matrix /work/out/fixtures --work /work/outTEMP/matrix` at 2026-09-06T22:05:22Z, bun 1.3.14 linux/x64, base `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7`; per-case CLI exits 0/1/1/1/1/0 and usage 2 at 22:05:33Z. Existing `bun test scripts/release-artifacts.test.ts scripts/release-targets.test.ts` 5 pass / 0 fail. | PASS |
| Package/type/full gate | `bun run verify` | NOT_RUN (read-only prep; no source change) |
| Privacy/diff integrity | Synthetic never-executed fixtures; no private records; repository unmodified | PASS |
| Independent review | C2 independent-model lens not assigned | NOT_RUN |
| Retained package/consumer | No native product package built or executed | NOT_RUN |

Findings first, severity ordered: info — current native package is a checksummed directory (`scripts/release-artifacts.ts:35-50`, `docs/native-build.md:16-26`); the archive hash/extract seam is absent and is the draft, not a production defect. Wave1 `scripts/release/` and `install.sh` are unimplemented on this base.

Remaining risk: draft is not an installer, not a download path, and not release acceptance. Host-match was only run on linux/x64. Darwin/arm64 was inspected offline (`06-offline-foreign-target`, exit 0) without claiming macOS execution. Full gate, independent review, native compiled binaries, live accounts, and unfamiliar-user proof were not run.

Next smallest action: P094/P100 consume `/work/out/verify-local-archive.ts` after review/rebase; do not replace the directory checksum helper.

Exact filenames: `/work/out/verify-local-archive.ts`, `/work/out/fixtures/matrix.json`, `/work/out/expected-behavior.md`, `/work/out/coverage-map.json`, `/work/out/source-references.json`, `/work/out/execution-receipt.json`, `/work/out/RESULT.md`, `/work/out/result.json`.
