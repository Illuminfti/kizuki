---
name: run-lane
description: Execute one lane of a plan to a deterministic finish line — define done before building, prove behavior by running it, build only what the finish line requires, and report honestly when it cannot be reached. Use when handed a numbered milestone, module, or step from a plan document.
---

# Canonical skill adapter

Read `../../../.agents/skills/run-lane/SKILL.md` and follow it exactly. That
file is the canonical workflow. Do not fork, summarize, or replace its
instructions in this adapter.

Before that file, and before any work performed under it, read
`docs/CURRENT.md`, `docs/decision-log.md` and
`rfcs/0002-autonomous-canon.md`. They are binding and override every other
document in the tree, including the canonical skill and including the plan
you were handed. Never restate a superseded policy as current: owner-invoked
promotion or an owner review queue or approval step (D9, D10), owner-labeled
sensitivity (D11), a zero-model floor that writes canon (D12), SQLite-only
derived retrieval (D13), an owner-started daemon (D15), or the review gate as
the moat (C8).
