---
name: ux-dx-ax-parity
description: >-
  Use for any public capability, CLI/MCP/API change, world-model primitive,
  error model, or product surface to ensure one semantic contract serves
  humans, developers, and agents coherently.
---

# UX / DX / AX parity

Kizuki must not grow three products that merely share a database. Human,
developer, and agent experiences are projections of one semantic capability.

## Product law

For every capability define one canonical core operation or read model. CLI,
TUI, MCP, HTTP, and SDK surfaces translate to and from that contract; they do
not reimplement its policy or semantics.

## Parity matrix

| Dimension | Required answer |
| --- | --- |
| Core semantic object | What does this capability mean? |
| Authority | Who may read or write it, and where is that enforced? |
| Provenance | How can the result explain itself? |
| Freshness | How does a caller know current, stale, or degraded state? |
| Error model | What happened, did state change, is retry safe, what next? |
| UX | What is the simplest useful human interaction? |
| DX | What typed API makes correct use clear? |
| AX | What bounded structured payload avoids prose scraping? |
| Compatibility | What do old clients observe? |
| Verification | How do we prove semantic parity? |

## Surface rules

UX should lead with the useful answer and make uncertainty, degradation, scope,
and recovery legible. DX needs strong boundary types, stable errors, explicit
retry semantics, and no duplicate business logic. AX needs stable IDs, evidence
references, timestamps, uncertainty, and freshness fields. Permission is
enforced in core; prompts and descriptions are explanatory only.

Where multiple surfaces exist, assert one fixture produces the same semantic
state, denial, and freshness through core, CLI or JSON, and MCP. Rendering may
differ; meaning may not.
