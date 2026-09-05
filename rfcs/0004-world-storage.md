# RFC 0004 storage and codec appendix

Status: **Proposed WIP, not accepted or implemented**. Baseline: `a96c5f4a4455d22fb4b40537c308c6d019a36d0d`.

This is the codec and recovery portion of [RFC 0004](0004-living-epistemic-world-model.md). The independently reviewed relational DDL and final component allocation are still being reconciled and will be added before design acceptance. This checkpoint is not an implementation-ready storage contract.

## Closed durable codecs and equality

This section fixes the byte contract of the proposed authority. These types are
design definitions, not exported Core APIs. `ClaimV2Assertion`, `RawSubjectRef`,
`ClaimV2Perspective`, `CanonicalProducer`, `AuthorityTier`, `Sensitivity`,
`ClaimTaint`, `FrontmatterValue` and `CanonReceipt` refer to the actual baseline
types. Identity controls use their separate A1 codec and receipted mutation;
they cannot be inserted as assertions in these tables.

```ts
type MeaningV1 = Omit<ClaimV2Assertion, "schema" | "anchors" | "perspective"> & {
  readonly schema: "kizuki.claim-meaning/v1";
  readonly perspective: Omit<ClaimV2Perspective, "anchors">;
};
type ExactEvent = {
  eventId: InternalId<"event">;
  contentHashVersion: 1 | 2;
  contentHash: string; textHash: string; originBinding: string;
  acceptedAt: string;
  source: { sourceKey: string; grantRevision: number; policyDigest: string } | null;
};
type EndpointEvidence = {
  endpointOrdinal: number; evidenceId: InternalId<"evidence">;
};
type AdmissionV1 = {
  schema: "kizuki.claim-admission/v1";
  id: InternalId<"admission">; claimId: InternalId<"claim">;
  assertion: ClaimV2Assertion;
  events: readonly ExactEvent[];
  observations: readonly DurableObservation[];
  endpointSupport: readonly EndpointEvidence[];
  prerequisites: readonly {
    claimId: InternalId<"claim">; admissionId: InternalId<"admission">;
  }[];
  producer: CanonicalProducer;
  producerDescriptor: { id: string; version: string; contract: "kizuki.producer/v2" } | null;
  modelRef: string | null; promptRef: string | null;
  epistemicKind: EpistemicKind; authority: AuthorityTier; confidence: number;
  sensitivity: Sensitivity; taint: ClaimTaint;
  recorded: Recorded; effectOrdinal: number;
};
type AdmissionRenderingV1 = {
  schema: "kizuki.admission-rendering/v1";
  body: string; frontmatter: Readonly<Record<string, FrontmatterValue>>;
};
type TransitionV1 = {
  schema: "kizuki.claim-transition/v1";
  id: InternalId<"transition">; claimId: InternalId<"claim">;
  operation: "assert" | "support_add" | "retract" | "supersede" | "reinstate" | "correct";
  before: "absent" | "active" | "retracted" | "superseded";
  after: "active" | "retracted" | "superseded";
  recorded: Recorded; effectOrdinal: number; effective: KnownTime;
  support: readonly InternalId<"admission">[];
  causeReceipt: InternalId<"receipt"> | null;
};
type TerminalV1<K extends "claim" | "canon_receipt" | "allocation_receipt"> = {
  schema: "kizuki.erasure-tombstone/v1";
  targetKind: K; id: InternalId<K>; state: "erased";
  purgeReceiptId: InternalId<"purge_receipt">;
  erasedAt: string; sensitivity: "private";
  integrity: string;
};
type CanonReceiptV2 = {
  schema: "kizuki.canon-receipt/v2"; state: "retained"; receipt: CanonReceipt;
} | {
  schema: "kizuki.canon-receipt/v2"; state: "erased";
  tombstone: TerminalV1<"canon_receipt">;
};
type AllocationV1 = {
  schema: "kizuki.semantic-allocation/v1"; state: "retained";
  receiptId: InternalId<"allocation_receipt">; operation: "allocate";
  raw: RawSubjectRef; handleId: InternalId<"handle">;
  claimId: InternalId<"claim">; admissionId: InternalId<"admission">;
  endpointOrdinal: number; evidenceId: InternalId<"evidence">;
  recorded: Recorded; sensitivity: Sensitivity; integrity: string;
} | {
  schema: "kizuki.semantic-allocation/v1"; state: "erased";
  tombstone: TerminalV1<"allocation_receipt">;
};
```

