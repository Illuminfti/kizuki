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

The full S and M runs on implementation commit
`99356205a07449635792a155b14814090753abd1` used seed 1, Bun 1.3.14,
linux/x64 and 12 logical CPUs. Both began with load averages
14.29, 24.63, 32.16. Benchmark and product code matched that revision;
documentation-only edits were present. The host was shared and busy; these
numbers are a recorded reference, not an isolated hardware comparison or a
reproduction of another deployment's timings. S produced 8 pages, 996
unwritten claims and 984 unextracted events. M produced 158 pages, 19,921
unwritten claims and 19,880 unextracted events. L and XL have not been executed
on this branch. The extraction controller has a reduced-pass regression that
proves resumption across the bounded passes required by XL.

Values below are measured medians. Reports retain all samples and p95/p99.
A throughput target multiplies its median by 10; a latency or CPU target
divides by 10. Total RSS has a runtime floor, so a 10x total-RSS target is not
meaningful; compare its growth with workload size. Three idle observations per
size have limited tail resolution. These are optimization targets,
not achieved speedups or release gates.

| Metric | Unit | S p50 | M p50 | S 10x target | M 10x target |
| --- | --- | ---: | ---: | ---: | ---: |
| `ingest.events_per_s` | events/s | 36.278 | 17.387 | 362.779 | 173.865 |
| `canon.writes_per_s` | writes/s | 2.168 | 0.687 | 21.676 | 6.868 |
| `canon.cpu_ms_per_write` | ms | 208.190 | 952.519 | 20.819 | 95.252 |
| `daemon.drain_wall_ms` | ms | 27845.113 | 1150617.981 | 2784.511 | 115061.798 |
| `daemon.drain_peak_rss_bytes` | MiB | 163.535 | 243.781 | — | — |
| `mcp.search.wall_ms` | ms | 144.520 | 1351.046 | 14.452 | 135.105 |
| `cold_mcp.search.wall_ms` | ms | 608.843 | 2379.243 | 60.884 | 237.924 |
| `mcp.context_session.wall_ms` | ms | 69.130 | 421.995 | 6.913 | 42.199 |
| `cold_mcp.context_session.wall_ms` | ms | 963.901 | 1555.692 | 96.390 | 155.569 |
| `mcp.context_query.wall_ms` | ms | 154.629 | 812.257 | 15.463 | 81.226 |
| `cold_mcp.context_query.wall_ms` | ms | 1180.693 | 2105.943 | 118.069 | 210.594 |
| `mcp.get_page.wall_ms` | ms | 52.866 | 222.462 | 5.287 | 22.246 |
| `cold_mcp.get_page.wall_ms` | ms | 624.119 | 889.993 | 62.412 | 88.999 |
| `mcp.timeline.wall_ms` | ms | 59.560 | 489.438 | 5.956 | 48.944 |
| `cold_mcp.timeline.wall_ms` | ms | 718.723 | 1074.275 | 71.872 | 107.427 |
| `mcp.world_discovery.wall_ms` | ms | 48.138 | 153.450 | 4.814 | 15.345 |
| `cold_mcp.world_discovery.wall_ms` | ms | 672.369 | 931.846 | 67.237 | 93.185 |
| `mcp.graph_neighbors.wall_ms` | ms | 16.963 | 28.689 | 1.696 | 2.869 |
| `cold_mcp.graph_neighbors.wall_ms` | ms | 730.751 | 759.078 | 73.075 | 75.908 |
| `cold_cli.search.wall_ms` | ms | 863.959 | 2538.316 | 86.396 | 253.832 |
| `cold_cli.context_session.wall_ms` | ms | 1155.658 | 1600.756 | 115.566 | 160.076 |
| `cold_cli.context_query.wall_ms` | ms | 1264.258 | 2003.120 | 126.426 | 200.312 |
| `cold_cli.world_discovery.wall_ms` | ms | 685.409 | 973.095 | 68.541 | 97.309 |
| `doctor.wall_ms` | ms | 986.225 | 1210.062 | 98.622 | 121.006 |
| `doctor.peak_rss_bytes` | MiB | 136.152 | 162.848 | — | — |
| `export.wall_ms` | ms | 2575.671 | 144480.554 | 257.567 | 14448.055 |
| `restore.wall_ms` | ms | 3204.092 | 27784.689 | 320.409 | 2778.469 |
| `purge.wall_ms` | ms | 1136.890 | 6476.567 | 113.689 | 647.657 |
| `rebuild.wall_ms` | ms | 289.522 | 3203.803 | 28.952 | 320.380 |
| `serve.idle_cpu_percent` | CPU % | 0.969 | 0.814 | 0.097 | 0.081 |

Logical input SHA-256:

- S `e10111f4f993359aaf18233dbf5c733c8df41b4352131da39b8770ee663b454a`
- M `f23c93b6b1cdd59ce5cae4a22c87da9c913adcccc2d6f4891e59bc69d9e5878d`

Regenerate reports outside the repository with the commands above; no vault,
packet body, machine path or private measurement artifact is checked in.
