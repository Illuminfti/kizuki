---
name: write-rfc
description: Write or revise a small implementation-ready Kizuki RFC with concrete contracts, schemas, invariants, migration, failure semantics, tests, and explicit status. Use when a change affects architecture, frozen contracts, durable storage, authority, or unresolved product policy.
---

# Canonical skill adapter

Read `../../../.agents/skills/write-rfc/SKILL.md` and follow it exactly. That
file is the canonical workflow. Do not fork, summarize, or replace its
instructions in this adapter.

Before that file, and before any work performed under it, read
`docs/CURRENT.md`, `docs/decision-log.md` and
`rfcs/0002-autonomous-canon.md`. They are binding and override every other
document in the tree, including the canonical skill. Never restate a
superseded policy as current: owner-invoked promotion or an owner review
queue or approval step (D9, D10), owner-labeled sensitivity (D11), a
zero-model floor that writes canon (D12), SQLite-only derived retrieval
(D13), an owner-started daemon (D15), or the review gate as the moat (C8).
