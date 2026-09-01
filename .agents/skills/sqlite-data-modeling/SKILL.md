---
name: sqlite-data-modeling
description: Design or review Kizuki SQLite schemas and queries for integrity, provenance, temporal semantics, migrations, indexing, transactions, purge, and rebuildability. Use for durable core tables or derived indexes.
---

# SQLite data modeling

## Model from invariants

1. Run `orient-repository`.
2. Identify entity identity, ownership, lifecycle, provenance, sensitivity, and deletion semantics before writing DDL.
3. Decide what is source-of-truth durable state versus rebuildable derived state.
4. Encode invariants with primary keys, unique constraints, foreign keys where appropriate, checks, and explicit nullability.

Prefer stable opaque identifiers and normalized relationships where they
preserve integrity. Denormalize only for measured read performance or immutable
snapshots with clear rebuild semantics.

## Query and transaction design

- Use transactions for logically atomic changes.
- Define ordering explicitly in every public query.
- Index for observed query shapes, not imagined ones.
- Check query plans for important scans.
- Bound result sizes and pagination.
- Avoid read-modify-write races when one SQL statement can enforce the rule.
- Keep JSON fields for genuinely open payloads, not as an escape hatch from schema design.
- Preserve append-only and supersession semantics where required.

## Verification

Test fresh schema, every supported migration, constraints, duplicate inserts,
rollback, concurrent or stale operations, purge cascades, deterministic query
ordering, and rebuild equivalence for derived tables.

Use synthetic databases only. Never inspect an owner's real vault to design a
schema.
