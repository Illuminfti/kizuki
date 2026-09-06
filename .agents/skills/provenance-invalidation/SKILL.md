---
name: provenance-invalidation
description: >-
  Use when derived state depends on evidence or claims, including correction,
  supersession, purge, source deletion, revisions, dependency graphs, cache
  invalidation, and rebuildability.
---

# Provenance and invalidation

If Kizuki cannot explain why state exists and remove or recompute it when its
support changes, that state does not belong in the world model.

## Dependency boundaries

Model derivation support explicitly enough to explain every durable or
user-visible conclusion:

```text
source event → observation → claim / inference
                         ├→ receipted writer → durable Markdown canon
                         ├→ rebuildable derived index
                         └→ authorized World Slice
```

Claims and receipts are authoritative state. The receipted writer is the only
path to durable canon. Derived indexes and World Slices are separate,
rebuildable projections; a slice may read permitted evidence, claims, canon,
and indexes, while model-free reads may use ledger or claims directly. Slice
rendering is not canon, and canon is never generated from a slice or agent
context.

## Required mutations

For each derived object define behavior under correction, claim supersession,
source deletion or tombstone, purge, identity merge or split, changed evidence,
migration, rebuild, and stale evidence. "Nothing happens" must be an explicit,
justified rule.

Use explicit states such as current, stale, superseded, invalid,
pending-recompute, or purged where needed. Do not solve invalidation with a
full-vault rebuild on every write; use bounded dependency lookups and ensure a
crash leaves recomputation diagnosable and retryable.

## Purge and revision semantics

Purge is complete only when authoritative semantic state and every owned
derived store prove absence under the repository's purge contract. Do not
retain embeddings, graph edges, summaries, cached slices, or dependency rows
that expose purged material.

Any externally visible revision, hash, count, total, change signal, or cache
key is scoped to the principal and grant. A client with a changed or expired
grant has a new view and cannot compare it with a broader former view. Do not
represent engine degradation as unchanged.

## Tests

Use a longitudinal fixture: ingest evidence, derive state, cache or query it,
correct or purge support, assert exactly dependent state changes while
unrelated state remains valid, then rebuild and compare semantics. Test denied
content and denied observables, including IDs, revisions, counts, totals,
pagination, degraded flags, and cache keys.
