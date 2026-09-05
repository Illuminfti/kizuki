# Kizuki world model implementation program

Status: planning document. This document does not make unimplemented surfaces public.

Parent architecture: GitHub #480. Situation program: GitHub #476. Binding product law remains RFC 0002 until a later RFC is merged.

## Mission

Build Kizuki into the local-first world model for a person's AI life: a continuously updated, evidence-backed representation of the owner, the people and organisations around them, concepts and frameworks they know, their active situations and commitments, their skills and knowledge gaps, and how all of that state changes over time.

Any authorized agent should be able to enter a task and obtain the minimum sufficient current world state without requiring the owner to reconstruct their context.

## Non-negotiable invariants

Every work packet must preserve frozen `kizuki.event/v1`, local-first zero-phone-home, authoritative SQLite + readable Markdown canon, rebuildable derived stores, append-only evidence, the single receipted canon writer, owner correction as highest authority, purge/provenance/reversibility, fail-closed sensitivity and grants, captured text as untrusted data, Kizuki remaining not an agent harness, and the no-fake-surface rule.

## Product law

Every public capability has one canonical core implementation and one versioned semantic contract. CLI, MCP, HTTP, TUI and future SDK/GUI surfaces are projections of the same semantics. A capability is incomplete until UX, DX and AX behavior is specified and tested.

## Program order

1. RFC 0003: exact world-model primitives and compatibility.
2. Observation + semantic primitive substrate.
3. Provenance dependency graph, world revisions and invalidation.
4. Concept vertical slice and personal epistemic state.
5. Knowledge frontier: questions, curiosity, gaps and misconceptions.
6. Perspective-aware social model.
7. Skills, frameworks and procedures backed by outcomes.
8. Dynamic situations, goals, commitments, decisions and dependencies.
9. World Slice compiler and task-aware context.
10. World Diff and freshness protocol for agents.
11. Goal-aware attention engine.
12. Execution receipts and outcome-learning loop.
13. Hypotheses, bounded forecasts and counterfactual projections.
14. Knowledge Atlas human experience.
15. Cross-cutting performance, privacy, purge and parity gauntlet.

## Definition of done for every packet

- exact contract and lifecycle semantics;
- authoritative storage or explicit derived-state rationale;
- provenance and temporal behavior;
- owner-correction behavior;
- purge and source-deletion behavior;
- sensitivity/grant enforcement below prompts;
- deterministic errors and retry semantics;
- migration and rollback safety;
- focused fixtures and adversarial tests;
- public-seam tests where a public surface is introduced;
- no README/public claim before the surface is real;
- `bun run verify` green at exact head;
- documentation updated only to the level implementation proves.

## Parallelism rules

Agents may work in parallel only when their packets do not alter the same authoritative schema or shared contract. Schema/RFC work lands before dependent surface work. Public surfaces must consume merged core contracts rather than invent local DTOs. If a packet discovers a required invariant change, stop implementation and amend the RFC first.

## Golden demo

A fresh authorized agent that has never met the owner asks Kizuki for the current world state for a task. Kizuki returns the relevant owner knowledge, active situation, people, constraints, prior decisions, procedures, uncertainties and evidence. Another agent receives the same semantic state through a different surface. The owner corrects one assumption. Both clients can detect the new world revision and receive a bounded diff without the owner repeating the story.
