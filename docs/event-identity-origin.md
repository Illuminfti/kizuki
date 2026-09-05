# Event identity and origin

Evidence date: 5 September 2026. This describes ledger schema 16 and backup
format `kizuki.backup/v2`. Release acceptance requires the separate checks in
[release-acceptance.md](release-acceptance.md).

## Accepted revisions

Connector input remains `kizuki.event/v1`. Core supplies `event_id`,
`content_hash`, `content_hash_version`, `text_hash` and `origin`; input carrying
any of these fields is rejected.

New events use SHA-256 over the UTF-8 prefix `kizuki.event-revision/v2\0`
(where `\0` is one NUL byte) and canonical JSON. The JSON includes connector,
source record, kind, occurrence time, text, subjects, deletion state, metadata,
the effective accepted sensitivity hint and attachment references. A missing
hint is `null`. Attachments are ordered by attachment ID and include every
defined contract field; absence remains distinct from empty filenames and
zero byte sizes. Object keys are sorted. Subject and metadata array order
retain their existing meaning. Observation time is excluded.

A sensitivity or attachment change therefore creates a new revision. Merely
reordering attachment references or observing the same record again does not.
Historical version-1 payloads, IDs, timestamps and content hashes remain
unchanged. An unchanged retry of a version-1 record deduplicates only when its
complete version-2 representation is equal. Old labels are never rewritten.

The existing unique key remains `(connector_id, source_record_id, content_hash)`.
Two enrolled source keys that collide on that key still require the existing
source-binding check; this migration does not introduce source-scoped identity.

## Exact machine bytes

`text_hash` is plain SHA-256 of accepted UTF-8 text, without trimming or Unicode
normalization. Core marks an event `self` when its text contains
`KIZUKI CONTEXT v1`, or when its nonempty text hash matches a retained loop
receipt's before/after bytes or a pending machine-byte intent. Empty-file
absence sentinels do not classify ordinary empty captures as self.

Before publishing a loop file or archive, the writer commits a minimal byte
intent and its final source/evidence admission check in one top-level SQLite
transaction. The intent records the receipt ID and exact before/after hashes.
A matching completed receipt consumes it atomically. Failed or crashed writes
retain the intent conservatively; an intent alone grants no completed-write
or budget credit. A loop write inside a caller-owned transaction is refused
because its byte intent could not be durable before publication.

Origin can become `self` when later byte evidence appears. It stays self even
if a registry entry is later removed. This annotation never changes the
accepted payload or revision hash. Native owner corrections have a separate
internal proof, committed with the captured statement. The proof must match
the event hash, observation time and owner connector and have no managed
source binding. A connector label or metadata value cannot issue this proof.

Self-origin records remain available as captured records. Core excludes them
from frontier/deferred model inputs, saved-decision filing, model claim
creation/corroboration and unwritten model claims. Checks repeat after
asynchronous work and at final claim/writer transaction boundaries. A pending
decision retains its original drafts, input partition, model reference and
integrity digest; a current filing view removes every draft with any self
support. Remaining external drafts retain their identity and deferred inputs.
No new model call is needed to finish that decision. Source grant checks still
apply to its external inputs.

Exact matching cannot identify paraphrases, edited copies, historical file-only
orphans with no surviving receipt/intent, or machine text from another vault
whose byte registry was not imported. Independently produced identical text
may be classified conservatively. It is not a general authorship detector.

## Upgrade, restore and rollback

Quiesce the old process and retain a verified pre-upgrade backup before opening
the ledger with the new binary. Schema 16 validates historical event bounds and
version-1 hashes in bounded pages, validates native proof referents, adds the
new annotations and byte registry, and binds legacy native proofs to unchanged
event hashes. All changes commit together; invalid historical state leaves
schema 15 and its rows intact. This validation does not establish retrospective
authenticity of legacy data.

New exports refresh origin in the database snapshot and write backup v2. Each
event declares its hash version and must pass that algorithm, exact text hash
and closed accepted-record validation. Mixed v1/v2 event histories are supported.
The machine-byte intent stream is mandatory even when empty. Native proofs
must include their matching `event_content_hash`. Missing fields, inconsistent
origin, transferred proof references, invalid intents and malformed rows abort
restore before the destination is published. Event and intent JSONL records
have byte limits before parsing.

Backup v1 is accepted only for ledger versions through 15 and its original
event/proof shapes. The explicit legacy path validates version-1 event hashes,
restores byte evidence, derives origin and binds native proofs to their original
event hashes before validating pending decisions. A v1 envelope cannot carry
current spine/proof fields or claim ledger version 16.

Archive and manifest hashes establish internal consistency. They do not
authenticate an archive against coherent rewriting of the event, matching
proof binding and every checksum. Restore retains the existing trusted-backup
boundary; no signing authority is introduced by this migration.

Do not run mixed old/new binaries against one vault or use an old binary after
upgrade. There is no automatic down-migration. Roll back by restoring the
retained v1 backup into a separate empty root with its compatible binary.

## Verification

From the repository root with its pinned Bun version:

```bash
bun run typecheck
bun test packages/core/test/event-identity.test.ts packages/core/test/event-identity-migration.test.ts packages/core/test/event-backup-v2.test.ts packages/core/test/loop/self-ingest.test.ts packages/core/test/serve/extract-origin.test.ts packages/core/test/source-model-egress.test.ts
bun run verify
```

The focused cases cover revision compatibility, migration rollback, re-signed
semantic backup corruption, native proof transfer, managed pending replay,
unfinished intents, and a disk-backed writer/capturer process race. Repository
verification and native artifact acceptance remain separate gates.
