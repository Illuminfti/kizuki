---
name: world-model-architecture
description: >-
  Use for world-model tickets, ontology or state design, semantic primitives,
  temporal modeling, perspectives, situations, world revisions, World Slices,
  diffs, hypotheses, or Knowledge Atlas work.
---

# World model architecture

Use this skill for world-model work. The frozen `kizuki.event/v1` ingress
contract remains governed by `rfcs/0000-constraints.md` and RFC 0002; this
skill does not redefine capture.

## Required distinctions

Keep event, observation, claim, inference, hypothesis, forecast, canon,
current state, historical state, an actor's perspective, task context, and an
unrestricted vault export distinct. Higher-order objects retain a path to
source evidence and remain revisable when that evidence changes.

## Architecture checklist

Before changing schema or contracts, identify authority, provenance, valid and
assertion time, perspective, lifecycle, invalidation, permission, rebuild
source, scale bounds, and the shared UX/DX/AX projection.

Authorization must be checked before candidate discovery and on every
node/edge traversal, ranking, dependency closure, count, compression, and
model use. Externally visible IDs, revisions, hashes, counts, totals, change
signals, and cache keys are scoped to the principal and grant. A changed or
expired grant creates a new view.

## Projection boundaries

Claims and receipts are authoritative state. The existing receipted writer is
the only path from eligible claims to durable, human-readable Markdown canon.
Derived indexes and authorized World Slices are independent rebuildable read
projections. A slice may use permitted evidence, claims, canon, and indexes;
model-free query may read ledger or claims directly. Slice Markdown is not
canon, and neither a slice nor agent context produces canon.

## Quality and acceptance

Lack of evidence is not absence without coverage support. Repeated copies do
not multiply confidence. Model unavailability is not empty. Consuming
information does not establish personal learning beyond the independently
evidenced facets. Forecasts and counterfactuals remain derived analysis.

Use longitudinal fixtures with corrections, changing state, duplicate evidence,
conflicting perspectives, stale clients, denied traversal, and purge. Prove
temporal correctness, authorized observables, explainability, and rebuild
equivalence.
