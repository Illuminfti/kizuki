---
name: Longitudinal evaluation
description: >-
  Use for world-model evaluation, replay fixtures, memory quality, stale-state
  tests, knowledge evolution, context quality, outcome learning, and release gauntlets.
---
# Longitudinal evaluation

World models fail over time, not only per request. Evaluate Kizuki as an evolving system.

## Core principle

A static fixture can prove parsing. It cannot prove continuity.

Build replay scenarios in which evidence arrives over time and the system must preserve temporal truth, update beliefs, invalidate stale state, and serve the right context at each point.

## Replay design

A serious longitudinal fixture should include:

- multiple sources for the same subjects;
- copied/non-independent evidence;
- ambiguous identity;
- changing roles or project state;
- deadline changes;
- corrections;
- contradictory statements;
- incomplete connector coverage;
- stale clients;
- source deletion and purge;
- agent execution receipts;
- observed success and failure;
- periods with unavailable model/retrieval components.

Reveal only the evidence available at each simulated timestamp. Never let a prediction or state estimate see future evidence.

## Metrics that matter

Prefer behavioral measures over row counts:

- stale-belief reuse;
- missed correction propagation;
- false confidence;
- false alerts / interruption waste;
- missed material changes;
- owner re-explanation required;
- duplicate semantic objects;
- permission leakage;
- outcome misattribution;
- world-slice relevance under token pressure;
- rebuild equivalence;
- time/memory growth as history scales.

## Baselines

Where useful compare:

1. raw history;
2. lexical retrieval;
3. current context packet;
4. world-model semantic state;
5. task-aware World Slice.

Keep model, fixture, permissions, and budget comparable. Do not claim improvement from changing multiple variables at once.

## Failure-oriented cases

A high-quality eval intentionally tries to make Kizuki:

- believe a copied rumor three times;
- infer a person's belief from weak evidence;
- treat a missing sync as no event;
- keep a superseded commitment alive;
- mark reading as mastery;
- accept “done” as outcome success;
- leak a restricted graph neighbor;
- keep a purged fact inside a summary or embedding;
- forecast using evidence that arrived after the forecast.

## Performance

Measure incremental cost as history grows. Normal ingest and query paths must not hide O(N²) semantic work.

Record fixture size, event count, semantic object count, command, elapsed time, memory where practical, and exact head.

## Release bar

Do not ship a world-model capability because one synthetic example looks magical. Ship when longitudinal replay shows it stays correct after change, conflict, stale state, failure, and deletion.