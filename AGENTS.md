# Agent instructions

This tree is the Gauntlet controller, not Kizuki. Do not add credentials,
network calls, automatic harness execution, GitHub mutations, or target-repo
writes. Keep adapters probe-only with absolute paths, fixed argv, bounded
timeouts, and sanitized results. A version success is not auth or route
readiness. `record-adapter` may persist only sanitized evidence produced by a
separate approved check. Do not add network/model probes unless a separately
approved executor design is accepted. The unwired executor module is not an OS
sandbox and must remain unreachable from CLI/service paths. Preserve
JSONL-before-projection ordering and never weaken lease
fencing, exact-SHA receipts, circuit breakers, or the localhost-only observer.
