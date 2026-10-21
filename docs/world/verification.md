# World verification

Run the growing, offline world gate from the repository root with the pinned Bun version:

```bash
bun run verify:world
```

It checks the oracle registry and runs its bound tests alongside the operation,
privacy, purge, resource and interface matrices. A nonzero exit means a gate
failed. The normal repository verification checks the registry and executes
these test files in its full suite.

## Regression controls

Every registered operation must have an explicit scenario. The current matrix
compares response bytes, refusal details, SQL statements/rows and projection
work across all seven hidden mutations. It exercises real source grants and
claim admission, retained references after purge, and allowed reads before
erasure. A deliberately leaky global-count query proves the checker detects a
leak. To demonstrate the failing command boundary:

```bash
bun run verify:world --inject-leak
```

That command must exit nonzero. It uses only temporary synthetic data. There is
no network or production model call.

The parity matrix calls Core, real CLI text and JSON processes, real stdio MCP,
loopback HTTP and the App model for every operation. Only freshly issued,
grammar-checked view, snapshot and sharing capabilities and their expiries are
normalized; evidence, attribution and history contents remain exact.

The scale fixture admits at least 5,000 real claims through the shared writer.
It checks response bytes, verified candidates, examined rows and parsed support
bytes. An overflow must be qualified, not presented as a complete card. These
are work and allocation limits, not latency promises. The existing projection
allows 128 candidates plus an overflow sentinel, 256 KiB output and a separate
2 MiB parsed-support limit. Edge-walk limits have their own identity tests.

## Adding a capability

Add public-operation inputs to `packages/core/test/helpers/world-verification.ts`
and CLI arguments/text checks to the parity test. Missing cases fail the gate.
Bind real oracle fixtures in `rfcs/fixtures/status.ts` and add newly executable
unit identities to `ORACLE_COVERAGE_FLOOR` in `scripts/world-verify/registry.ts`.
Removing an identity from executable coverage fails even if another is added.
An executable entry pointing to a missing or unrelated test also fails.

`--registry-only` checks these registrations without running the tests. Its
result proves registration only.

## Evidence limits

This harness does not establish production activation or authorize model
egress. [Held-out extraction qualification](qualification.md) has a separate
real-model runner and exact-artifact review gate. Its offline scorer tests do
not qualify a kind. The complete longitudinal/golden journeys also have
separate acceptance requirements. Newly registered extraction kinds and
changed offered predicates fail the registry gate without reviewed held-out
evidence. The explicit pre-existing compatibility baseline is unqualified.

## Stored-state audit

Use a restored, offline copy with no SQLite WAL, SHM or rollback-journal files:

```bash
kizuki verify world --vault /absolute/offline-copy
kizuki verify world --vault /absolute/offline-copy --json
```

The explicit absolute path is required; this command never chooses the live
default vault. Do not delete sidecars to make a live copy pass. Stop the copy's
writers and use the supported backup/restore path to obtain a consistent,
checkpointed database.

The command opens SQLite in immutable, read-only mode after validating custody.
It prints PASS or FAIL for the current ledger schema, SQLite integrity and event
sample, world admission/provenance closure, and historical clock/claim coverage.
Every world admission is checked; the general event check uses the existing
bounded ledger-health sample. Missing or invalid custody, sidecars, and a file
changed during inspection fail closed. It does not repair, migrate, create an
audit row, contact a model, or print captured records. CLI regression tests
compare all vault files and metadata before and after both text and JSON reads.
This is a stored-state audit, not proof of semantic correctness or live
connector authorization; those require the other executable journeys.

The daemon's `verify-world` rail runs the same stored-state checks weekly in a
consistent database read transaction. Its normal run receipt records success
or the failed check names. Doctor shows the last result and its age in seconds.
The newest verification receipt survives journal retention, so a late or failed
check cannot disappear at the seven-day boundary. The rail writes its receipt;
the copied-vault command performs no writes.

Retention also preserves the newest ordinary run receipt. If those two
mandatory records exceed the configured byte cap, only those two may exceed it;
older ordinary receipts are still removed. This extends the existing exception
for a single oversized newest receipt by one verification record.
