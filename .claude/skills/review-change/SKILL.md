---
name: review-change
description: Review a Kizuki branch or pull request at an exact head for specification, security, correctness, regressions, and integration risk. Use before readiness or merge, after a head changes, or when asked for an independent code review.
---

# Canonical skill adapter

Read `../../../.agents/skills/review-change/SKILL.md` and follow it exactly. That
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

Fail any change that reintroduces one of those policies.
