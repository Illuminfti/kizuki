---
name: World Slice design
description: >-
  Use for task-aware context, context packets, world slices, relevance packing,
  token budgets, freshness, deltas, or agent-context compilation.
---
# World Slice design

A World Slice is not “top-k search with nicer prose.” It is the minimum sufficient, permission-safe, current world state required for a task.

## Compiler mindset

Treat the operation as compilation:

```text
task intent + principal + world revision + budget
→ candidate semantic state
→ authorization
→ relevance / necessity
→ dependency closure
→ compression
→ structured slice + evidence + freshness
```

## Required inputs

Prefer explicit fields for:

- task or intended outcome;
- principal/grant;
- optional subjects/situations;
- budget;
- prior revision/hash when available;
- requested capabilities.

Do not require an agent to know internal database vocabulary.

## Packing priorities

A slice should preserve, in order of semantic necessity rather than document size:

1. hard constraints and authority boundaries;
2. active goal/situation state;
3. current decisions/commitments/blockers;
4. relevant owner knowledge and uncertainty;
5. relevant people/perspectives;
6. procedures/frameworks/outcome lessons;
7. supporting evidence and recent changes.

A ten-token hard constraint must beat a thousand-token semantically similar essay.

## Privacy and authorization

Authorization happens before inclusion. Graph expansion is checked for every node and edge. Never fetch broad private state and rely on the renderer to hide it later.

## Freshness

Every slice must make staleness observable. Prefer world revision/epoch plus explicit valid-until semantics where appropriate.

A stale slice is not necessarily unusable, but the client must be able to know it is stale. For consequential actions, expose whether assumptions changed since the pinned revision.

## Degradation

If retrieval, graph, embeddings, or semantic state are degraded:

- declare the missing capability;
- preserve the deterministic floor;
- never report the missing layer as an empty result;
- do not widen scope to compensate.

## Output shape

Prefer structured sections with stable IDs and evidence refs. Human-readable markdown can be a projection, not the sole representation.

The agent should be able to answer:

- what matters here?
- what changed?
- what is uncertain?
- what must I not assume?
- what evidence supports this?
- is this still current?

without scraping prose for hidden state.

## Evaluation

Test adversarial packing:

- decisive tiny constraint vs large similar context;
- conflicting perspectives;
- stale prior revision;
- denied related node;
- missing semantic engine;
- token pressure;
- duplicate evidence;
- correction after cached context.

A slice is good when it minimizes owner re-explanation while preserving truth, scope, and uncertainty.