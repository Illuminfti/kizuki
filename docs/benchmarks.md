# Synthetic scale benchmarks

Run the harness from a source checkout with the pinned Bun version. Compare
clean, committed checkouts: the report git SHA identifies HEAD, not uncommitted
file contents.

```sh
bench_dir=$(mktemp -d)
TMPDIR="$bench_dir" bun scripts/bench/run.ts --size S --out "$bench_dir/bench-S"
TMPDIR="$bench_dir" bun scripts/bench/run.ts --size M --seed 1 --out "$bench_dir/bench-M"
```

`--out` defaults to a new temporary directory outside the checkout. Reports
inside the repository, including symlink aliases, are refused. An existing
report is never overwritten. Each run writes `report.json`, `summary.md` and
`report.schema.json`. It removes its synthetic vaults, imports and backups when
finished; retain the reports. No existing vault can be supplied to this script.
Use a private `TMPDIR` with safe, owned directory ancestors, as for any vault;
the harness preserves custody checks rather than repairing shared directories.

The source SQLite export is generated from a bounded integer seed (default 1).
Topics repeat across interleaved rows, with at most 256 records per topic,
distinct timestamps and source record ids. The real `kizuki.import-legacy-events` connector imports it
through Core's connector runner under an explicit synthetic source grant.
The scripted in-process chat model emits one grounded Concept per topic; the
shipped typed producer parses and admits its response. The real write pass
writes the Concepts and an equal number of capture pages through the receipted
writer, using a fixed materialization budget. The remaining capture claims stay
unwritten and their count is reported. Extraction stops after grounding every
topic and its remaining event count is also reported; this is not a fully
drained extraction or canon backlog.
There are no direct canon writes or direct inserts into product tables.

| Size | Events | Topics | Generated canon pages | Use |
| --- | ---: | ---: | ---: | --- |
| S | 1,000 | 4 | 8 | CI smoke and local baseline |
| M | 20,000 | 79 | 158 | Local only |
| L | 200,000 | 782 | 1,564 | Local only |
| XL | 1,000,000 | 3,907 | 7,814 | Local only |

This is a repeated-topic workload, **not** a million unique pages. The materialization budget
keeps the largest corpus below the existing 10,000-page canon scan limit. Each
capture page has one source, respecting the 100-source page bound.
It stresses ledger and staging growth and growing canon populations; it
cannot stand in for every deployment's text lengths, unique-claim density or
provider cost. Source rows and their SHA-256 repeat for the same size and seed.
Core still generates receipt/event ids, vault identity and capture clocks; the
finished vault is not byte-identical across runs.

The harness is offline. Children receive only explicit runtime environment
variables; no model credentials or owner config are inherited. The model
endpoint on the synthetic grant is an example-domain identity for port binding;
no request leaves the process. Reports contain counts, timings, fixed workload
metadata, platform/architecture, CPU count, initial load, Bun version and git
SHA, without hostnames, paths, event bodies, credentials or returned packets.

## Measurement protocol

Full runs discard one complete build and repeat three fresh builds. Import
throughput times the real connector drain inside the daemon's sync rail, including validation, ledger writes,
staging and checkpoints. Canon throughput and CPU time the materialization
passes after extraction finishes, including writer admission, receipts, files
and projection work. CPU milliseconds per write is process CPU divided by the
number of receipted writes, not the latency of one instrumented file write.
Extraction uses eight records per request through the real model producer over
the scripted chat boundary until every topic is grounded. Materialization
passes retain the model port and allow one extraction request per pass; that
small amount of extraction work is included in write measurements. Provider
latency and quality are outside this benchmark. Public per-day budgets remain
in force.

Each read discards two warmups and records 20 repetitions:

- `mcp`: the shipped MCP server over an in-memory JSON-RPC transport,
  including protocol validation and Core authorization, audit and projection.
- `cold_mcp`: a fresh Bun invocation of the shipped MCP stdio source entrypoint, including
  process startup, initialization, one tool call and shutdown. All seven read
  workloads run here. A refusal, empty page/search/timeline/graph or empty Concept discovery fails the run.
  Incomplete discovery remains a valid read of a partial projection.
- `cold_cli`: fresh Bun CLI `query`, session/query `context`, and `world --operation find_concepts` processes. There are no CLI verbs for `get_page`,
  `timeline` or `graph_neighbors`; the cold MCP command measures those instead.

Search uses `synthetic`, scope `all`, limit 10. Both packets have a 1,000-token
budget; the query packet uses purpose `recall` and query `synthetic`. Packets and
timeline use the fixed corpus interval from 2020 through 5000, so the synthetic
fixture cannot age out into a fast, empty packet. Timeline uses limit 10. Page and graph reads select
a real capture page; graph depth is 1. Discovery asks for Concepts labeled
`Topic`. All reads use the owner principal and the lexical floor. Optional
retrieval engines, embeddings, narrower agent grants and network models are
separate workloads, not results claimed by this harness.

