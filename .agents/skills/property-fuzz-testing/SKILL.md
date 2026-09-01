---
name: property-fuzz-testing
description: Design property-based, generative, metamorphic, or fuzz tests for parsers, contracts, state machines, migrations, serialization, and hostile inputs. Use when example tests leave a large input or state space uncovered.
---

# Property and fuzz testing

1. Identify invariants rather than generating random examples blindly.
2. Define generators for valid, boundary, malformed, adversarial, duplicate, reordered, truncated, oversized, and Unicode/control-sequence inputs.
3. Prefer properties such as round-trip stability, idempotency, determinism, monotonicity, rollback equivalence, canonical serialization, bounded output, and reject-without-side-effects.
4. For state machines generate operation sequences including retries, interruption, revoke, purge, stale handles, and restart.
5. Use deterministic seeds and preserve the smallest failing counterexample as a regression fixture.
6. Bound runtime, allocations, recursion, archive expansion, and generated case size.
7. Never fuzz an owner's real vault, credentials, provider account, or network endpoint.
8. Keep fuzzing complementary to explicit public-seam acceptance tests.

A green random run is not proof. Report seed, property, case budget, shrink result, and exact head.
