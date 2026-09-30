# Crash recovery checks

`scripts/chaos/` runs real Bun children against disposable synthetic vaults.
It sends SIGKILL after the child announces the operation has started, with a
delay drawn from an unsigned seeded generator. Only harness-owned children
receive a signal. It does not use an existing vault, install a service, resolve
credentials, or call a network endpoint. The model fixture returns synthetic
decisions in process.

## Running it

The small mode runs two trials per operation with delays from zero to four
milliseconds; the local mode runs one thousand with delays up to 100 milliseconds.
`--max-delay-ms` accepts windows up to 1000 milliseconds for slower operations.
Use the repository's pinned Bun version. On a shared machine, prefix these
commands with the machine's `ktest` semaphore.

```sh
bun scripts/chaos/run.ts --ci --seed 17
bun scripts/chaos/run.ts --local --seed 17
bun scripts/chaos/run.ts --operation purge --trials 2000 --seed 42
bun scripts/chaos/run.ts --operation canon --trials 100 --max-delay-ms 10
```

Operations are `capture`, `extraction`, `canon`, `correction`, `undo`, `purge`,
`typed-canon`, `typed-correction`, `typed-undo`, `typed-purge`, `export`, `backup`,
`restore`, `restore-snapshot`, `rebuild`, and `retrieval-rebuild`. Restore trials
start from a verified portable export or snapshot. Each trial starts from a
fresh vault with independent committed evidence and a receipted page that the
operation must preserve. Canon trials begin with filed model claims; extraction
trials run the foreground daemon's sync pass with an in-process model producer. Correction
uses an explicit claim target and undo uses its receipt. Restart advances the
injected daemon clock by 31 seconds to exercise the dead-PID lease reclaim rule
without waiting through its heartbeat grace; process identity and SIGKILL are real.
Typed trials admit source-bound assertions with synthetic grants through the
ordinary claim API, then use the same receipted writer, correction and undo
APIs as legacy claims. Ordinary canon, correction, undo and purge trials bind
the native FTS5 port on both the write and recovery paths. `retrieval-rebuild`
exercises its atomic authoritative rebuild separately from the SQLite floor.

Each killed child is reaped before a new child opens the vault. The new child
attempts canon recovery, runs one foreground serve pass including sync,
retrieval sweep, purge sweep, and doctor sweep, and checks the result. It uses
the CLI's ordinary incremental index catch-up as the refresh hook. Checks run
before a full rebuild so rebuilding cannot hide a broken incremental result.

The checks cover SQLite full integrity and current schema validation; vault and
runtime doctor; pending canon, projection, extraction and purge work; receipt
journal IDs and payloads; current file and archive hashes; unreceipted pages
and remaining canon stages; independent committed evidence, claims, receipts
and bytes; every baseline event, claim, receipt and file outside the operation's
explicit targets whose calls have begun; immutable fields of every baseline
claim, including active targets; receipted lifecycle transitions and purge
erasure; typed support integrity and preservation; and per-receipt
purge absence proofs. A purge with any committed deletion must have deleted
every selected event and retained a receipt for each one.
The complete lexical-floor document and graph rows must equal their full
rebuild. Published export and snapshot artifacts must pass their verifiers;
published restored vaults must pass the same integrity and baseline checks.
Published exports and backups are also restored to another temporary vault and
compared to that baseline. Portable restore can regenerate an empty legacy
content signature; the oracle checks the exact expected signature using the
existing core hash contract. Every other claim field and all snapshot rows
remain exact. All native FTS5 trials compare complete hits,
scores, snippets and trust labels for two fixture queries before and after a
second rebuild. Native rebuild trials also compare with the pre-crash result.

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

The separate `acknowledged` boundary regression kills a child after its first
capture, legacy or typed canon write, correction, or undo returns and records its acknowledgment,
before the next write begins. Complete acknowledgments include exact event or
claim rows, so restart must preserve the returned payload as well as its ID.
The same boundary checks completed portable exports,
snapshot backups and both restores after their API returns. These tests ensure
that published outputs are validated even when short random delays otherwise
interrupt every attempt before publication.

Two more fixed cuts supplement timing samples. `extraction-journaled` kills
after a real producer decision is durably journaled, before filing. Restart
must file its saved claims without asking the producer for those inputs again.
`purge-admitted` stops the child inside the existing synchronous purge recovery
hook after phase one commits, then the parent sends SIGKILL. Restart must
complete the legacy or typed purge and prove absence for every selected event.
These cuts are test APIs in `runCampaign`, not additional product commands.

The typed purge cut exposed a projection-order defect: erasure refreshed the
graph while its completed write intent still held the deleted page, removing
unrelated edges until rebuild. Completion now clears that intent inside the
same transaction before refreshing. The core regression checks unrelated
edges before rebuild and verifies that a failed projection rolls back intent
completion and remains recoverable.

## Current limits

This is sampled process-death evidence, not a proof of every instruction or
power-loss durability. It covers legacy and typed canon operations, the SQLite
lexical floor, and native FTS5 rebuild. It does not qualify the optional embedded
retrieval engine, every typed extraction variant, native provider sync,
disk-full errors, or hardware failure. The thousand-trial local mode is an
available stress runner; a small passing campaign does not qualify that larger run.
An interrupted export, backup, or restore can leave an unpublished private
`.partial` directory beside its destination; it is counted in the trial report,
never opened as a vault, and removed with the synthetic trial. Runtime recovery
does not claim to collect such artifacts outside the vault.

The deterministic `projection-started` regression mutates a real native FTS5
store, sends SIGKILL before acknowledgment, restarts, recovers and runs a serve
pass. Recovery uses the port's opt-in `mutation-fence/v1` guarantee to prove
prior execution cannot publish later. It then revalidates source permission,
receipt and file state before idempotent reconciliation. See the
[canon recovery contract](canon-write-recovery.md). Ports without a mutation
fence still refuse unknown-execution replay; a local caller lease alone does
not establish that guarantee.

## CI

`scripts/chaos/harness.test.ts` is discovered by the existing Bun test gate.
It runs one short seeded trial per operation, checks actual signal delivery,
tests argument bounds and seed repeatability, and verifies fenced retrieval
recovery. Eleven fixed cuts check preservation of acknowledged writes and artifacts; journaling
and purge cuts exercise their committed recovery state. Negative oracle tests
check changed independent bytes and committed claims, missing doctrine,
insecure control files, both actual canon staging filename forms, illegal
active-target mutations, missing derived rows, and a damaged published restore.
Focused verification is:

```sh
bun test scripts/chaos/harness.test.ts --timeout 120000
```

See also [extraction recovery](extraction-recovery.md),
[canon recovery](canon-write-recovery.md), and
[portable connection restore](portable-connection-restore.md).