Cold means a new runtime, **not** a flushed operating-system page cache. Warm
measurements include the implementation's cache behavior. Percentiles use the
nearest-rank definition; 20 samples make p99 the maximum, with limited tail
resolution. Raw samples remain in the report so outliers cannot disappear.
Do not compare runs on different machines, seeds, profiles, runtime versions or
busy-host conditions as if the optimization alone caused the difference.
A small launcher isolates measured children from the main harness's retained
heap: fork inheritance otherwise inflates their RSS before `exec`. Timing
excludes that launcher's startup and includes the measured process's startup
and shutdown. RSS uses native high-water counters normalized to bytes, with an
allocation check guarding units and inherited-parent bias.

Doctor, export, restore, purge, rebuild and daemon drain discard one warmup and
record three repetitions. Doctor runs the real CLI; exit 1 is allowed only for
its structured diagnostic report. The synthetic source has a null host state
and the CLI has no model configured, so this fixture does not claim healthy
live connector or model setup. Export covers owned ledger, canon and receipt
state. Restore includes validation and derived rebuilding. Counts must match
before purge. Purge removes one event on each independent restored vault using
Core's complete purge protocol; its absence proof is checked outside the timed
interval. Rebuild measures the shared search/graph floor and verifies counts,
not an optional retrieval-port rebuild.

Daemon drain runs the real daemon's sync rail with the real connector runner
in each fresh build process, without a model or HTTP listener. RSS is sampled
from its process high-water mark when the drain finishes, before extraction
or canon writing. It includes startup and the entire drain. This captures peaks
that a periodic sampler could miss. It is total RSS, not incremental heap.
Idle CPU records three observations in separate daemon processes. Each process
warms up until its initial due rails finish and its first sleep begins, then
observes at least 60 seconds, retaining the real one-second sleep, heartbeat
and schedules. Startup work is excluded from every observation. CPU % is user
plus system CPU divided by observed wall time, relative to one core. The report
retains all three CPU samples and their individual observed durations.
The fixture has no configured model, embedding port or HTTP listener.

## CI smoke

```sh
ktest bun test scripts/bench --timeout 120000
ktest bun run typecheck
```

Cold commands use the source checkout rather than a compiled release binary.

The command-seam test executes `--size S --smoke` with the full 1,000-event
corpus, one build/drain, one maintenance sample, two in-process read repetitions
with one warmup, and one cold-process sample per read without a warmup.
It validates the report and enforces a 60-second deadline.
It explicitly omits the idle observation, whose required 60-second window alone
cannot fit that test deadline. `--smoke` refuses other sizes. Full S/M runs
supply the performance baseline; the smoke profile is only an integration test.
L/XL runs are local-only and can be expensive in CPU, disk space and time.
The harness stops a single child phase after 24 hours; interruptions kill only
children it started and remove its temporary state.

## Report schema

The canonical runtime validator is [report.ts](../scripts/bench/report.ts).
Every report uses `schema: "kizuki.benchmark/v1"` and has exactly these fields:

| Field | Meaning |
| --- | --- |
| `profile` | `full` or `smoke` |
| `machine` | CPU count, three initial load averages, Bun version, git SHA, platform and architecture |
| `corpus` | Size, integer seed, event/topic/page, unwritten-claim and unextracted-event counts, maximum records per topic and logical input SHA-256 |
| `protocol` | Build, in-process read and cold-process warmups/repetitions; idle warmup, repetitions, requested window and observed durations; retrieval and principal |
| `metrics` | Closed inventory of metric names defined by `METRICS` |

Each metric contains `unit`, `direction` (`lower` or `higher`), `status`, raw
`samples`, nearest-rank `p50`/`p95`/`p99`, and `reason`. All measured values are
finite and nonnegative. An omitted metric has empty samples, null percentiles
and an explicit reason. Only smoke idle CPU may be omitted. The emitted JSON
Schema describes the structural grammar; the runtime validator additionally
checks the complete inventory, percentiles, units, corpus counts and profile
semantics. Unknown report fields fail validation.

Full idle protocol fields are `idle_warmup: "initial due rails"`,
`idle_repetitions: 3`, `idle_window_ms: 60000`, and `idle_observed_ms`, an array
with one elapsed duration per CPU sample in the same order. Validation requires
at least two repetitions, a requested window of at least 60,000 ms and every
observed duration at least as long as that window. Smoke records `"omitted"`
warmup, zero repetitions/window and an empty duration array.

## Baselines and targets

The full S and M profiles were measured on 2026-09-30 from clean implementation
commit `16cb4747265db60d03250aef8cd859897dd1ef38`, using seed 1, Bun 1.3.14,
linux/x64 and 12 logical CPUs. S began with load averages 54.4, 44.29, 45.5;
M began with 45.05, 48.61, 47.88. Subsequent changes affect documentation and
report-validator tests only; benchmark and product implementations match the
measurement revision.
Both reports passed the runtime validator, and their emitted schemas and
Markdown summaries matched the implementation. The host was shared and busy;
these numbers are a recorded reference, not an isolated hardware comparison or
a reproduction of another deployment's timings. S produced 8 pages, 996
unwritten claims and 984 unextracted events. M produced 158 pages, 19,921
unwritten claims and 19,880 unextracted events. L and XL have not been executed
on this branch. The extraction controller has a reduced-pass regression that
proves resumption across the bounded passes required by XL.

