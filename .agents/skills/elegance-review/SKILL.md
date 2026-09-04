---
name: Elegance review
description: >-
  Use this when reviewing or shipping a code change: make the branch elegant,
  simple, and correct. No weird wiring. No needless abstractions. House default
  for all harnesses.
---
# Elegance review

House default. Load this for every implementation, refactor, PR review, and Cloud Agent task that touches code. Pair with show-me when the user needs a visual. Do not fold this into teach.

## Prompt (verbatim)

Use this prompt as the standing review bar. Paste it into the worker context; do not soften it:

> Review this branch like your life depends on it. Make it as elegant, simple, and correct as possible. No weird wiring. No needless abstractions. Pure elegance.

Source: JinjingLiang / orca_build (X). Distilled for house harnesses 4 Sep 2026.

## When to run

- Before opening a PR
- Before merging (human or auto-merge gate)
- After any Cloud Agent finishes implementation
- On every restock issue/PR worker for this repository
- Any "make this better" / polish / simplify pass

## What elegance means here

1. **Less code that still does the job.** Delete dead paths, unused knobs, and parallel APIs that do the same thing.
2. **One way in.** Prefer one dispatch / one write path / one error shape over a zoo of helpers.
3. **Honest surfaces.** Do not claim a review queue, feature, or doctor check that is not real. Prefer deleting a lie over documenting it.
4. **No needless abstractions.** No wrapper for one call. No interface until a second implementation exists. No config for a constant.
5. **No weird wiring.** Straight data flow. Side effects at the edges. Names that match reality.
6. **Correct first.** Elegance never means silent behavior change. Preserve tests and receipts; fix the design around the contract.

## How to apply

1. Diff the branch against its base (or the named scope).
2. List the smallest set of changes that raise elegance without breaking the contract.
3. Apply those changes. Prefer deletion and consolidation over new layers.
4. Re-run the project's tests / typecheck / doctor.
5. In the PR or receipt, say what you deleted or unified in one short paragraph. Not a manifesto.

## Anti-patterns (kill on sight)

- Second write path "for safety" that duplicates the first
- Fake product verbs (`review` / `promote` as queues when capture is the only door)
- Config flags that only exist to paper over a bad split
- Generics / DI / plugin hosts with a single consumer
- Comments that apologize for complexity instead of removing it

## Relationship to other skills

- **show-me**: visuals; load both when explaining a change.
- **ce-simplify-code**: optional deep multi-reviewer pass after this bar is met.
- **teach** (mattpocock): leave alone; do not overwrite.
