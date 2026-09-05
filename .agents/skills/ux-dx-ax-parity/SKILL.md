---
name: UX DX AX parity
description: >-
  Use for any public capability, CLI/MCP/API change, world-model primitive,
  error model, or product surface to ensure one semantic contract serves
  humans, developers, and agents coherently.
---
# UX / DX / AX parity

Kizuki must not grow three products that merely share a database. Human, developer, and agent experiences are projections of one semantic capability.

## Product law

For every capability define one canonical core operation or read model. CLI, TUI, MCP, HTTP, and SDK surfaces translate to and from that contract. They do not reimplement its policy or semantics.

## The parity matrix

Before implementation, fill this mentally or in the issue/PR:

| Dimension | Required answer |
| --- | --- |
| Core semantic object | What does this capability mean? |
| Authority | Who may read/write it and where is that enforced? |
| Provenance | How can the result explain itself? |
| Freshness | How does a caller know the state is current/stale/degraded? |
| Error model | What happened, did state change, is retry safe, what next? |
| UX | What is the simplest useful human interaction? |
| DX | What typed API makes the correct use obvious? |
| AX | What structured payload avoids prose scraping and ambiguity? |
| Compatibility | What do old clients observe? |
| Verification | How do we prove semantic parity? |

## UX rules

- Lead with the useful answer, not schema vocabulary.
- Progressive disclosure: summary → evidence → history/receipt.
- Make uncertainty and degradation legible without dumping internals.
- Destructive or consequential actions need precise scope and recovery semantics.
- Never require the user to understand an implementation detail to perform a routine task.

## DX rules

- Strong types and validators at boundaries.
- Stable error codes and explicit retry/idempotency semantics.
- No duplicate business logic in adapters.
- Fixtures and examples should be small enough to understand and strong enough to fail when semantics drift.
- Migrations and compatibility belong to the contract, not release notes alone.

## AX rules

- Stable IDs, enums, timestamps, evidence refs, uncertainty, and freshness are explicit fields.
- Permission is enforced in core; prompts and tool descriptions are explanatory only.
- Return bounded structures, not giant narrative dumps.
- Distinguish unavailable/degraded from empty.
- Include enough machine-readable state for an agent to decide whether it needs drill-down.
- Never expose a broader graph neighborhood than the principal is authorized to traverse.

## Golden parity test

Where multiple surfaces exist, construct one fixture and assert that core, CLI/JSON, and MCP represent the same semantic state, denial, and freshness. Rendering may differ. Meaning may not.

A new public surface is incomplete if it invents a concept the core contract cannot express.