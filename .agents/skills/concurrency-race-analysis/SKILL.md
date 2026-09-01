---
name: concurrency-race-analysis
description: Analyze and test Kizuki code for races, stale state, interleavings, duplicate work, lock hazards, and cross-process filesystem or SQLite concurrency. Use whenever multiple async operations, processes, connectors, writers, or agents can touch related state.
---

# Concurrency and race analysis

1. Map shared mutable state and every reader/writer.
2. Identify commit points, ownership transfer, transaction boundaries, locks, file replacement boundaries, and capability lifetime.
3. Enumerate harmful interleavings: check-then-act, lost update, double execution, stale capability, close-vs-use, revoke-vs-write, purge-vs-query, checkpoint-vs-ingest, and crash between durable steps.
4. Decide the invariant and synchronization mechanism explicitly. Prefer transactions, uniqueness constraints, immutable values, idempotency keys, or ownership over ad-hoc mutexes.
5. Build deterministic tests using barriers/hooks where possible rather than sleeps.
6. Test duplicate delivery and restart after each meaningful commit boundary.
7. For SQLite consider transaction mode, busy behavior, WAL assumptions, connection lifetime, and cross-process writers.
8. For filesystems consider rename atomicity, fsync/directory durability, symlinks, and concurrent replacement.

Do not claim race safety from code inspection alone when the interleaving can be exercised.
