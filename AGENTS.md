# Agent instructions

This tree is the Gauntlet controller, not Kizuki. The independently reviewed
phase-2 contract is `EXECUTION_PROTOCOL.md`; implementation must conform to it.
Do not add credentials or expose controller, worker, GitHub, or target-repo
writes through the localhost observer. Until every applicable enablement gate
in that contract has passed on the VPS, do not enable network/model calls,
automatic harness execution, GitHub mutations, merges, or target-repo writes.
Inert protocol, sandbox, egress, bridge, and fixture implementations are
permitted test-first, with all mutation paths default-dry-run and unreachable
from the deployed service. Keep bootstrap adapters probe-only with absolute
paths, fixed argv, bounded timeouts, and sanitized results. A version success
is not auth or route readiness. `record-adapter` may persist only sanitized
evidence produced by a separate approved check. The existing unwired executor
is not an OS sandbox and must remain unreachable until its real containment
gates pass. Preserve JSONL-before-projection ordering and never weaken role or
lease fencing, exact-SHA receipts, circuit breakers, crash recovery, global
merge exclusion, or the localhost-only GET observer.