Each profile retained three idle CPU observations after startup warmup. Their
observed windows were 60.732, 60.186, 60.146 seconds for S and
60.141, 60.201, 60.145 seconds for M, all exceeding the requested 60 seconds.

Values below are measured medians. Reports retain all samples and p95/p99.
A throughput target multiplies its median by 10; a latency or CPU target
divides by 10. Total RSS has a runtime floor, so a 10x total-RSS target is not
meaningful; compare its growth with workload size. Three idle observations per
size have limited tail resolution. These are optimization targets,
not achieved speedups or release gates.

| Metric | Unit | S p50 | M p50 | S 10x target | M 10x target |
| --- | --- | ---: | ---: | ---: | ---: |
| `ingest.events_per_s` | events/s | 35.692 | 23.826 | 356.920 | 238.260 |
| `canon.writes_per_s` | writes/s | 2.000 | 0.830 | 19.997 | 8.297 |
| `canon.cpu_ms_per_write` | ms | 170.255 | 868.856 | 17.026 | 86.886 |
| `daemon.drain_wall_ms` | ms | 28282.082 | 839634.088 | 2828.208 | 83963.409 |
| `daemon.drain_peak_rss_bytes` | MiB | 163.539 | 239.008 | — | — |
| `mcp.search.wall_ms` | ms | 182.221 | 990.223 | 18.222 | 99.022 |
| `cold_mcp.search.wall_ms` | ms | 868.865 | 1301.937 | 86.887 | 130.194 |
| `mcp.context_session.wall_ms` | ms | 82.312 | 321.861 | 8.231 | 32.186 |
| `cold_mcp.context_session.wall_ms` | ms | 1156.977 | 823.155 | 115.698 | 82.315 |
| `mcp.context_query.wall_ms` | ms | 152.696 | 435.277 | 15.270 | 43.528 |
| `cold_mcp.context_query.wall_ms` | ms | 1279.583 | 1026.307 | 127.958 | 102.631 |
| `mcp.get_page.wall_ms` | ms | 35.731 | 35.370 | 3.573 | 3.537 |
| `cold_mcp.get_page.wall_ms` | ms | 710.592 | 358.254 | 71.059 | 35.825 |
| `mcp.timeline.wall_ms` | ms | 65.821 | 274.502 | 6.582 | 27.450 |
| `cold_mcp.timeline.wall_ms` | ms | 768.283 | 556.291 | 76.828 | 55.629 |
| `mcp.world_discovery.wall_ms` | ms | 41.917 | 83.890 | 4.192 | 8.389 |
| `cold_mcp.world_discovery.wall_ms` | ms | 730.755 | 404.445 | 73.076 | 40.444 |
| `mcp.graph_neighbors.wall_ms` | ms | 21.405 | 18.374 | 2.141 | 1.837 |
| `cold_mcp.graph_neighbors.wall_ms` | ms | 681.953 | 355.208 | 68.195 | 35.521 |
| `cold_cli.search.wall_ms` | ms | 918.697 | 1260.057 | 91.870 | 126.006 |
| `cold_cli.context_session.wall_ms` | ms | 1289.344 | 865.851 | 128.934 | 86.585 |
| `cold_cli.context_query.wall_ms` | ms | 1302.096 | 1124.169 | 130.210 | 112.417 |
| `cold_cli.world_discovery.wall_ms` | ms | 724.018 | 656.682 | 72.402 | 65.668 |
| `doctor.wall_ms` | ms | 968.886 | 1096.763 | 96.889 | 109.676 |
| `doctor.peak_rss_bytes` | MiB | 137.063 | 162.324 | — | — |
| `export.wall_ms` | ms | 2779.390 | 117296.101 | 277.939 | 11729.610 |
| `restore.wall_ms` | ms | 2865.568 | 18385.026 | 286.557 | 1838.503 |
| `purge.wall_ms` | ms | 1269.766 | 5922.647 | 126.977 | 592.265 |
| `rebuild.wall_ms` | ms | 270.201 | 2789.140 | 27.020 | 278.914 |
| `serve.idle_cpu_percent` | CPU % | 0.778 | 1.455 | 0.078 | 0.145 |

Logical input SHA-256:

- S `e10111f4f993359aaf18233dbf5c733c8df41b4352131da39b8770ee663b454a`
- M `f23c93b6b1cdd59ce5cae4a22c87da9c913adcccc2d6f4891e59bc69d9e5878d`

Regenerate reports outside the repository with the commands above; no vault,
packet body, machine path or private measurement artifact is checked in.
