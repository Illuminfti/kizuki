---
name: write-rfc
description: Write or revise a small implementation-ready Kizuki RFC with concrete contracts, schemas, invariants, migration, failure semantics, tests, and explicit status. Use when a change affects architecture, frozen contracts, durable storage, authority, or unresolved product policy.
---

# Write an RFC

## Binding context (read first)

Read `docs/CURRENT.md`, `docs/decision-log.md` and
`rfcs/0002-autonomous-canon.md` before anything else in this playbook. They
are binding and override every other document in the tree, including this
one. Never write, restate or re-derive a superseded policy as current:
owner-invoked promotion as the canon write path, or any owner review queue
or approval step (D9, D10; corrections go through MCP `correct` and
`kizuki tell`, D14); owner labeling of sensitivity (D11; auto-labeled,
private by default); a zero-model floor that writes canon (D12; capture,
ledger, search, timeline, context, audit and undo stay model-free); a
SQLite-only rule for derived retrieval (D13; retrieval sits behind a
versioned port with its own rebuildable store under the vault); an
owner-started daemon (D15; `kizuki init` installs it); or the review gate as
the product's moat (C8).

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
9. Model-free floor and model-required behavior, scoped as in docs/decision-log.md D12.
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
