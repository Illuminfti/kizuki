# P102 native artifact retention independent review

Verdict: **NEEDS CORRECTION** for `f7a797f0d5bb13b5c430f2251d96567f8950b106`. The two workflows' current step order fixes package-only retention when proof or receipt production fails. The macOS validator freezes that order. The Linux validator still accepts structural changes that restore the original defect, so its promised enforcement is incomplete.

The reviewed commit has sole parent `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7` and tree `79b101a853a189fbb7d125cc8cc5f0f3d6cc0566`. The private P102 clone was clean: index and tracked working tree matched `HEAD`, and no untracked path was present. The complete diff changes only `.github/workflows/ci.yml`, `.github/workflows/macos-native.yml`, `scripts/verify-workflows.ts`, and `scripts/verify-workflows.test.ts`. Their SHA-256 digests are `c566b0ce54c5af19edd01aa79cd3d659230fa6d8002e850fe6d53d36009f6465`, `df4a3806b5de5fdaa8c7f105d21a771e71d6464273f8394a861c96c6ab627796`, `e3a1bb622234809c428a21380fbc19f68194d38aaebf2655ae16cff26eb97d54`, and `e63a85107a5c030770abd461cfd031fc572c13dceabada2625e59e54032eb18e`. `git diff --check` passed. The frozen P102 handoff SHA-256 is `f7aa0b342235e5fbc627f063a3461890446a1412b1494e6a2c8c13df545aba99`.

## P1: Linux validation does not preserve the receipt-to-upload boundary

The actual Linux workflow is safe at `.github/workflows/ci.yml:27-45`: build, smoke and proof run under the normal failing shell; an explicit regular-file check follows the exact-head check; the sole pinned upload immediately follows under `success()` with the exact package and receipt paths. macOS has the same protection at `.github/workflows/macos-native.yml:46-62`, and `hasMacNativeProof` requires one closed nine-step job at `scripts/verify-workflows.ts:174-195`.

Linux uses weaker ordering. `hasLinuxNativeProof` at `scripts/verify-workflows.ts:198-206` requires only `proofIndex < receiptIndex < uploadIndex`, one recognized upload action, and exact fields on that upload. It does not require the receipt check to immediately precede the upload or require the upload to be the job's final step. An added step can remove or move the checked receipt before upload; the validator still passes, `success()` remains true, and the existing package path allows the multi-path upload to retain a package without its receipt. Required verification or `ci-diff-check` can also be moved after upload: lines 92-110 verify their existence and condition, but not their precedence, so an artifact can be retained before a later exact-head failure.

The Linux validator also omits the workflow/job `defaults` rejection that macOS applies at lines 176-178. A changed default run shell without fail-fast behavior can mask a failed build or smoke command inside the exact three-line proof step, because exact `run` text alone does not define its execution semantics.

Require a closed Linux proof/check/retention suffix: the existing proof and exact-head steps in their frozen order, the exact receipt check immediately before the sole pinned upload, and that upload as the final job step after every required check. Reject workflow-level and Linux test-job run defaults. Add ordinary parsed-structure mutations for an inserted step between check/upload, a check moved after upload, a post-upload step, and workflow/job defaults. No failure-producing workflow or external action needs to run.

## Retained execution context

Root's sealed run `3b823c9c19144ae9a40935b15d2c0a9d` recorded 15 passing cases, one failure, and 69 assertions. Every executed workflow/validator fixture passed; only `validateTrackedWorkflows()` failed because the base-plus-owned-files source archive deliberately had no `.git`, so `git ls-files` exited 128. The unchanged input digests, `stale:false`, and output establish a harness-context failure rather than a candidate validator failure. It provides no full green-suite or exact-HEAD package credit. Root will separately rerun with a synthetic tracked index and later perform real-Git integration checks.

This reviewer performed static source review only and did not execute tests, actions, builds, native proof, upload, or candidate edits. Acceptance after correction still requires root's sealed focused run and exact-head integration checks. Upload success alone remains neither native proof nor release acceptance.

Receipt: `P102-F7A797F-INDEPENDENT-REVIEW.json`. Correction brief: `P102-F7A797F-CORRECTIVE-HANDOFF.md`.
