# Canon write recovery

Ordinary canon writes, ordinary purge rewrites and undo use the v21 recovery
ledger. The existing source-erasure protocol remains separate. A successful
canon receipt records the page and claim transition; its `retrieval_ops` list
records projection work. It does not prove that an external engine executed
those operations. For an ordinary purge rewrite, its local FTS5 removal references
follow the purge coordinator's separate absence proof; recovery rebuilds the
surviving local projection without scheduling another external deletion.

## Durable admission and completion

The writer first acquires the vault mutation lease and a descriptor-held receipt
stream. It validates the complete receipt prefix before charging a budget,
committing an intent or writing page bytes. Admission requires a top-level SQL
transaction, so an enclosing caller cannot roll back the intent after publishing
bytes. Only one ordinary intent can be active across the vault's shared log.

The closed intent binds the original receipt, exact preimage and postimage,
claim state, event and source-grant state, policy epoch, page index, predecessor,
archive and deterministic staging paths, and the receipt stream checkpoint.
Each image is at most 1 MiB; the entire record is at most 8 MiB. Identity
collections are bounded to 32,768 entries within that aggregate limit.

Completion holds an immediate SQL transaction across synchronous authority
checks, native file publication, receipt reconciliation and all receipt, claim
and index updates. External engine calls occur afterward. An interrupted
completion leaves its original intent committed. `recoverCanonWrites` may finish
that exact transition only while every saved authority and image check holds.
It never creates a replacement receipt ID or another budget charge.

An exact published postimage does not override a revoked source, changed claim,
changed predecessor or changed archive. Such cases preserve the pending intent
and return `canon_recovery_needed`. The monotonic canon read generation advances
when an intent is admitted and when its hold is durably cleared.

## Custody and stage reconciliation

A checkpoint permits only the unchanged receipt prefix and an absent, complete
or exact partial tail of the saved receipt. Recovery may append its missing
suffix. Extra lines, conflicting bytes or changed file or directory custody are
preserved and refused.

A staging name alone does not prove that recovery created its inode, so
recovery never adopts a stage. It reconciles each stage the durable intent
names against the images that digest-checked intent holds, then republishes
from the intent's own bytes:

| Stage contents | Classification | Action |
| --- | --- | --- |
| Byte-identical to an intent image | `exact` | Removed; the intent holds the bytes |
| A strict prefix of an intent image, including empty (a torn write) | `prefix` | Removed; the intent holds the bytes |
| Any other bytes | `foreign` | Moved without replacing to `.kizuki/quarantine/canon-stage/<receipt_id>/` (directory 0700, file 0600); never deleted |
| Symlink, directory, hardlink, foreign owner, writable or oversize entry | `unsafe` | Left untouched; the write holds with `stage_custody_unknown` |

The live stage is compared with the after-image and, for a withdrawal
rollback, the before-image; the archive stage with the before-image. Each
removal or move is appended and fsynced to the versioned
`kizuki.canon-stage-recovery/v1` log at `.kizuki/receipts/stage-recoveries.jsonl`
before it happens. `recover --json` returns the records of the run, and
`doctor --json` shows each stage's classification and next-start action
without touching it. Source withdrawal runs the same reconciliation.

Recovery also checks the saved receipt checkpoint's custody before any stage
or page action. A vault copied or restored at file level while a write was
pending refuses with `receipt_stream_changed` and changes nothing; recover at
the original location, or restore from `kizuki export`, which refuses while
recovery is pending.

Recovery can inspect an exact existing archive as input; it cannot adopt or
overwrite that archive. Historical unrecorded pages cannot acquire a synthetic
recovery receipt.

## Held writes and the service

Every refusal at the recovery boundary is a typed `CanonRecoveryError`:
writer refusals map to `stage_custody_unknown`, `page_changed`,
`archive_changed` or `write_refused`, and receipt-stream refusals to
`receipt_stream_changed` or `receipt_stream_refused`. A held write blocks only
new canon writes. The daemon logs one `canon_recovery_held` JSON line per
attempt and keeps serving reads, HTTP, connector ingest and the rails that do
not write canon; the sync rail stops with `recovery:held`. The last attempt's
reason and count are kept in `.kizuki/canon-recovery-hold.json` for doctor,
which names one next step derived from the reason and stage classification.

