---
name: test-strategy
description: Build or review a Kizuki testing strategy that proves behavior at public seams with deterministic fixtures, focused unit tests, integration tests, failure-path coverage, and exact-head gates. Use when adding features, repairing regressions, or improving weak coverage.
---

# Test strategy

## Build the test pyramid from contracts

1. Run `orient-repository`.
2. List the user-visible or caller-visible behaviors that must remain true.
3. Identify the cheapest deterministic seam that can prove each behavior.
4. Prefer unit tests for pure logic, integration tests for boundaries, and end-to-end tests for public workflows.
5. Keep fixtures synthetic, minimal, deterministic, and privacy-safe.

## Required dimensions

Test more than the happy path. Consider:

- invalid, missing, duplicate, stale, and adversarial input;
- exact boundary values and empty state;
- idempotency, retries, ordering, and concurrency;
- transaction rollback, interrupted writes, restart, and recovery;
- authorization denial and sensitivity filtering;
- purge, supersession, provenance, and rebuild equivalence;
- malformed files, paths, archives, and serialized state;
- bounded behavior under large but realistic input;
- compatibility with earlier supported state or callers.

Use characterization tests before risky refactors. For bugs, prove the
regression fails before the fix when practical.

## Quality rules

Do not mock the behavior under test. Mock only uncontrollable boundaries.
Avoid sleeps, random data without a fixed seed, real network calls, owner data,
and assertions that duplicate implementation details.

A test suite is useful only if failures explain which contract broke. Name tests
for behavior and expected outcome.
