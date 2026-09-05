# Event identity and origin

Evidence date: 5 September 2026. This describes ledger schema 16 and backup
format `kizuki.backup/v2`. Release acceptance requires the separate checks in
[release-acceptance.md](release-acceptance.md).

## Accepted revisions

Connector input remains `kizuki.event/v1`. Core supplies `event_id`,
`content_hash`, `content_hash_version`, `text_hash`, `origin`,
`origin_binding_version`, `origin_binding_kind` and `origin_binding`; input
carrying any of these fields is rejected.

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

Capture and byte-intent admission serialize under an immediate SQLite write
transaction. A capture admitted before a matching intent remains external;
only subsequent captures see those machine bytes. A duplicate validates and
keeps its original stamp. Origin never changes when the byte registry grows or
is removed.

The required binding fields are `origin_binding_version=1`,
`origin_binding_kind=capture|native|legacy`, and a lowercase SHA-256
`origin_binding`. The digest covers the UTF-8 prefix
`kizuki.event-origin-binding/v1\0` (one NUL byte) followed by canonical JSON
with exactly these keys:

```json
{
  "event_id": "...",
  "content_hash_version": 2,
  "content_hash": "...",
  "text_hash": "...",
  "accepted_at": "...",
  "origin": "external",
  "kind": "capture",
  "native_request_digest": null
}
```

The existing Core serializer sorts object keys. This spine binding does not
change the connector envelope or event-revision hash. Acceptance time remains
internal database/backup state. SQL guards reject later edits to the binding,
origin, event ID, acceptance time, revision hash/version and text hash. Event
readers recompute the revision hash, exact text hash and binding.

Native owner corrections use a dedicated internal operation. It validates the
owner connector and request digest, then inserts the event, external native
binding and exact proof in one immediate transaction. The proof matches the
event hash and observation time and has no managed source binding. Its request,
event hash, event ID and timestamp cannot change; filing state may advance.
A connector label or metadata value cannot issue this proof. Legacy native
corrections carry `kind=legacy` and include the validated native request digest.

Self-origin records remain available as captured records. Core excludes them
from positive deterministic/model claim effects, corroboration, known-claim
model context and positive canon writes. Checks repeat at final storage/writer
boundaries. An exact validated source tombstone may withdraw its own evidence
and archive its own receipted page. The deletion path grants no positive claim
authority. Proposal filing snapshots exact JSON before validation so caller
accessors cannot turn an authorized deletion into a positive self claim. The
snapshot allows at most 8 MiB total, 4 MiB per string, 32 levels, 512 object keys,
4,096 array elements and 2,048 bytes per key; capture-generated proposals fit
inside those bounds.

A pending decision retains its original drafts, input partition, model reference
and integrity digest. A current filing view removes drafts supported by events
whose immutable stamp is self, as can happen during safe legacy backfill. Later
intents cannot invalidate a current decision. Remaining external drafts retain
their identity and deferred inputs, and no new model call is needed. All
surviving claim effects and decision completion require the separate atomic
filing transaction. Source grant checks still apply to external inputs.

Exact matching cannot identify paraphrases, edited copies, historical file-only
orphans with no surviving receipt/intent, or machine text from another vault
whose byte registry was not imported. Independently produced identical text
admitted after a retained intent may be classified conservatively. It is not a general authorship detector.

## Upgrade, restore and rollback

Quiesce the old process and retain a verified pre-upgrade backup before opening
the ledger with the new binary. Schema 16 validates historical event bounds and
version-1 hashes in bounded pages, validates native proof referents, adds the
new annotations and byte registry, and binds legacy native proofs to unchanged
event hashes. All changes commit together; invalid historical state leaves
schema 15 and its rows intact. This validation does not establish retrospective
authenticity of legacy data.

New exports validate immutable origin in the database snapshot and write backup
v2. Each event declares its hash version and binding, which must pass the
explicit algorithm and closed accepted-record validation. Mixed v1/v2 event
histories are supported. The machine-byte intent stream is mandatory even when
empty. Native proofs include their matching `event_content_hash` and request
digest. An origin-only flip, event-ID transfer, acceptance-time edit, proof
substitution, missing binding or malformed row aborts restore before the
destination is published, even if the outer hashes were re-signed. A valid
external stamp remains valid beside later matching receipts or intents.

Backup v1 is accepted only for ledger versions through 15 and its original
event/proof shapes. The explicit legacy path validates bounded version-1 rows,
restores the historical registry and native proofs, then derives immutable
`kind=legacy` bindings once. This runs in a private staging database, with its
new identity guards temporarily removed inside one immediate transaction. All
historical checkpoints, claims, receipts and extraction decisions are present
before the contamination preflight runs. Guards are reinstalled and every bound
row and pending decision is validated before committing or publishing files.
Any failure rolls back the staging transaction and removes the staging tree.

