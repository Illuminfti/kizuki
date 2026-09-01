---
name: performance-engineering
description: Measure and improve Kizuki performance using reproducible benchmarks, complexity analysis, realistic synthetic workloads, profiling, regression budgets, and correctness-preserving optimization. Use for latency, throughput, memory, I/O, startup, indexing, or scaling work.
---

# Performance engineering

## Measure before changing

1. Run `orient-repository`.
2. Define the metric, workload, baseline, target, and acceptable trade-offs.
3. Reproduce the bottleneck with a deterministic synthetic benchmark.
4. Profile or instrument the narrow path before guessing at causes.
5. Identify algorithmic complexity, allocation, I/O, SQLite query, serialization, and concurrency costs.

## Optimize in order

Prefer high-leverage changes:

- eliminate unnecessary work or repeated scans;
- use better algorithms or indexes;
- bound fan-out and pagination;
- batch durable operations safely;
- avoid duplicate serialization and copies;
- shorten critical sections and transaction time;
- stream when materializing everything is unnecessary;
- cache only when invalidation and memory bounds are explicit.

Do not trade away correctness, provenance, purge, deterministic behavior,
authorization, or recoverability for benchmark numbers.

## Benchmark discipline

Warmup and repeated samples must be comparable. Record dataset shape, Bun
version, machine class when relevant, and variance. Report median plus a tail
measure when latency matters. Add a regression test or budget when the metric
is stable enough for CI.

Prove the optimized path returns identical results and handles empty, worst
reasonable, and adversarially shaped input.
