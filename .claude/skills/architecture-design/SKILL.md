---
name: architecture-design
description: Design or review a Kizuki architecture change by tracing requirements, invariants, boundaries, failure modes, trade-offs, reversibility, and verification before implementation.
---

# Canonical skill adapter

Read `../../../.agents/skills/architecture-design/SKILL.md` and follow it exactly. That
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
