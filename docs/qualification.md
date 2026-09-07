# Durable fixture observation

`scripts/qualification.ts` records one explicit fixture vault at a time. It does
not install, start, or schedule anything. A caller must separately authorize any
observation and invoke each sample. Owner estate and human-use qualification are
not implemented by this harness and are always reported `not-observed`;
`release_qualified` is always false. Seven days of fixtures do not establish real
estate or human-use evidence. The [current readiness decision](decision-log.md#owner-amendment-to-readiness-2026-09-05)
supersedes seven- and fourteen-day calendar gates; this observer remains an
optional post-readiness diagnostic with its historical timing contract unchanged.

Create a scope file for a synthetic vault only:

```json
{"scope":"fixture","vault":"/absolute/synthetic-vault","brief_hour":7,"timezone":"UTC","supervisor":"none"}
```

The vault must already have all seven enabled rails with initialized due dates.
Its configured `brief_hour` must match the scope. This harness accepts only
explicit UTC fixture timing and a supervisor-none policy. It does not interpret
UTC as the owner's local morning, implement DST scheduling, or collect evidence
from a real supervisor. Non-UTC and supervised scopes are refused. Status always
reports `owner_morning: unqualified`, `supervised_pilot: unqualified`, and
`rail_qualification: fixture-only`; this is not full issue #403 qualification. The artifact directory must
contain `kizuki`, `kizuki-mcp`, `README.txt`, `BUILD.json`, and `SHA256SUMS`; the
proof must be a complete, passing artifact receipt for that exact source
SHA, target, Bun version and package hashes, with the exact ordered commands.
Historical `kizuki.artifact-proof/v1` has fourteen steps and supplies no engine
credit. V2 adds the copied CLI/MCP observations and two engine steps; its engine
identities must pass the shared qualification policy. Neither version changes
the observer's fixture-only scope. Artifact
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
an append to the report. The frozen sampling cadence is thirty seconds, with a maximum collection gap
of sixty seconds; the collector does not run itself. Its fixed profile allows thirty seconds of rail
lateness plus that rail's configured jitter. Those bounds are fixture observation
policy, not a redefinition of production SLA or acceptance tolerances.

The report binds each automatic run ID and canonical receipt-content hash to a daemon instance,
PID and boot ID. Scheduled non-brief due slots advance from the previous intended slot
plus its period, never from a late finish. Brief slots advance to the next
declared UTC hour from the original due time. Missed slots remain failures. The current structured `serve.pid` marker and writer lease must
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

`manifest.json` contains a random qualification ID, frozen canonical policy
digest, start clock anchors, artifact identity, and the closed fixture policy.
Init exclusively writes and fsyncs `genesis.json`, binding that ID, policy digest,
canonical manifest hash, and manifest file device/inode before any sample.
Every load validates schema keys and that binding. An edited or replaced
manifest cannot silently become a new root before sample one. The sample chain
starts at the genesis hash. Earlier unanchored reports are retained as historical
artifacts; continuing them requires a new observation, without carried credit.

`samples.jsonl` is
an fsynced hash chain containing only timestamps, run hashes/IDs, rail health and
process identity. Raw errors, model references, prompts and source content are
not copied. Receipt digests normalize known omitted defaults and JSON object key order;
semantic counters, health, timestamps, execution identity, schedule intent and
errors remain bound. Unknown execution fields and malformed counters are refused.
This preserves already captured receipt evidence when the existing
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
against an administrator rewriting all evidence, including both the manifest
and genesis before sample one. SQLite, JSONL and process reads
are not one atomic snapshot; racing or missing evidence conservatively interrupts.

Limits are explicit: 64 MiB and 100000 rows for each journal, 256 MiB per artifact,
1 MiB for the proof, and 16 KiB for the scope. Oversized evidence is refused before
it can supply credit. No performance claim is made for repeated artifact hashing.
Operational retention and service configuration are unchanged. New operational
receipts journal a content-free schedule transition before receipt append. The
receipt row and expected-due compare-and-advance commit in one SQLite transaction;
JSONL recovery applies missing transitions exactly once and rejects conflicting
policy or due boundaries. Legacy receipts without transition intent remain
readable but cannot reconstruct missing schedule changes. Artifact observations
must use a reviewed build containing the execution identity and daemon marker
changes; older receipts remain operationally readable but cannot qualify here.

Focused verification:

```sh
bun test packages/core/test/serve/execution-identity.test.ts packages/core/test/serve/qualification.test.ts scripts/qualification.test.ts packages/core/test/index.test.ts
bun run typecheck
```

The fixture observer accepts only the native `DEFAULT_RAILS` period and jitter
policy. Each initial due slot must be no later than one supported period after
observation start, and no earlier than its already documented lateness allowance.
Future schedules cannot replace automatic-run evidence. Synthetic boundary tests
use those same cadences; they supply no real elapsed-time qualification credit.

Before retaining receipt projections, the collector requires native uppercase
ULID run IDs and canonical lowercase version-4 UUID instance/boot IDs. Invalid
identifier values and extra execution fields are refused without copying them
into samples. Operational readers retain their historical compatibility.
Recovery refuses a malformed existing same-ID receipt inside the receipt/schedule
transaction, preserving both its original row and due boundary for investigation.

At the exact seven-day boundary, completion also requires receipts for every
slot due on or before that boundary. `pending_boundary_rails` names obligations
still outstanding. Time remaining can be zero while status remains
`awaiting-observation`: receipts may arrive within the existing lateness allowance.
Missing that allowance interrupts credit; a clock boundary alone is never a
completed rail run.
