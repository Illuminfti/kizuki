# Full-suite harness planning: stopped before execution

Status: **INCOMPLETE STATIC PLAN; NO TEST RUN OR QUALIFICATION.** Saved on the user's clean-stop instruction. This lane launched no containers or product tests, created no full-suite clone, changed no integration source, and changed no controller code. No process was left running by this lane.

The requested scope was a root-reviewed, offline full Bun suite with read-only root and source, the existing 18 dependency mounts, genuine Git metadata, no host credentials or home mounts, a 1,200-second deadline, a 64 MiB output bound, and participation in the existing global four-test-slot controller. Root retained ownership of execution and was running leaf tests separately.

## Verified before stop

- Integration source: `WORKTREES/kizuki-grok-integration-20260906`.
- HEAD: `3dfefd2810cec850b110343ea2973928a0b0a823`.
- Tree: `adb4c4e13eec9f0e3a11567798962d4f8cee7a2e`.
- Branch: `refs/heads/agent/kizuki-grok-integration-20260906`.
- `git status --short` produced no entries.
- The book's existing `grok_fleet_test_runner.py` exposes `Config`, `dependencies`, `acquire_slot`, `capture_container`, `remove_container`, and receipt helpers. It was inspected but not modified.
- `safe.Config()` uses dependency source `WORKTREES/kizuki-fleet-base-20260906` and requires 18 mounts: root `node_modules` plus sorted `packages/*/node_modules`. The function rejects a different count and walks each dependency directory without following symlink components. This planning lane did not enumerate or independently revalidate the current 18 paths.
- `acquire_slot(control)` uses four nonblocking file locks in `control/slots`; it skips slots with `.active` or `.blocked` markers and raises `all_test_slots_busy` if none is usable. A full-suite invocation must use the same control directory `PRIVATE_FLEET/test-controller`, consume one slot, and preserve unknown cleanup states. It must not create a separate four-slot pool.
- `capture_container(..., deadline=1200, log_limit=...)` supports the requested deadline. Its limit is **per output stream**, not combined. Use `32 * 1024 * 1024` per stream for a strict combined maximum of 64 MiB retained stdout and stderr; passing 64 MiB permits 128 MiB combined. Confirm the intended interpretation before finalizing the receipt contract.
- Existing capture removes only its uniquely named container, bounds removal, reports termination reasons and cleanup confirmation, and does not classify timeout, log overflow, or cleanup failure as a passed run. An eventual wrapper must own the corresponding active/blocked markers and persist receipts using the established controller lifecycle; this lane did not finish reviewing that lifecycle.

## Proposed source isolation, not performed

A plain archive loses genuine Git metadata. Mounting the integration worktree together with its shared parent Git directory can expose unrelated or held refs and source, so it is unsuitable for this scope. Creating a new synthetic Git commit cannot preserve the required real HEAD SHA.

The candidate approach is a fresh, independent, single-branch, depth-one, no-tags clone of the reviewed integration branch through Git's `file://` transport with `--no-local`. Its ordinary `.git` directory can preserve the real selected commit SHA without mounting the shared worktree Git directory. This has **not** been created or validated here. Before adopting it, root must establish whether full-suite Git-aware tests require only current tracked files/HEAD or also ancestors/tags, inspect resulting refs and objects, prove no alternates or shared object hardlinks, remove unnecessary remote/config information from the isolated metadata without changing HEAD, and verify exact tracked bytes, modes, tree, and SHA. Do not fake history or lower an assertion to make a shallow clone pass.

Only a verified independent clone, its own read-only Git metadata, and the pinned dependency directories should be visible to the container. The original integration worktree and shared parent Git directory should not be mounted. Recheck the source SHA/tree before producing a run receipt; a later integration HEAD requires a separately reviewed identity.

## Proposed container shape, not a ready-to-run command

Preserve the established constraints: `--pull=never`, a unique owned name, `--network=none`, `--read-only`, `--cap-drop=ALL`, `--security-opt=no-new-privileges`, `--user 1000:1000`, explicit PID/memory/CPU bounds, a bounded executable `/tmp` tmpfs with mode 1777, read-only isolated source at `/repo`, read-only 18 dependency mounts at matching `/repo` paths, and workdir `/repo`. Pass no host environment wholesale, credentials, host home, Docker socket, or additional filesystem mounts. The requested test command is `bun test` over the whole repository, subject to completing the static tooling/fixture review below. This lane has not selected final resource sizing for the full suite.

The existing default image is `sha256:aca1b9d024834903f414fcbb90e096ec406152e8b08177bb00f4b991cc811eef`. Root reported it lacks a native C compiler. The proposed older trusted image is `sha256:59cef0f85ea477b70c4d6428d4a986d4fced461012f46a745fa15d19a523b56f`; prior book receipts mention it, but this lane has **not** inspected its current image configuration, tool inventory, or suitability for all full-suite tests. Do not infer successful native compilation or full-suite compatibility from this plan.

## Remaining work if explicitly resumed

1. Inspect prior full-suite receipts and the existing controller's complete active-marker/receipt lifecycle. Candidate book documents found include `FLEET-F57ACB3-INTEGRATION-RECEIPT.md`, `MAIN327-INTEGRATION-CHECKPOINT.md`, and `ISSUE56-1A23863-FULL-VERIFY-RECONCILIATION.md`.
2. Statically inventory full-suite Git metadata/history requirements, native tooling, child process executables, synthetic fixture behavior, writes, and skip conditions. No such complete inventory was finished.
3. Verify the selected pinned image and exact 18 dependency mounts with root's existing authority and evidence. Prepare a concrete reviewed command/config and controller wrapper only after these checks.
4. At root's chosen integration SHA, prepare and verify the isolated genuine clone only if root resumes and approves that approach. Then execute through the existing global slot pool, bounded capture, and receipt lifecycle.

This document is the only new file created for this stopped harness-planning task. It contains no test result, launch authorization, release claim, or recommendation to bypass a failing test.
