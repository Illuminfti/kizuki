---
name: reliability-engineering
description: Design or review Kizuki behavior for retries, partial failure, restart, recovery, liveness, degraded operation, and bounded blast radius. Use for durable state, schedulers, connectors, file writes, indexing, or any workflow that can be interrupted.
---

# Reliability engineering

## Failure-mode analysis

1. Run `orient-repository`.
2. Trace the complete workflow and list every state-changing boundary.
3. For each boundary, ask what happens on timeout, process death, disk error, duplicate delivery, stale state, and partial success.
4. Define the source of truth, commit point, retry rule, and recovery procedure.
5. Keep changes small, observable, and reversible.

## Design rules

- Idempotency must be explicit, not accidental.
- Durable multi-step changes need a transaction, journal, or equivalent recovery protocol.
- Acknowledgement must follow durable commit, never precede it.
- Retried work must not duplicate side effects.
- Derived state may fail independently and be rebuilt.
- Liveness should be visible through receipts or health surfaces without leaking private data.
- Degraded mode should preserve the deterministic floor where possible.
- Timeouts, retries, queues, recursion, and retained work must be bounded.

## Verification

Write failure-injection tests around commit boundaries. Test restart after
partial progress, duplicate calls, stale writers or tokens, corrupt derived
state, unavailable optional dependencies, and successful recovery without
owner intervention when that is the contract.

Document residual failure modes rather than hiding them behind retries.
