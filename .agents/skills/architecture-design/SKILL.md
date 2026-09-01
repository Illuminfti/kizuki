---
name: architecture-design
description: Design or review a Kizuki architecture change by tracing requirements, invariants, boundaries, failure modes, trade-offs, reversibility, and verification before implementation. Use for new subsystems, cross-package changes, or consequential design choices.
---

# Architecture design

## Start from constraints

1. Run `orient-repository`.
2. State the user outcome, current implementation, governing RFCs, and hard invariants.
3. Identify the smallest architectural boundary that can satisfy the outcome.
4. Map components, ownership, data flow, trust boundaries, durable state, and external dependencies.
5. Separate requirements from assumptions and explicitly mark unresolved decisions.

## Evaluate the design

For each option, examine:

- simplicity and number of moving parts;
- coupling, cohesion, and direction of dependencies;
- compatibility with existing public contracts;
- failure modes, recovery, and restart behavior;
- data ownership, provenance, purge, and sensitivity;
- concurrency, idempotency, ordering, and consistency;
- bounded resource use and performance characteristics;
- deterministic fallback and optional-model behavior;
- observability or receipts needed to diagnose failure;
- migration and rollback cost;
- operational burden and future removal cost.

Prefer the smallest reversible design that preserves invariants. Avoid speculative
abstraction, hidden service dependencies, and architecture that exists only to
make a diagram look complete.

## Deliverable

Produce a decision record with context, options, trade-offs, chosen design,
rejected alternatives, interface sketches, state transitions, failure matrix,
migration path, red-green acceptance tests, and open risks.

If the change alters a binding architectural boundary, use `write-rfc` before
implementation.