All objects are closed: unknown keys, missing required keys, non-finite numbers,
unsafe integers, duplicate object keys, accessor/prototype objects at in-process
boundaries and invalid UTF-8 in serialized input are refused. No new parser falls
back to an older codec. The baseline `canonicalJson` helper in
`packages/core/src/util/hash.ts` fixes serialization: UTF-16 code-unit ordering
of object keys, JSON number/string encoding and significant array order. Validate
before canonicalization; the helper by itself does not make arbitrary input safe.
The accepted codec name and canonical bytes are retained. Restore recomputes every
index projection and compares it with those bytes; SQL rows or hashes cannot
override a conflicting preimage.

Meaning preserves the original raw assertion values exactly, including its
original validity strings; only the two anchor arrays and old schema field are
removed and the private schema installed. Context is already sorted and unique
by the actual v2 parser. Endpoints have stable ordinals in this order: subject,
subject-valued object if any, each context in its existing order, then non-null
holder, speaker and addressee. Literal/vocabulary object endpoints have the object
position but no raw binding. Null perspective roles create no fake endpoint.
Normalized endpoint rows must reproduce this sequence exactly.

At most 8 exact events, 64 Observations, 256 evidence selections, 256 endpoint
support pairs and 1,024 prerequisite edges occur in one admission, subject to
the smaller existing producer/claim limits. Every evidence selection belongs to
one Observation and one exact cited event. Observation attribution is copied only
from a validated exact source field; its evidence references cannot point to a
different Observation. The Observation's recorded stamp equals its owning
admission's Core stamp. `sourceObservedAt` remains null when unknown. A source
event without a faithful occurrence time is not fabricated to fit frozen ingress.

Before parsing serialized input, enforce 256 KiB per meaning, admission,
Observation and rendering packet; 16 KiB per occurrence packet; 16 nesting
levels; 64 keys per object; 1,024 array entries and 64 bytes per key. Field-level
limits remain those of the existing v2 DTO or the smaller registry limit.
Additional descriptor/prompt/model strings are at most 1,024 UTF-8 bytes and
never contain credentials, raw prompts or response dumps. Existing frontmatter
value types remain in force, at most 64 keys and 32 KiB canonical bytes.
Only streaming/token-level JSON validation can reject duplicate object keys
before they disappear in ordinary JSON parsing. No required limit is delegated
to a model or adapter.

Event tuples are sorted by event ID and deduplicated only after full equality.
Prerequisites sort by `(claimId, admissionId)`, endpoint pairs by
`(endpointOrdinal, evidenceId)` and evidence by exact event/span-or-field tuple.
Observation and evidence local IDs are Core bookkeeping saved in the durable
decision, not a new independent evidence root. Raw source arrays that are
semantically ordered retain their original order. Normalized set ordering is
declared here rather than chosen separately by each consumer.

Identity preimages are precisely:

- Meaning: the entire canonical `MeaningV1`, hashed as
  `SHA256(UTF8("kizuki.claim-meaning-key/v1\0") || canonicalBytes)`.
- Support: a closed object with `schema:"kizuki.claim-support-key/v1"`,
  `meaning` (complete `MeaningV1`), `assertionAnchors`, `perspectiveAnchors`,
  sorted `events`, sorted `prerequisites`, canonical Observation selections and
  endpoint-support tuples. Each Observation selection is its complete codec
  value with only local IDs, owning admission ID and Core recorded stamp removed;
  evidence IDs in attribution/endpoint references become their canonical exact
  evidence tuple instead. Exact anchors use the unchanged v2 anchor shape.
  Prerequisites name immutable checked admissions. Hash the
  canonical object with domain `kizuki.claim-support-key/v1\0`.
- Terminal integrity: the canonical terminal object with `integrity` omitted,
  hashed with domain `kizuki.erasure-tombstone/v1\0`. It includes only target kind,
  opaque IDs, current erasure time/state and private sensitivity. An erased
  table row's fixed codec comes from component/row dispatch; it contains no old
  payload codec, operation kind or old integrity value.
- Allocation integrity: the canonical retained allocation with `integrity`
  omitted, domain `kizuki.semantic-allocation/v1\0`. An erased allocation uses
  the terminal definition instead; it cannot retain the allocation digest.
- Transition integrity: the entire canonical `TransitionV1`, domain
  `kizuki.claim-transition/v1\0`. Required support membership is part of the
  preimage; its normalized child rows must agree exactly.

Record IDs, Core stamps, rendering, model confidence and producer metadata are
excluded from the support identity. Re-running the same interpretation over the
same exact evidence cannot create another independent confidence observation.
An equal key requires equal full identity preimages, then returns the already
retained immutable admission and its original rendering/assessment. A differing
identity preimage under the same digest is a typed collision refusal. Different
rendering or model scores alone do not mutate that old admission; an explicitly
new interpretation must change real meaning/support, with the ordinary lifecycle.
Actual derivative/copy lineage is supplied by checked prerequisites and exact
source evidence, not a producer's unsupported claim of independence.

