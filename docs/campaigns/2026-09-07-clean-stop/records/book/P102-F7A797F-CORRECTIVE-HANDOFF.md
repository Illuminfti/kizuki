# P102 correction handoff for `f7a797f`

Start only from `f7a797f0d5bb13b5c430f2251d96567f8950b106` and make one normal follow-on commit. Keep writes limited to `.github/workflows/ci.yml`, `.github/workflows/macos-native.yml`, `scripts/verify-workflows.ts`, and `scripts/verify-workflows.test.ts`. The current workflow YAML already has the intended receipt checks and success-gated uploads; do not change artifact formats, action pins, paths, names, retention, or external systems unless a source correction is strictly required.

In `hasLinuxNativeProof`, freeze a closed ordered proof/check/retention suffix. Require the exact build/smoke/proof step and the existing unconditional exact-head diff step in their current order; require the exact receipt check to immediately precede the sole recognized `actions/upload-artifact` step; require that exact pinned/configured upload to be the final `test` job step. This must place every required verification and diff-integrity check before retention and leave no step that can change receipt state between the check and upload.

Pass the workflow document into the Linux predicate and reject workflow-level `defaults` and `jobs.test.defaults`, matching the macOS fail-closed treatment. In particular, an exact multi-line `run` value is insufficient if a default run shell can remove fail-fast behavior. Preserve the existing `test` job identity, event-head checkout, full-history, Bun pin, origin restriction, verification, native proof command, exact-head check, receipt path, `success()` condition, upload action SHA, artifact name, package path, receipt path, seven-day retention, and `if-no-files-found:error`.

Add ordinary in-memory YAML structure mutations that must fail validation:

- insert a benign run step between the receipt check and upload;
- move the exact-head check after upload;
- append a benign step after upload;
- add workflow-level run defaults;
- add `jobs.test` run defaults.

Keep all existing Linux and macOS mutations. These cases validate structure only; do not execute a deletion, upload, external action, or vulnerability reproduction.

Root's retained run `3b823c9c19144ae9a40935b15d2c0a9d` had 15 pass, 1 fail and 69 assertions. The only failure was `git ls-files` exit 128 because the sealed source archive contained no `.git`; it is separate harness context and supplies no passing-suite credit. Root will rerun using its synthetic tracked-index fixture and later run real-Git integration checks. Do not alter product code to accommodate missing test-harness Git metadata.

Return the final commit/tree, exact diff and check results. Do not claim native execution, artifact proof, upload, merge, or release acceptance.