The systemd unit bounds restarts with `StartLimitIntervalSec=900` and
`StartLimitBurst=5`. Deliberate startup refusals, custody and an older sealed
ledger that needs `kizuki init <vault> --no-default`, exit 78, and
`RestartPreventExitStatus=78` keeps the supervisor from restarting them.

## Projection completion

The canon transaction commits a source-associated projection obligation before
any external await. Local search and graph replacement run in one synchronous
SQL transaction. A failed replacement retains both the old projection and its
hold. A successful replacement clears the hold only when all external
obligations are also acknowledged.

Each external operation has one durable state:

| State | Meaning | Recovery behavior |
| --- | --- | --- |
| `scheduled` | No execution attempt has started | May execute with the matching configured store and current source permission |
| `started` | An attempt began; its outcome may be unknown | Remains held; automatic retry and successor writes are refused |
| `acknowledged` | The port reported success and all continuation checks passed | May finish the remaining projection work and clear its hold |

The writer commits `started` before calling an engine. It acknowledges an upsert
using the port's exact one-document processed count, or a removal using the
processed count and exact absence proof. It then rechecks the source policy,
page bytes, receipt, store identity and read generation before acknowledging the
same obligation by digest. A lost response, thrown operation or process death
does not prove that an old write can no longer arrive.

Version 1 provides no local-engine exception to the unknown-outcome rule. Even a
newly acquired local engine lease leaves a previously `started` operation held.
This limit is deliberate and must be reported as pending, not as a universal
automatic recovery guarantee.

`retryCanonProjectionObligations` resumes known scheduled work. Undo first tries
to settle prior work on its page and refuses a successor while that work remains
pending. If undo's own canon transition commits but its external projection
cannot complete, its result includes `projection_pending: true`; the receipt,
archive and claim lifecycle stay durably bound to that one undo.

## Owner commands and source withdrawal

`kizuki recover --json` attempts the original write and known scheduled projection
work. It exits unsuccessfully while completion fails or any hold remains.
`kizuki doctor` reports pending recovery. Correction and undo also return an
unsuccessful result when their completion is unconfirmed. App operation results
retain only the affected receipt IDs and phases, without page paths or content.
An unrelated global hold is reported without identifying its receipt or page.

Source withdrawal may erase its exact source-bound pending write under current
denial and file custody. When a failed joint write replaced an independent
committed page, withdrawal restores that exact preimage only after rechecking
its current source permission, supporting claims and predecessor state. This
rollback does not complete the withdrawn write or mint a positive receipt.
A pending revert is not an uncommitted write: if its postimage is an
independent survivor, withdrawal rewrites the live page to those bytes, keeps
the revert intent, and reports the recovery hold rather than deleting the
survivor or completing under withdrawn derive authority. Completing that hold
into source-erasure lineage remains a dependency of the purge-binding schema.
If rollback publishes the preimage but intent deletion fails, every retry
rechecks that same authority before clearing the hold, even when no file move
is needed. Changed authority preserves the bytes and the pending intent.
It preserves unrelated bytes and refuses changed pages,
unknown stages or unknown external execution. Cancelling scheduled or acknowledged
projection work retains the inventory of real store instances for the existing
source-erasure protocol. A port descriptor alone cannot establish store absence.
Clean export refuses both write and projection holds. Serving checks a monotonic
canon generation so a cached page or awaited result cannot cross a recovery change.

## Verification

`packages/core/test/canon/crash-recovery.test.ts` exercises real process exits
before staging, after staging, after archive or live publication, and before
receipt-row completion. It checks exact replay, unknown-stage preservation,
receipt tail custody, one budget charge, source and claim changes, transaction
rollback, local projection rollback, real FTS5 retrieval and trust labels, and
unknown engine execution after child death. The receipt-stream and staged
publication tests separately exercise native file and log custody failures.

`packages/core/test/canon/recovery-boundaries.test.ts` covers cached and awaited
reads, clean export refusal and v21 restore, and source withdrawal with an actual
FTS5 engine. `packages/cli/test/recovery-public.test.ts` checks actual owner
commands and authenticated App correction and undo outcomes. Native CI runs these
consumers with the file and receipt recovery tests. Passing component tests alone
does not establish installed-service or full release qualification.