The row/payload/child agreement checks above are part of the one shared writer,
replay and restore. Their whole unit must exist before any public durable v2
mutation. This document defines the proposed codec; it does not claim those
validators or consumers have been implemented.

## Migration and erasure publication protocol

Migration acquires the existing exclusive vault maintenance boundary. No live
reader, writer, backup or extraction worker may observe table-copy intermediate
state. Validate bounded keyset pages into staged replacement tables using the
same connection and eventual immediate publication transaction; retain a durable
maintenance hold if validation needs multiple bounded preparation transactions.
The swap publishes all component versions together. Never disable foreign keys
on a shared connection or expose a parent before required children validate.

Existing retained v1 rows keep their exact data, hashes, original timestamps and
reader semantics. Recreate all legacy indexes/constraints on the retained arm.
An existing `status='purged'` row is eligible for terminal migration only when
an existing exact-selection purge receipt and its completion prove the affected
claim and erasure time. Otherwise the migration returns `repair_required` with
an owner-only affected count and leaves the source database untouched. It cannot
invent a receipt, infer erased provenance from a remaining hash, silently discard
the row, or start an irreversible purge merely because an upgrade was requested.

Canon JSONL migration recognizes exactly the existing legacy receipt object or
the declared v2 union. A retained legacy line can remain byte-identical and be
read by its explicit legacy dispatcher. New writes use the v2 codec only after
all readers support it. Erasure replaces the affected line of the same receipt
ID with exactly one v2 terminal line using the existing receipt stream owner;
it never appends a second conflicting line. Unknown/duplicate/conflicting lines
refuse recovery under a hold. The planned old digest/path may exist in a pending
erasure intent only while required for crash recovery; completion scrubs those
intent bytes, WAL/preimages and old SQLite/JSONL copies.

Use existing `event_purges`, `purge_ops`, source-erasure intents, canon holds,
writer ownership and replacement/fsync checks. The purge component gains a
closed next-version intent which binds an existing exact-selection receipt,
bounded store work IDs and its phase. It does not create a second purge log.
Pending work may retain selected IDs solely to finish erasure and prevent replay;
all such work is private, withheld from serving and included in the erasure plan.
On completion `purge_ops.ids`, `proof` and any old source/receipt/plan digest are
replaced by bounded non-content completion metadata. The existing event-purge
selection journal is a declared minimal anti-resurrection exception: opaque
event IDs and purge receipt/time remain, without text, content hashes, raw
subject/source-record identity or model input. An explicit source-consent
revocation record may retain its supported source binding needed to deny future
ingress; it is policy authority, never returned as erased semantic evidence.

For every erasure plan enumerate both existing and added stores: events and
attachments, source/extraction decisions and input manifests, jobs/outbox,
claims/body/frontmatter/semantic/support/Observation/endpoint/dependency rows,
supersession/control inverse material, allocation/binding/history, canon pages,
archives and source-erasure intents, SQLite and JSONL receipts, canonical indexes,
FTS and shadow tables, configured retrieval/graph stores, wire mappings and all
view/snapshot cache dependencies. An unknown configured store is an incomplete
purge, never an empty successful proof.

Erase dependencies and old mappings before their referenced support/event rows.
Survivors get new independently grounded rendering and current binding proof;
the old allocation record is never rewritten as if it had cited the survivor.
Staged purge work can span bounded transactions, but all reads/backup/export of
affected data remain held until both file and SQLite completion are durable.
`secure_delete` is enabled before destructive rewrites, then checkpoint/truncate
WAL and vacuum the owned database; verify sidecars, recovery inputs and every
configured store before declaring complete. The physical storage medium's own
remnant behavior is outside SQLite's proof; this contract covers managed bytes.

Restore validates exact component versions and codecs, staged row/child/FK
ownership, full identities, DAG closure, retained/tombstone arms, policy and
purge replay barriers before publication. Missing independent support refuses
the affected object rather than recreating erased authority. Issued durable
object/reference mappings survive only with their currently valid typed targets.
The view runtime generation and its lookup key are freshly generated; no old
live token, payload, expiry or runtime partition activity is imported. Current
owner configuration may reassign its configured cache reservations explicitly.

The proposed failure codes for this unit are `unsupported_schema`,
`invalid_record`, `identity_collision`, `dependency_unavailable`, `limit_exceeded`,
`repair_required`, `erasure_pending` and `storage_unavailable`. They are internal
Core results until a working public consumer maps them. Scoped adapters expose
only the fixed authorized failures in the main RFC, without raw identifiers,
denied counts or private repair details. Retry is limited to the existing bounded
read retry; repair/migration/schema errors never trigger automatic model work.
