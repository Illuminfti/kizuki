# Durable fixture observation

`scripts/qualification.ts` records one explicit fixture vault at a time. It does
not install, start, or schedule anything. A caller must separately authorize any
observation and invoke each sample. Owner estate and human-use qualification are
not implemented by this harness and are always reported `not-observed`;
`release_qualified` is always false. Seven days of fixtures do not satisfy the
estate shadow, owner review, normal-week usefulness, or retirement inventory gates.

Create a scope file for a synthetic vault only:

```json
{"scope":"fixture","vault":"/absolute/synthetic-vault","brief_hour":7}
```

The vault must already have all seven enabled rails with initialized due dates.
Its configured `brief_hour` must match the scope. The artifact directory must
contain `kizuki`, `kizuki-mcp`, `README.txt`, `BUILD.json`, and `SHA256SUMS`; the
proof must be a passing `kizuki.artifact-proof/v1` receipt for that exact source
SHA, target, and binary hash with all fourteen required proof steps. Artifact
checksums, BUILD bytes, and proof bytes are checked and bound into the manifest.
These are local evidence integrity checks, not independent signatures or proof
that an operator's declaration of fixture scope is true.

```sh
bun scripts/qualification.ts init --artifact /absolute/artifact --proof /absolute/proof/receipt.json --scope /absolute/scope.json --out /absolute/new-report
bun scripts/qualification.ts sample --run /absolute/new-report
bun scripts/qualification.ts status --run /absolute/new-report
```

Every command emits JSON. There are no clock, elapsed-time, or backdate flags.
`init` creates a new private report directory; it refuses an existing destination.
`sample` is a single read-only collection from the explicitly selected vault plus
an append to the report. Invoke samples more frequently than sixty seconds; the
collector does not run itself. Its fixed profile allows thirty seconds of rail
lateness plus that rail's configured jitter. Those bounds are fixture observation
policy, not a redefinition of production SLA or acceptance tolerances.

The report binds each automatic run ID and raw receipt hash to a daemon instance,
PID and boot ID. The current structured `serve.pid` marker and writer lease must
agree. On Linux the collector hashes `/proc/PID/exe` and checks the kernel process
start ticks before and after that read against the pinned artifact. Manual,
`serve --once`, legacy, unknown-usage, failed and degraded receipts cannot fill
healthy automatic due slots. A process restart is recorded; receipts from a
process that disappeared before collection remain unbound and interrupt the
window. Sampling before an intentional stop avoids losing its final receipts;
this harness does not claim supervised restart recovery has been qualified.

Linux boot uptime supplies a monotonic anchor across observer subprocesses;
actual UTC is recorded alongside it. A reboot, backward time, wall/uptime
mismatch over five seconds, collection gap, altered profile, or missed due slot
interrupts the run. `status` reports the last observed time and whether collection
is current; it never advances credited time. Only 604800000 milliseconds with
complete recorded coverage can produce `fixture-window-complete`. Synthetic
boundary tests exercise this calculation without supplying observation credit.

`manifest.json` is the immutable profile and identity anchor. `samples.jsonl` is
an fsynced hash chain containing only timestamps, run hashes/IDs, rail health and
process identity. Raw errors, model references, prompts and source content are
not copied. This preserves already captured receipt evidence when the existing
seven-day operational journal prunes it. Uncaptured intervals receive no credit.
Corrupt source evidence leaves a durable `collection-rejected` interruption.
Torn or conflicting report evidence is refused. Start a new report after an
interruption; rewriting a report is not a supported recovery method.

Files are created exclusively with mode 0600, directories with 0700, and parent
directories are fsynced. User-controlled symlink paths are refused. A report lock
serializes sample writers; a lock left by a crashed collector is not automatically
reclaimed. The existing report can still be inspected, but continuing that
observation requires explicit operator investigation rather than silent repair.
The threat model trusts the local host/operator: the hash chain is not protection
against an administrator rewriting all evidence. SQLite, JSONL and process reads
are not one atomic snapshot; racing or missing evidence conservatively interrupts.

Limits are explicit: 64 MiB and 100000 rows for each journal, 256 MiB per artifact,
1 MiB for the proof, and 16 KiB for the scope. Oversized evidence is refused before
it can supply credit. No performance claim is made for repeated artifact hashing.
Existing operational retention and services are unchanged. Artifact observations
must use a reviewed build containing the execution identity and daemon marker
changes; older receipts remain operationally readable but cannot qualify here.

Focused verification:

```sh
bun test packages/core/test/serve/execution-identity.test.ts packages/core/test/serve/qualification.test.ts scripts/qualification.test.ts packages/core/test/index.test.ts
bun run typecheck
```
