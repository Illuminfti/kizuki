---
name: migration-work
description: Plan, implement, or review Kizuki schema, data, file-format, API, or dependency migrations with compatibility, restart safety, rollback thinking, verification, and cleanup. Use for any change that transforms durable state or many callers.
---

# Migration work

## Inventory first

1. Run `orient-repository`.
2. Identify every source format or version, destination version, reader, writer, caller, and supported upgrade path.
3. State whether the migration is startup-time, explicit command, lazy, online, or rebuild-only.
4. Define invariants that must hold before, during, and after interruption.

## Design

Prefer expand, migrate, contract:

1. Add backward-compatible readers or schema.
2. Write the new representation while old data remains readable.
3. Migrate deterministically and idempotently.
4. Verify counts, identities, hashes, provenance, and constraints.
5. Switch readers only after proof.
6. Remove compatibility code in a separately reviewable step when safe.

For SQLite, keep migrations transactional where possible and test fresh
database plus every supported prior schema. For rebuildable derived state,
prefer dropping and rebuilding over risky transformation.

## Failure proof

Test interruption at meaningful boundaries, rerun after partial completion,
duplicate execution, unsupported versions, malformed legacy data, rollback or
restore, and mixed-version state when it can exist.

Never silently discard unknown fields or evidence. Record exact migration
receipts without private content.
