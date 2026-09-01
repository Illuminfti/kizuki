---
name: diagnose-failure
description: Diagnose a failing test, CI job, runtime path, migration, or integration in Kizuki using evidence and minimal reproductions before editing. Use when the cause is uncertain or a previous fix did not hold.
---

# Diagnose a failure

## Method

1. Run `orient-repository` and pin the exact failing head.
2. Capture the exact command, exit status, relevant stderr, environment facts,
   and whether the failure is deterministic.
3. Reduce to the smallest failing test or public invocation without changing
   production code.
4. Classify the boundary: contract, state, timing, filesystem, SQLite,
   connector, authorization, rendering, CI policy, or documentation claim.
5. Form ranked hypotheses. For each, name the observation that would support or
   falsify it.
6. Add temporary local instrumentation only at safe boundaries. Never log
   secrets, captured private text, tokens, or owner paths.
7. Test one hypothesis at a time.
8. Turn the confirmed cause into a durable regression test.
9. Apply the smallest fix, remove temporary instrumentation, and run
   `implement-change` verification from narrow to full.
10. Record cause, trigger, affected revisions, fix, proof, and remaining
   uncertainty.

## Prohibited shortcuts

Do not shotgun-edit, randomly upgrade dependencies, delete lockfiles, reset
state, increase timeouts without evidence, rerun until green, skip flaky tests,
or assume CI is wrong. Do not use an owner's real vault to reproduce a bug.
