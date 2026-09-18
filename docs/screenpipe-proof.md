# Copied-package local-source proof

Screenpipe is the one connector in the frozen C3 catalogue whose acceptance
evidence class is `local-source`: an offline, read-only sweep of a *stopped*
screenpipe SQLite database. It needs no account, no token and no network, so it
can be proved here — unlike the six live-account obligations, which stay unmet.

Build and prove one package, then run the local-source proof against those bytes:

```sh
bun run build:release
bun run smoke:release
bun run proof:artifact -- --report /tmp/kizuki-artifact-proof
bun scripts/screenpipe-proof.ts --artifact dist/kizuki-0.1.0/bun-linux-x64-baseline --artifact-proof /tmp/kizuki-artifact-proof/receipt.json --report /tmp/kizuki-screenpipe-proof
```

Use the matching native target directory on macOS. The harness shares the
file-import proof's custody discipline: the source checkout must be clean at the
package's exact source revision, the seven-file Build V2 package and artifact
proof V3 are verified, the package is copied outside its checkout, and both
copies are rechecked after every command.

## What it observes

`scripts/screenpipe-proof-fixtures.ts` writes three synthetic databases. The
provider schema comes from the connector package's own testkit; the rows are this
proof's own, low-entropy and meaningless. The valid database holds two settled
frames and one audio transcription, so a complete sweep must store exactly three
private events, each with connector provenance and a distinct sentinel.

The proof then drives the public CLI end to end: `init`, `connect screenpipe
--source DB`, `connect grant`, `backfill`, ledger `query`, `export`, a repeated
`backfill`, `sync`, a repeated `query`, `connect status`, `connect revoke`, an
absence query, `connect resume-revocation`, a purged-absence query, the purged
`connect status`, and a final `backfill` that must be refused for want of consent.
A repeated `backfill` must store nothing and duplicate nothing: both snapshot
watermarks are already consumed. The incremental `sync` re-presents the same
three settled rows once and must store nothing while recording three duplicates,
which is what an append-only ledger recognising known evidence looks like. Query
identities must be unchanged across the repeat.

One frame carries a browser URL whose path segment has the credential shape the
connector documents. The exported ledger is read back from `export`: that segment
must appear in no event, and the connector's `[redacted]` marker must record that
it was dropped.

## What it refuses

- A **locked** database — the shape a still-running screenpipe presents — must be
  refused with the connector's own `database is locked` message. Reading it would
  tear state, and screenpipe's operating guide prohibits external SQLite clients
  on the live database.
- A database **below the supported migration floor** must be refused with
  `schema older than supported`.
- A **malformed** database, whose capture tables do not match the declared column
  contract, must be refused with `schema mismatch: missing …` before a single
  event is stored. `connect status` must then show no connection at all.

Every expected nonzero exit is checked explicitly; unexpected output, counts or
missing steps fail the proof rather than receiving success credit. The harness
binds no socket.

## Receipts

`receipt.json` uses `kizuki.screenpipe-fixture-proof/v1` and is diagnostic only:
it binds the source revision, producer files, package hashes, upstream artifact
proof, every fixture database hash and the per-step exit codes with stdout and
stderr digests. Captured text is never retained; on failure the private
`synthetic-diagnostics.json` holds bounded output from these generated inputs.

`connector-evidence/screenpipe.json` is the acceptance receipt:
`kizuki.connector-evidence/v1` with `evidence_class: "local-source"`, credited
only when every step passed. `connector-evidence/index.json` records the observed
row counts and the connector's own documented limits beside it, and names any
blocker in `unresolved`.

Verification: `bun test scripts/screenpipe-proof.test.ts` checks the fixture
inventory, the refusal messages and the observation oracles against the connector
itself. Actual usability requires running the harness against the compiled
package.
