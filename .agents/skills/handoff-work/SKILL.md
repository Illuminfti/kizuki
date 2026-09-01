---
name: handoff-work
description: Preserve and transfer Kizuki work safely at a session boundary with exact Git and test receipts, concurrent-lane awareness, privacy-safe state, and explicit remaining blockers. Use before stopping, changing agents, or handing a branch to review.
---

# Handoff work

## Preserve

1. Re-run repository status and identify every modified, staged, untracked, and
   ignored path.
2. Separate work created by this lane from pre-existing or concurrent work.
3. Commit and push only authorized, reviewable repository content. Preserve
   local-only material and never hide it with reset, clean, or stash tricks.
4. Fetch the base and record whether the branch is current, behind, ahead, or
   conflicted.
5. Run required verification on the exact final head, or state precisely which
   commands were not run and why.
6. Check CI and review state attached to the same SHA when available.

## Handoff record

Include:

- task and intended outcome;
- repository, branch, base SHA, exact head SHA, and pull request;
- files and public contracts changed;
- commits in order;
- commands run with pass, fail, or not-run status;
- CI run and exact head association;
- privacy and security checks;
- active overlapping lanes and integration order;
- blockers, unresolved findings, and next smallest action;
- local-only or untracked material that was intentionally untouched;
- actions explicitly not taken, such as merge, deploy, release, or settings
  changes.

Do not include credentials, personal records, private endpoints, logs with
captured text, databases, or machine-specific secret paths. Do not claim an
interrupted review, unobserved CI job, or earlier-head test as current proof.
