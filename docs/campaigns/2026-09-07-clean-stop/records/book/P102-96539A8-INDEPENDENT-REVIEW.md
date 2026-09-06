# P102 corrected native retention independent review

**Verdict: ACCEPT for the bounded workflow/validator correction at `96539a8a2a978ff4a1b174148098c3ecd3190309`.** No blocking findings. Static review and independent verification of root's retained test evidence were complete before the owner's clean-stop instruction. This accepts source changes for integration; it does not establish native execution, upload or release acceptance.

## Exact scope and ownership

- Clone: `PRIVATE_FLEET/code-repos/P102`.
- HEAD: `96539a8a2a978ff4a1b174148098c3ecd3190309`; tree: `6fed1a21c853b34adaf23c5849351212ec404c22`.
- Normal parent chain: corrected HEAD → `f7a797f0d5bb13b5c430f2251d96567f8950b106` → base `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7`.
- Full base-to-HEAD diff: exactly `.github/workflows/ci.yml`, `.github/workflows/macos-native.yml`, `scripts/verify-workflows.ts` and `scripts/verify-workflows.test.ts`. These match the original P102 handoff and `P102-F7A797F-CORRECTIVE-HANDOFF.md`. Worktree clean; `git diff --check` passes.
- Review covered the full diff, complete validator, actual workflow YAML and normal existing tests. The reviewer did not modify candidates, execute product tests, run workflows or perform reproductions.

## Findings and behavior

Both workflow YAML files add an exact receipt-file check and change retention from `always()` to `success()`. The pinned action SHA, repository artifact names, exact package/receipt paths, seven-day retention and `if-no-files-found: error` remain fixed. Existing checkout, origin restriction, Bun pin, verification and diff checks remain in the actual workflows.

The Linux predicate now requires the final four steps, in order, to be the exact build/smoke/proof command, unconditional exact-head diff command, exact receipt check, and pinned/configured upload. It permits only one recognized `actions/upload-artifact` step. The receipt check immediately precedes upload; upload is last. Bare commands admit only name/run fields, so their conditions, shell overrides and error-masking fields cannot alter the required suffix. Workflow-level and test-job run defaults are rejected. The macOS predicate remains a closed sequence, now nine steps, retaining its manual allowance, native host/target, platform tests, exact proof, receipt and upload obligations.

Upload validation requires the exact action and success condition plus exactly the four expected input fields. Existing global action pin, Bun version, event-head checkout, full-history, test-job identity and diff checks remain active. This is the bounded known-workflow contract described in the handoff, not a general proof about every possible workflow or external action.

Existing Linux/macOS structural mutation assertions remain. Added cases independently reject missing/changed proof, receipt and retention bindings. The corrective tests cover the five requested ordinary structure changes: insertion between receipt and upload, moving the diff check after upload, appending after upload, workflow run defaults and test-job run defaults. Tests only parse in-memory documents; they do not execute the mutated commands or upload actions.

## Retained execution and identity

Root's corrected sealed run `8b85c5ffd85c43ce9ea2e1d07208d525` executed `bun test scripts/verify-workflows.test.ts`: **16 pass, 0 fail, 74 assertions**, one file, reported test duration 69 ms. Full retained stderr was read; stdout identifies Bun 1.3.14 (`0d9b296a`). Exit 0, no termination reason, `stale: false`, confirmed cleanup, and matching observed/retained byte counts were independently checked.

The complete candidate diff equals the runner's owned overlay set. Every committed blob, current file, frozen source file and owned receipt hash agrees. Canonical before/after identities and their independently recomputed digest match: `3f0d5fc03e5ab0a55a6e51640d007329cb4c3a75434941f77b2b3d509f6e8b62`.

| Artifact | SHA-256 |
| --- | --- |
| `.github/workflows/ci.yml` (2,328 bytes) | `c566b0ce54c5af19edd01aa79cd3d659230fa6d8002e850fe6d53d36009f6465` |
| `.github/workflows/macos-native.yml` (2,737 bytes) | `df4a3806b5de5fdaa8c7f105d21a771e71d6464273f8394a861c96c6ab627796` |
| `scripts/verify-workflows.ts` (17,321 bytes) | `a6531aa35c79575415db31bcd4f61ab6219402bf2f749c5e65d90939fe2a7885` |
| `scripts/verify-workflows.test.ts` (15,545 bytes) | `be8b83a2540894ed0e9c95ba0b24ec05e3b817ee4efc239f4ad439fa487ba7ab` |
| Corrected `result.json` | `57a02c40897e45cba7e5a3c4cee02c8c7f94ae24a031553b5e3a1b91432e9f07` |
| Corrected stdout (28 bytes) | `d6684989b8dd63b37d2f1954270826fbe1bd89a8debd12bcacf03ed1c6140ef6` |
| Corrected stderr (1,444 bytes) | `314b6827a158decad00c5959b2df631cb90890dc01a0f2771c7531ce40b3ad64` |

Evidence remains under `PRIVATE_FLEET/test-controller/runs/8b85c5ffd85c43ce9ea2e1d07208d525/`. The fixed `aca1b9d024834903f414fcbb90e096ec406152e8b08177bb00f4b991cc811eef` image used no network and read-only source/dependency mounts.

This receipt explicitly uses root's synthetic workflow index. Its recorded index SHA-256, independently matched to the retained bytes, is `2b3d1d95a8eef59c3edb9715467dcb7fd970c6ca27ec4c1f562ba5249a13c580`. An independent read of the index lists exactly `ci.yml`, `macos-native.yml` and `workflows.yml` under `.github/workflows`; all three frozen files match the candidate's committed blobs and supplemental hashes. This supplies workflow enumeration only, with no HEAD commit or package credit. Real-Git integration and full repository/type checks remain separate.

Original run `3b823c9c19144ae9a40935b15d2c0a9d` remains **15 pass, 1 fail, 69 assertions**, exit 1, at `f7a797f0d5bb13b5c430f2251d96567f8950b106`. Its full retained log confirms the sole failure was tracked workflow enumeration returning exit 128. Independently rehashed result: `9547bf8d3ebdafb81b2edfb43bbdb1fe02de88af666fe3f082816f78efaf7b9f`; stderr: `a9a4fd2ff0a700b6c65aa7303ab76635538f4a5a3ee94f5c7fb2b8294fd00574`. The corrected receipt does not rewrite that failure.
