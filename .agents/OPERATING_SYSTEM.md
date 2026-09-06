# Kizuki agent operating guide

This is a subordinate orientation index for work in Kizuki. It is not a
standing policy body and does not override the root or nearest scoped
`AGENTS.md`, `docs/CURRENT.md`, `docs/decision-log.md`, or a binding RFC.

Start with the binding documents and use the canonical skills for the work at
hand. The root [`AGENTS.md`](../AGENTS.md) defines repository policy; the
[skill catalog](skills/README.md) selects task-specific workflows.

## Questions that improve an implementation

- What is the public seam and what exact behavior proves it?
- Which evidence, authority, scope, provenance, and failure state support the
  result?
- Are unavailable, unknown, stale, inferred, contradicted, and empty kept
  distinct?
- Does one core contract provide the human, developer, and agent projection?
- Can correction, deletion, purge, retry, and degraded dependencies leave a
  misleading result behind?

These are prompts for analysis, not replacement procedures. Use
`orient-repository`, `implement-change`, `review-change`, and `handoff-work`
for the canonical workflow.

## Boundary pointers

- The frozen ingress contract remains governed by
  [`rfcs/0000-constraints.md`](../rfcs/0000-constraints.md) and RFC 0002; this
  guide does not redefine capture.
- Claims and receipts remain authoritative product state. The receipted writer
  is the only path that projects eligible claims into durable, human-readable
  Markdown canon.
- Derived indexes and authorized World Slices are rebuildable read projections.
  A slice may read permitted evidence, claims, canon, and derived indexes;
  model-free query may read ledger or claims directly. Slice display Markdown
  is not canon, and canon is never generated from a slice or agent context.
- Authorization must precede discovery. External revisions, hashes, counts,
  totals, change signals, and cache keys are scoped to the principal and grant.
  Failed or unavailable dependencies are not empty results.

For narrowly scoped guidance, use `epistemic-integrity`,
`provenance-invalidation`, `ux-dx-ax-parity`, `world-model-architecture`, or
`world-slice-design`. For a GitHub work packet, use
`issue-pickup-execution` in addition to the canonical workflow it composes.
