# Shared memory

This is the shared, committed, cross-harness memory for this repository.
Every harness reads this index before work and updates it when a durable
rule or recurring fix is learned. Rules live in [README.md](README.md).

Last reconciled: 2026-11-16 at 51eb5420f97578a3d2d0ac1dbcd5e7155be21f63

## Topics

- [Read-path cost and per-read memory](topics/read-path-cost.md)
- [Bounded canon citations still have to satisfy the gate](topics/canon-citation-bound.md)
- [Forecast fixtures stay ahead of the real clock](topics/forecast-fixtures-ahead-of-clock.md)
- [Ubuntu 26.04 drops the runner inotify limits](topics/runner-inotify-limits.md)
