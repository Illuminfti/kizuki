---
name: World model architecture
description: >-
  Use for world-model tickets, ontology/state design, semantic primitives,
  temporal modeling, perspective, situations, concepts, world revisions,
  world slices, world diffs, hypotheses, or knowledge-atlas work.
---
# World model architecture

Use this skill for work under epic #497 or any change that alters how Kizuki represents the owner's world.

## First principle

Kizuki is not a document archive with AI garnish. It is an evidence-backed model of changing reality. Every higher-order object must retain a path back to source evidence and remain revisable when that evidence changes.

## Required distinctions

Never collapse these:

- event vs observation;
- observation vs claim;
- claim vs inference;
- entity vs document page;
- current state vs historical state;
- world state vs one actor's perspective;
- explicit belief vs inferred belief;
- dependency vs causal claim;
- hypothesis vs fact;
- forecast vs canon;
- capability vs procedure;
- task context vs unrestricted vault export.

## Architecture checklist

Before changing schema or contracts, answer:

1. **Authority**: What is authoritative? Existing claim-backed state, new durable state, or a derived projection?
2. **Provenance**: Which event/claim IDs explain this object or edge?
3. **Time**: Does this need valid time, assertion time, both, or neither?
4. **Perspective**: Whose observation/belief/inference is represented?
5. **Lifecycle**: How does it become live, stale, superseded, invalid, resolved, or purged?
6. **Invalidation**: What happens after correction, source deletion, purge, or changed identity resolution?
7. **Permission**: Is every traversed node/edge filtered below the prompt layer?
8. **Rebuild**: Which state is derived and how is it reconstructed from authority?
9. **Scale**: Which queries must be indexed and which traversals are bounded?
10. **Projection**: How do UX, DX, and AX consume the same semantic capability?

## Schema discipline

Do not add one bespoke table per noun by reflex. Start from query patterns, integrity constraints, temporal semantics, and migration cost.

Prefer a small number of strong primitives when they preserve type safety and indexing. Reject generic EAV designs that make integrity or performance opaque.

Every durable schema addition needs:

- fresh-db creation;
- migration from every supported schema;
- rollback/failure coverage;
- indexes justified by actual queries;
- purge/invalidation semantics;
- exact export/restore implications.

## World-state quality rules

- Lack of evidence is not evidence of absence unless source coverage supports that inference.
- Repeated copies of the same source do not multiply confidence.
- A model return of unavailable is not an empty result.
- Consuming information does not prove understanding.
- A person's internal state is never fact unless explicitly stated or otherwise directly evidenced; model inference remains labeled inference.
- Counterfactual and forecast state is derived analysis and must not leak into current-world queries.

## UX/DX/AX test

For each new primitive, write one sentence for each surface:

**UX:** what useful human question becomes easier?

**DX:** what typed API lets a developer use the capability correctly?

**AX:** what compact structured state can an authorized agent consume without prose scraping?

If the three answers describe different semantics, redesign.

## Acceptance proof

Prefer longitudinal fixtures over isolated rows. A good fixture includes multiple sources, corrections, changed state, duplicate/copied evidence, conflicting perspectives, stale clients, and purge. Prove the resulting world state remains temporally correct, permission-safe, and explainable.