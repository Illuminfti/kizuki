---
name: longitudinal-evaluation
description: >-
  Use for world-model evaluation, replay fixtures, memory quality, stale-state
  tests, knowledge evolution, context quality, outcome learning, and release gauntlets.
---

# Longitudinal evaluation

World models fail over time, not only per request. Evaluate Kizuki as an
evolving system.

## Replay design

Build scenarios in which evidence arrives over time and the system must
preserve temporal truth, update beliefs, invalidate stale state, and serve the
right context at each point. Include multiple sources, copied evidence,
ambiguous identity, corrections, contradictions, incomplete coverage, stale
clients, deletion or purge, execution receipts, observed outcomes, and periods
when model or retrieval components are unavailable. Reveal only the evidence
available at each simulated timestamp.

## Measures and comparisons

Prefer behavioral measures: stale-belief reuse, missed correction propagation,
false confidence, missed material changes, re-explanation required, duplicate
semantic objects, permission leakage, outcome misattribution, slice relevance,
rebuild equivalence, and resource growth. Externally reported metrics, counts,
and totals must come from the same authorized view as the requesting principal.

When comparing raw history, lexical retrieval, context packets, semantic state,
or World Slices, keep model, fixture, authorization, and budget comparable.

## Adversarial cases

Try to make Kizuki believe copied rumors, infer beliefs from weak evidence,
treat a missing sync as no event, retain superseded commitments, mistake reading
for mastery, accept "done" as success, leak a restricted neighbor, retain
purged material, or forecast from future evidence.

Record fixture size, event and semantic-object counts, command, elapsed time,
memory where practical, and exact head. Do not ship a world-model capability
because one synthetic example looks convincing.
