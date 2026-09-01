---
name: write-rfc
description: Write or revise a small implementation-ready Kizuki RFC with concrete contracts, schemas, invariants, migration, failure semantics, tests, and explicit status. Use when a change affects architecture, frozen contracts, durable storage, authority, or unresolved product policy.
---

# Write an RFC

## Preconditions

Run `orient-repository`. Read RFC 0000, architecture, relevant merged RFCs,
current code, tests, and open design work. Do not design around capabilities
that do not exist.

## Required structure

1. Title, number, author or owner when known, date, and explicit status.
2. Problem and user-visible outcome.
3. Scope and non-goals.
4. Existing implementation and missing prerequisites.
5. Invariants and authority boundaries.
6. Concrete TypeScript contracts and SQLite schemas.
7. State transitions, idempotency keys, and failure semantics.
8. Provenance, sensitivity, authorization, purge, and revocation behavior.
9. Deterministic fallback and optional-model behavior.
10. Migration, rollback, recovery, and compatibility.
11. Public-seam red-green tests and acceptance commands.
12. Security and privacy analysis.
13. Alternatives and rejected options.
14. Rollout, observability or receipts, and open decisions.

## Discipline

Keep the RFC bounded and dependency ordered. Use neutral examples and synthetic
data. Separate accepted constraints, proposed decisions, and future ideas.
An RFC is not binding merely because it exists; its status and merge state must
say so. Do not ship placeholder implementation to make the document appear
complete.
