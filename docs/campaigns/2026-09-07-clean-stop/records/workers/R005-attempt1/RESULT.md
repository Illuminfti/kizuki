# Result R005

Outcome: FINDINGS. Scope: read-only audit of CI package naming, upload, retention, and retrieval binding on archive `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7`.

- Repository/worktree/branch: read-only git archive at `/repo` (no `.git`). Packet owner `grok-R005`. Write scope `/work/out` only.
- Base, input head, final head and tree: base `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7`; archive sha256 `187e004334b2aa998dd3ac9d29057e1725d635a00faab24d75bf092eef8b8f36`. No head movement. Remote refs not verified here.
- Dirty/local-only state and owned files: repository untouched. Owned outputs are under `/work/out`.
- Applicable instruction/skill paths and effective discovery: `/work/AGENTS.md`, `/work/ROLE.md`, `/work/packet.json`, `orient-repository`, `issue-pickup-execution`, `test-strategy`, `handoff-work`; binding `docs/CURRENT.md`, `docs/decision-log.md`, RFC 0002/0000, `docs/architecture.md`.
- What changed and why: no repository change. Produced a workflow artifact graph with exact step/field references and an offline download-listing checker with synthetic fixtures.
- Ownership/dependencies: P003 evidence design, P015 source-B, P006 docs, Astra/doctor remain reserved. This feeds P005 and P094.

| Check | Exact command, head, runtime, time and evidence | Result |
| --- | --- | --- |
| Focused/public behavior | `bun test /work/out/check-download-listing.test.ts` on Bun 1.3.14 at 2026-09-06T21:45:22Z; 12 pass / 0 fail | PASS |
| Checker CLI | complete listing exit 0; missing receipt exit 1; checksum mismatch exit 1; bad args/schema exit 2 | PASS |
| Existing checksum tests | `bun test scripts/release-artifacts.test.ts` (3 pass) and `scripts/release-targets.test.ts` (2 pass) from `/repo` | PASS |
| Workflow text (no git ls-files) | `validateWorkflowText` on `ci.yml`, `macos-native.yml`, `workflows.yml` plus `validateToolchain` | PASS |
| `validateTrackedWorkflows` / `bun run ci:workflows` | `git ls-files` in this archive exits 128 (`tracked workflow producer exited 128`) | NOT_RUN as a gate; producer unavailable |
| Full `bun run verify` / native package / live download | Git metadata, live GitHub, and native compile all out of this container’s authority | NOT_RUN |
| Privacy/diff integrity | no repo edits; synthetic fixture text only; no credentials | PASS |
| Independent review | not assigned | NOT_RUN |
| Retained package/consumer | no live CI artifact downloaded | NOT_RUN |

Findings first, severity ordered:

1. **Linux upload fields are unpinned.** `scripts/verify-workflows.ts` pins macOS `upload-artifact` name/path/retention/receipt (`hasMacNativeProof`, lines 153-157) and tests removal (`verify-workflows.test.ts:226-228`). The Linux `ci.yml:34-43` name `linux-x64-${{ github.event.pull_request.head.sha || github.sha }}`, glob `dist/kizuki-*/bun-linux-x64-baseline/`, receipt path, `retention-days: 7`, and `if-no-files-found: error` are not asserted. A Linux retention or receipt-path regression would still pass `validateWorkflowText`.
2. **Receipt is not independently required at upload time.** `if-no-files-found: error` fails only when no path matches. A package without `receipt.json` can still upload. Proof identity is then missing; `BUILD.json` + `SHA256SUMS` still bind source SHA.
3. **Zip layout is not a closed local contract.** upload-artifact@ea165f8d flattens after the first wildcard and uses the LCA of multiple paths. Linux/macOS mix a workspace glob with `${{ runner.temp }}/…/receipt.json`. No live download was observed. Bind by basename.
4. **Action outputs are discarded.** Pinned action.yml exposes `artifact-id`, `artifact-url`, `artifact-digest`. Neither upload step has `id:`, so the zip digest is not retained.
5. **macOS artifact name uses `github.sha` only.** Linux uses the event-head expression. Equal on `workflow_dispatch` because `ci-diff-check.ts:48-50` requires HEAD == `GITHUB_SHA`. `inputs.base_sha` is not in the artifact name.
6. **Execute bits are lost** (documented 644). Hashes remain; `chmod +x` is operator-side.
7. **No `actions/download-artifact` step exists.** Retrieval is operator-side and expires after 7 days; `cancel-in-progress: true` can drop in-flight uploads.

These are confirmed from current source plus fetched action docs. They are not live-CI observations.

Remaining risk: no live artifact was downloaded, so zip nesting is hypothesized from docs and covered by the LCA fixture, not by a real run. Native compile was not executed (`scripts/build-release.ts` requires Git). Full repository gate was not run. Next smallest action: P005/P094 consume the graph and checker; pin Linux upload fields in `verify-workflows.ts` if that lane owns CI YAML.

No merge, deploy, publication, GitHub contact, or auth retest.
