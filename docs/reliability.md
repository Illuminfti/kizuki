# Crash recovery checks

`scripts/chaos/` runs real Bun children against disposable synthetic vaults.
It sends SIGKILL after the child announces the operation has started, with a
delay drawn from an unsigned seeded generator. It does not signal the daemon,
use an existing vault, install a service, resolve credentials, or call a network
endpoint. The model fixture returns typed synthetic decisions in process.

## Running it

The small mode runs two trials per operation; the local mode runs one thousand.
Use the repository's pinned Bun version. On a shared machine, prefix these
commands with the machine's `ktest` semaphore.

```sh
bun scripts/chaos/run.ts --ci --seed 17
bun scripts/chaos/run.ts --local --seed 17
bun scripts/chaos/run.ts --operation purge --trials 2000 --seed 42
bun scripts/chaos/run.ts --operation canon --trials 100 --max-delay-ms 10
```

Operations are `capture`, `extraction`, `canon`, `correction`, `undo`, `purge`,
`export`, `backup`, `restore`, `restore-snapshot`, and `rebuild`. Restore trials
start from a verified portable export or snapshot. Each trial starts from a
fresh vault with independent committed evidence and a receipted page that the
operation must preserve. Canon trials begin with filed model claims; extraction
trials run the foreground daemon's sync pass with an in-process model producer. Correction
uses an explicit claim target and undo uses its receipt. Restart advances the
injected daemon clock by 31 seconds to exercise the dead-PID lease reclaim rule
without waiting through its heartbeat grace; process identity and SIGKILL are real.

Each killed child is reaped before a new child opens the vault. The new child
attempts canon recovery, runs one foreground serve pass including sync,
retrieval sweep, purge sweep, and doctor sweep, and checks the result. It uses
the CLI's ordinary incremental index catch-up as the refresh hook. Checks run
before a full rebuild so rebuilding cannot hide a broken incremental result.

The checks cover SQLite full integrity and current schema validation; vault and
runtime doctor; pending canon, projection, extraction and purge work; receipt
journal IDs and payloads; current file and archive hashes; unreceipted pages
and remaining canon stages; independent committed evidence, claims, receipts
and bytes; committed event preservation; and per-receipt purge absence proofs.
The complete lexical-floor document and graph rows must equal their full
rebuild. Published export and snapshot artifacts must pass their verifiers;
published restored vaults must pass the same integrity checks.

Stdout is a `kizuki.chaos/v1` JSON receipt. Stderr records operation, trial,
chosen delay, actual SIGKILL versus completion, and the fixed failure code.
Exit 0 requires no failed invariants and at least one actual interrupted trial
for every selected operation. Exit 1 means a failure or missing crash coverage;
exit 2 means invalid arguments. A fast operation may finish before the signal:
that trial is reported as completed and does not count as crash evidence.
Use a smaller delay window or more trials if an operation received no kill.

Successful trial vaults are removed. Failures stay beneath a private directory
in the system temporary directory, or the directory named by `--artifacts`.
It holds only generated fixtures and local diagnostics; do not commit it. Every
child has a bounded deadline and is killed and reaped on timeout. The seed
reproduces selected delays, not OS scheduling or generated IDs. Use a fixed
boundary regression to reproduce a specific state transition.

## Current limits

This is sampled process-death evidence, not a proof of every instruction or
power-loss durability. It covers the SQLite lexical floor and the v1 claim
writer. It does not qualify the optional embedded retrieval engine, typed
world-claim writes, native provider sync, disk-full errors, or hardware failure.
An interrupted export, backup, or restore can leave an unpublished private
`.partial` directory beside its destination; it is counted in the trial report,
never opened as a vault, and removed with the synthetic trial. Runtime recovery
does not claim to collect such artifacts outside the vault.

Automatic recovery of unknown retrieval execution remains incomplete. The
deterministic `projection-started` regression mutates a real FTS5 retrieval
store, sends SIGKILL before its acknowledgment, restarts, attempts recovery,
and runs a serve pass. The operation remains held with `canon_recovery_needed`.
This matches the existing [canon recovery contract](canon-write-recovery.md):
an operation in `started` has an unknown outcome even after a local lease is
reacquired. Replaying it without a fenced store-generation contract would
weaken the fail-closed guarantee. A passing characterization test and a skipped
acceptance test name this defect in `scripts/chaos/harness.test.ts`.

Until that contract is implemented and the skipped acceptance passes, this
workstream does **not** establish universal automatic recovery after SIGKILL.
The random floor trials do not bind an external retrieval port; the real
retrieval mutation is covered by the deterministic hold reproduction.

## CI

`scripts/chaos/harness.test.ts` is discovered by the existing Bun test gate.
It runs one short seeded trial per operation, checks actual signal delivery,
tests argument bounds and seed repeatability, and reproduces the retrieval
hold. The skipped acceptance is an explicit unresolved recovery requirement,
not a passing crash-recovery claim. Focused verification is:

```sh
bun test scripts/chaos/harness.test.ts --timeout 120000
```

See also [extraction recovery](extraction-recovery.md),
[canon recovery](canon-write-recovery.md), and
[portable connection restore](portable-connection-restore.md).
