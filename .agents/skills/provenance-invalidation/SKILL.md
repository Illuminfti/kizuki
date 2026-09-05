---
name: Provenance and invalidation
description: >-
  Use when derived state depends on evidence or claims, including correction,
  supersession, purge, source deletion, world revisions, dependency graphs,
  cache invalidation, and rebuildability.
---
# Provenance and invalidation

If Kizuki cannot explain why a piece of state exists and remove or recompute it when its support changes, that state does not belong in the world model.

## Dependency spine

Model the derivation chain explicitly enough to answer:

```text
source event
→ observation
→ claim / inference
→ semantic node / relation / state
→ synthesis / world slice / canon / derived index
```

Not every layer needs its own table, but every durable or user-visible conclusion needs resolvable support.

## Required mutations

For each derived object define behavior under:

- owner correction;
- claim supersession;
- source-record deletion/tombstone;
- subject/source purge;
- identity merge/split;
- changed evidence;
- migration;
- rebuild;
- expired/stale evidence where supported.

“Nothing happens” must be an explicit, justified rule, not an omission.

## Invalidation states

Prefer explicit states such as current, stale, superseded, invalid, pending-recompute, or purged when semantics require them. Do not serve stale data as current because recomputation is inconvenient.

## Incrementality

Do not solve invalidation with a full-vault rebuild on every write. Maintain indexed dependency relationships or equivalent bounded lookup paths.

Batch and checkpoint background recomputation. Crash midway must leave state diagnosable and safely retryable.

## Purge totality

Purge is not complete until authoritative semantic state and every owned derived store prove absence according to the repository's purge contract.

Do not preserve hidden embeddings, graph edges, summaries, cached slices, or dependency rows that still expose purged material.

## Revision semantics

If the world model exposes a revision, define precisely what changes it. The revision must be restart-safe and meaningful to clients.

A client pinned to revision R should be able to learn whether relevant assumptions changed after R without treating engine degradation as “unchanged.”

## Tests

Use a longitudinal fixture:

1. ingest evidence;
2. derive claims and semantic state;
3. cache/query the result;
4. correct or purge one supporting fact;
5. assert exactly dependent state changes;
6. assert unrelated state remains valid;
7. assert stale clients receive a detectable revision/diff change;
8. rebuild derived state and compare semantics.

The strongest invalidation test proves both over-deletion and under-deletion are absent.