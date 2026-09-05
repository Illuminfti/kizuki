---
name: world-slice-design
description: >-
  Use for task-aware context, context packets, World Slices, relevance packing,
  token budgets, freshness, deltas, or agent-context compilation.
---

# World Slice design

A World Slice is the minimum sufficient, permission-safe, current world state
for a task. It is not a prettier top-k search result.

## Compiler mindset

Authorize the principal and grant before discovery:

```text
task intent + principal/grant + requested capabilities + budget
→ authorized candidate state and traversals
→ relevance / necessity
→ dependency closure
→ compression
→ structured slice + authorized freshness
```

Apply scope and sensitivity to every candidate lookup and node or edge
traversal before ranking, closure, counting, compression, or model use. Never
fetch broad private state and conceal it only during rendering.

## Inputs and packing

Prefer explicit task, principal/grant, optional subjects or situations, budget,
prior scoped revision/hash, and requested capabilities. Preserve hard
constraints and authority boundaries before active state, decisions, relevant
knowledge and uncertainty, perspectives, procedures, supporting evidence, and
recent changes. A tiny decisive constraint beats a large similar essay.

## Freshness, observables, and degradation

Every external revision, fingerprint, count, total, pagination value, changed
signal, degraded flag, and cache key is principal-and-grant scoped and changes
only when that authorized view changes. A changed or expired grant creates a
new view. Do not disclose hidden-state work through an unscoped global epoch,
cardinality, cache result, or change signal.

Make staleness observable. If retrieval, graph, embedding, or semantic state is
unavailable, declare the missing capability, preserve the deterministic floor,
and do not report it as empty or widen scope to compensate.

## Output boundary and evaluation

Return bounded structured sections with stable IDs and evidence references.
Slice display Markdown is not durable canon: the receipted writer alone creates
canon from eligible claims, never from a slice or agent context.

Test decisive small constraints, conflicting perspectives, stale prior views,
denied related nodes, unavailable components, token pressure, duplicate
evidence, correction after cache, and unauthorized observable metadata.