A current archive carrying `kind=legacy` still requires its exact existing
binding; it cannot select compatibility backfill. A v1 envelope cannot carry
current spine/proof fields or claim ledger version 16.

Archive and manifest hashes establish internal consistency. They do not
authenticate an archive against coherent rewriting of the event, matching
proof binding and every checksum. Restore retains the existing trusted-backup
boundary; no signing authority is introduced by this migration.

Do not run mixed old/new binaries against one vault or use an old binary after
upgrade. There is no automatic down-migration. Roll back by restoring the
retained v1 backup into a separate empty root with its compatible binary.

## Legacy contamination proof and loss contract

The compatibility path does not silently grandfather old machine evidence.
`legacy_machine_self` means a nonempty receipt-matched event that is neither a
context-marker event nor a validated native correction. Only those events need
the contamination preflight. Existing markers were already excluded by the
historical reader; native corrections remain external.

For each such event, `legacy-origin-preflight.ts` performs these exact checks:

1. Claim and canon provenance must be a JSON string array of at most 65,536 bytes. A
   matching event ID refuses even when the claim was subsequently superseded
   or purged. SQLite scans the bounded JSON values directly:

   ```sql
   SELECT 1 FROM claims, json_each(claims.provenance) p
   WHERE p.value = :event_id LIMIT 1;
   SELECT 1 FROM canon_receipts, json_each(canon_receipts.provenance) p
   WHERE p.value = :event_id LIMIT 1;
   ```

2. The `kizuki.producer.model` / `extract` checkpoint must contain a bounded
   RFC3339 time, a tab, and a canonical ULID. A candidate at or behind that
   completed frontier refuses under the exact ordering used by extraction:

   ```sql
   SELECT 1 WHERE :accepted_at < :frontier_at
     OR (:accepted_at = :frontier_at AND :event_id <= :frontier_id);
   ```

3. Completed deferred entries were deleted by the old code. If an
   `extract-deferred-scan` checkpoint exists without a usable completed
   frontier, no surviving completion journal can prove that the event stayed
   unconsumed, so it refuses. An event strictly after a valid frontier remains
   safe under this test: frontier purge rewind selects the last surviving row
   at or before the old frontier, so a surviving completed input cannot move
   beyond it. A still-queued input must retain its recorded source identity:

   ```sql
   SELECT 1 FROM extract_deferred_inputs d
   LEFT JOIN source_event_bindings b ON b.event_id = d.event_id
   WHERE d.event_id = :event_id AND d.source_key IS NOT b.source_key LIMIT 1;
   ```

4. Pending draft JSON must be valid and at most 1 MiB. If a draft contains the
   event ID, any existing claim or claim-bearing canon receipt makes partial
   old filing possible and refuses. An old structural corroboration could
   have changed an unrelated existing claim without retaining incoming
   provenance. Only a pending decision with no such effects may be filtered
   and completed; registry-only receipts with empty claim IDs do not imply a
   prior claim effect.

The first positive check raises the fixed content-free error
`legacy_origin_rebuild_required`. Migration stays at schema 15; restore never
publishes its destination. Event validation/backfill uses 32-row keyset pages;
provenance, pending decisions and timestamp parsing have explicit per-value
bounds. Current restore never executes this predicate or derives new origin.

This intentionally refuses usable histories where a passed frontier produced
no claim, an old deferred scan merely checked a denied source, or unrelated
claims exist beside an untouched pending draft. It also refuses a provenance
corruption encountered while checking a machine match. The old store discarded
corroborating input provenance and did not record known-claim model context,
so it cannot prove a narrower repair. No partial reversal or automatic derived
state rebuild is implemented here. A bounded rebuild design and separate live
qualification are required before upgrading a refused vault.

## Verification

From the repository root with its pinned Bun version:

```bash
bun run typecheck
bun test packages/core/test/event-causal-origin.test.ts packages/core/test/event-identity.test.ts packages/core/test/event-identity-migration.test.ts packages/core/test/event-backup-v2.test.ts packages/core/test/loop/self-ingest.test.ts packages/core/test/serve/extract-origin.test.ts packages/core/test/source-model-egress.test.ts
bun run verify
```

The focused cases cover revision compatibility, migration rollback, re-signed
semantic backup corruption, native proof transfer, managed pending replay,
unfinished intents, and a disk-backed writer/capturer process race. Repository
verification and native artifact acceptance remain separate gates.
