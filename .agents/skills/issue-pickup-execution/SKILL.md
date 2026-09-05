---
name: Issue pickup execution
description: >-
  Use when an agent is assigned a GitHub issue or work packet and must turn it
  into a bounded, reviewable implementation with exact-head receipts.
---
# Issue pickup execution

A ticket is a contract boundary, not permission to redesign the repository around the worker.

## Pickup

Before editing:

1. Read root and nearest `AGENTS.md`.
2. Read current binding product law and RFCs.
3. Read the parent epic/architecture issue and all stated dependencies.
4. Verify dependencies are merged on the actual base.
5. Inspect open PRs and recent commits touching the same contracts/files.
6. State the exact acceptance proof from the ticket in your own words.
7. List the public seams and files you expect to touch.

If the dependency graph is not satisfied, do not fake progress by implementing against a speculative shape.

## Scope discipline

- One issue, one coherent lane, one PR unless the issue explicitly says otherwise.
- Fix neighboring defects only when they block acceptance and are clearly documented.
- Do not absorb another ticket because its code is nearby.
- Do not create public placeholders for later tickets.
- Do not refactor unrelated code “while here.”

## Implementation pattern

Prefer:

```text
acceptance example
→ failing/characterization test
→ contract
→ core behavior
→ adapters/projections
→ adversarial tests
→ docs
→ exact-head verification
```

For a defect, reproduce first. For a new capability, prove the public seam first.

## Self-review before PR

Review the diff under five lenses:

1. **Spec**: does it satisfy every acceptance clause?
2. **Architecture**: did it reuse the intended seam and avoid a second truth path?
3. **Safety**: retries, partial failure, permissions, purge, captured input, migration.
4. **Experience**: did UX, DX, or AX regress?
5. **Elegance**: what can be deleted, unified, or named more clearly?

## Receipts

A completion comment or PR body must include:

- base SHA;
- exact head SHA;
- changed contracts/schemas;
- focused tests;
- package tests;
- typecheck/full verify as applicable;
- security/performance checks required by the ticket;
- remaining uncertainty;
- intentionally untouched dependent work.

Never write “all tests pass” without naming the exact commands or CI checks that support it.

## Handoff

If interrupted, preserve the branch and leave a factual state:

- committed vs uncommitted work;
- last verified SHA;
- failing test or next concrete step;
- unresolved dependency;
- files currently owned by the lane.

The next agent should be able to resume without reverse-engineering your thoughts.