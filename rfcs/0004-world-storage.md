# RFC 0004 storage and codec appendix

Status: **Proposed, pending independent review; not accepted or implemented**. Baseline: `a96c5f4a4455d22fb4b40537c308c6d019a36d0d`.

This is the proposed storage, codec and recovery contract of [RFC 0004](0004-living-epistemic-world-model.md). SQL defines the target tables, indexes and foreign keys; shared writer and restore validation enforce the explicitly stated cross-row and codec invariants. The SQL is a design artifact, not a shipped migration. Component versions publish only with their complete consumers and recovery paths.

This checkpoint still has two blocking design findings under repair: legacy
caller-supplied IDs cannot automatically qualify as non-content terminal metadata,
and pending store proofs need an exact durable instance/work binding. The SQL
probe checks structural constraints only. It does not close these findings or
establish that the erasure contract is ready to implement.

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
type BindingRevalidationV1 = {
  schema: "kizuki.binding-revalidation/v1";
  id: InternalId<"revalidation">; raw: RawSubjectRef;
  handleId: InternalId<"handle">;
  allocationReceiptId: InternalId<"allocation_receipt">;
  allocationReceiptState: "retained" | "erased";
  claimId: InternalId<"claim">; admissionId: InternalId<"admission">;
  endpointOrdinal: number; evidenceId: InternalId<"evidence">;
  recorded: Recorded; effectOrdinal: number;
  reason: "initial" | "support_replacement" | "independent_survivor";
  purgeReceiptId: InternalId<"purge_receipt"> | null;
};
type BindingRetirementV1 = {
  schema: "kizuki.binding-retirement/v1";
  revalidationId: InternalId<"revalidation">;
  recorded: Recorded; effectOrdinal: number;
  cause: "correction" | "source_revocation" | "support_ineligible" | "binding_replaced";
};
```

Revalidation and retirement codecs are reconstructed exactly from their typed
rows under the component's fixed version dispatcher. They have no alternative
mutable payload copy. `initial` must share the allocation's Core transaction;
ordinary successors use `support_replacement`; physical allocation loss uses
`independent_survivor`. An erased allocation requires its exact purge receipt
on every later revalidation; a retained allocation has a null purge link.
Ordinary retirement facts are immutable and cannot precede their revalidation.
One transaction allocates effect ordinals across its whole authority effect set,
not independently per table; replay/restore enforce cross-table uniqueness and
ordering even where each table's SQL uniqueness checks only its own rows.
Core operation IDs are newly generated opaque bookkeeping, never source keys,
content/semantic digests or a caller-supplied job label.

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
- Evidence support root: a closed object with
  `schema:"kizuki.claim-support-root/v1"`, sorted exact `events`, sorted checked
  `prerequisites` and canonical Observation selections. Each selection is its
  complete codec value with local IDs, owning admission ID and Core recorded
  stamp removed; attribution references become exact canonical evidence tuples.
  Meaning, interpretation kind, model/producer, confidence, authority, sensitivity,
  taint and rendering are absent. Hash with domain
  `kizuki.claim-support-root/v1\0` into `support_key`. This is a non-unique
  grouping/index key across admissions, not a second stored belief or proof that
  different keys imply independent evidence. Prerequisite closure and shared
  exact source/origin roots still determine conservative independence.
- Admission identity: a closed object with
  `schema:"kizuki.claim-admission-key/v1"`, complete `MeaningV1`, unchanged
  `assertionAnchors`/`perspectiveAnchors`, complete evidence-root preimage above,
  endpoint-support tuples with local IDs replaced by exact evidence tuples,
  and `{epistemicKind, authority, sensitivity, taint}`. Hash with domain
  `kizuki.claim-admission-key/v1\0` into unique `admission_key`. The assessment
  tuple is Core validated/clamped; a producer cannot choose authority or lower
  sensitivity. Thus reported and inferred assessments over the same support
  remain different immutable admissions without creating two independent roots.
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

Record IDs, Core stamps, rendering, model confidence and producer metadata do
not create another admission identity by themselves. Equal `admission_key`
requires equal complete admission-identity preimages and equal `support_key`
requires equal complete support-root preimages. A digest collision with different
bytes is a typed refusal. An equal admission returns the first retained immutable
rendering, confidence and producer/model attribution, explicitly as `duplicate`;
it does not claim the later producer authored that earlier result. Rerunning a
score or formatter cannot add an independent confidence vote. A later distinct
meaning, support root or Core assessment tuple creates an admission under the
ordinary lifecycle; confidence-only owner correction requires its own attributable
correction event, not mutation of the old record. Stricter current source policy
still applies to all reads, independently of these saved assessments.

Independence is never admission count or mere inequality of support keys. Expand
checked prerequisite closure, collapse shared exact capture/origin roots and
retain explicit copy/derivation relationships; uncertain independence stays
unknown. Distinct epistemic assessments over the same support share that root.
No separate mutable evidence-root authority table is introduced: each admission
retains the complete root preimage in its closed payload and the index only groups
and verifies byte-equal roots.

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
reader semantics. Recreate legacy constraints on the retained arm. Restrict the old `claims_idempotency` index over `(kind, coalesce(target, ''), body_hash)` to retained **v1** rows with `kind<>'purge_review'`, preserving that legacy exclusion. Neutral v2 common bodies deliberately share that hash; v2 identity is enforced by complete semantic/support keys and preimage equality.
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
Before physical maintenance, `purge_ops.ids`, `proof` and any old source/receipt/plan digest are replaced by the selector-free pending-maintenance arm specified below. Only after maintenance may bounded completion metadata be published. The generalized event-purge selection journal is a declared minimal anti-resurrection exception: Core-generated event ULIDs and purge receipt/time remain, without text, content hashes, raw subject/source-record identity or model input. ULIDs retain their creation time and linkage; they are not unlinkable or proof against equal-content recapture with a new event ID. An explicit source-consent
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
The view runtime generation is freshly generated; token lookup uses the hash of random bytes without a secret lookup key; no old
live token, payload, expiry or runtime partition activity is imported. Current
owner configuration may reassign its configured cache reservations explicitly.

The proposed failure codes for this unit are `unsupported_schema`,
`invalid_record`, `identity_collision`, `dependency_unavailable`, `limit_exceeded`,
`repair_required`, `erasure_pending` and `storage_unavailable`. They are internal
Core results until a working public consumer maps them. Scoped adapters expose
only the fixed authorized failures in the main RFC, without raw identifiers,
denied counts or private repair details. Retry is limited to the existing bounded
read retry; repair/migration/schema errors never trigger automatic model work.

## Evidence and component ownership

The proposal follows these existing seams at baseline `a96c5f4a4455d22fb4b40537c308c6d019a36d0d`:

| Evidence | Consequence |
| --- | --- |
| `rfcs/0003-rich-subject-foundation.md` reserves ledger 17, claims 4, serve 9, and backup 4 for B1b-d | Preserve those numbers and add the omitted canon/purge changes explicitly. |
| `packages/core/src/claims/schema.ts` is claims component 3 | The shared tables and the retained/erased `claims` rebuild belong to claims 4. |
| `packages/core/src/ledger/event-identity-schema.ts` installs ledger 16 | Core ordering and exact-event FK targets belong to ledger 17. |
| `packages/core/src/canon/schema.ts` is canon 4 | A retained/erased canon receipt union requires canon 5; it cannot silently mutate v4. |
| `packages/core/src/ledger/purge-schema.ts` is purge 5 | Generalized claims/canon/handle erasure intents and proof enumeration require purge 6. |
| `packages/core/src/serve/types.ts` is serve 8 | B1 keeps the reserved serve 9; scoped view storage later takes serve 10. |
| Backup is currently `kizuki.backup/v3` | B1 is backup v4, A1 v5, and the dependency/view packet is v6. |

Final coordinated allocation:

| Packet | Ledger | Claims | Canon | Purge | Serve | Other | Backup |
| --- | ---: | ---: | ---: | ---: | ---: | --- | ---: |
| RFC 0003 B1b-d | 17 | 4 | 5 | 6 | 9 | - | 4 |
| RFC 0003 A1 | 18 | 4 | 5 | 6 | 9 | identity 1 | 5 |
| RFC 0004 dependency/scoped-view packet | 19 | 5 | 5 | 6 | 10 | - | 6 |

A1 may reuse canon 5 and purge 6 only if those versions already contain the generic terminal receipt and erasure-intent mechanisms. If its implementation changes either schema, it must consume the next version rather than write different DDL under the same number.

## Proposed relational authority

The SQL below is the target relational contract. Migration code still has to use bounded keyset validation, table-copy/swap where existing `NOT NULL` constraints change, one immediate transaction, foreign keys enabled, and explicit erasure ordering. `ON DELETE CASCADE` is intentionally absent from authority tables.

```sql
-- Ledger 17. One row is one committed Core authority transaction.
CREATE TABLE core_authority_commits (
  admission_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  admitted_at TEXT NOT NULL,
  operation_id TEXT NOT NULL UNIQUE,
  UNIQUE(admission_seq, admitted_at)
) STRICT;

-- Existing event identity is immutable, but composite UNIQUE targets are needed
-- for exact child foreign keys rather than event_id-only references.
CREATE UNIQUE INDEX events_exact_identity_v1 ON events(
  event_id, content_hash_version, content_hash, text_hash,
  origin_binding, accepted_at
);
CREATE UNIQUE INDEX source_event_bindings_exact_v1 ON source_event_bindings(
  event_id, source_key, grant_revision, policy_digest
);
```

`admitted_at` is generated once by Core as canonical fixed-precision UTC and clamped nondecreasing against the prior commit. Callers do not supply it. `admission_seq` orders transactions; `effect_ordinal` below orders multiple effects in the same transaction. Source `observed_at` remains a separate fact and cannot be substituted for either field.

Claims 4 must rebuild the current table because a physical-purge tombstone cannot satisfy the legacy non-null payload columns honestly. The retained arm preserves every v3 constraint. The erased arm keeps only opaque identity, terminal state, purge linkage/time, private sensitivity, and a new tombstone digest.

```sql
CREATE TABLE claims_v4 (
  claim_id TEXT PRIMARY KEY,
  row_state TEXT NOT NULL CHECK(row_state IN ('retained','erased')),
  record_codec TEXT CHECK(record_codec IN ('kizuki.claim/v1','kizuki.claim/v2')),

  -- Existing v3 fields. Every one is nullable at the SQL column level so the
  -- terminal erased arm can contain no legacy payload or old digest.
  kind TEXT CHECK(kind IS NULL OR kind IN
    ('entity','claim','edit','merge','deletion','purge_review')),
  target TEXT CHECK(target IS NULL OR octet_length(target)>=1),
  body TEXT, frontmatter TEXT, provenance TEXT, subjects TEXT,
  producer TEXT CHECK(producer IS NULL OR producer IN
      ('deterministic','model','owner')
    OR (substr(producer,1,6)='agent:'
      AND octet_length(substr(producer,7))>=1
      AND substr(producer,7,1) GLOB '[A-Za-z0-9]'
      AND substr(producer,7) NOT GLOB '*[^A-Za-z0-9._-]*')),
  confidence REAL CHECK(confidence IS NULL OR confidence BETWEEN 0 AND 1),
  status TEXT CHECK(status IS NULL OR status IN
    ('live','superseded','reverted','provenance_reduced','skipped')),
  created_at TEXT,
  body_hash TEXT CHECK(body_hash IS NULL OR
    (length(body_hash)=64 AND body_hash NOT GLOB '*[^0-9a-f]*')),
  subject TEXT CHECK(subject IS NULL OR octet_length(subject)>=1),
  predicate TEXT CHECK(predicate IS NULL OR octet_length(predicate)>=1),
  object TEXT,
  polarity TEXT CHECK(polarity IS NULL OR polarity IN ('positive','negative')),
  claim_key TEXT CHECK(claim_key IS NULL OR
    (length(claim_key)=64 AND claim_key NOT GLOB '*[^0-9a-f]*')),
  authority TEXT CHECK(authority IS NULL OR authority IN
    ('owner_correction','owner_authored','connector_evidence','model_inference')),
  sensitivity TEXT CHECK(sensitivity IS NULL OR sensitivity IN
    ('public','personal','private')),
  taint TEXT CHECK(taint IS NULL OR taint IN ('clean','quoted')),
  model_ref TEXT CHECK(model_ref IS NULL OR octet_length(model_ref)>=1),
  valid_from TEXT, valid_from_second INTEGER,
  valid_to TEXT, valid_to_second INTEGER,
  asserted_at TEXT, retracted_at TEXT,
  superseded_by TEXT CHECK(superseded_by IS NULL OR octet_length(superseded_by)>=1),
  receipt_id TEXT CHECK(receipt_id IS NULL OR octet_length(receipt_id)>=1),
  corroboration INTEGER CHECK(corroboration IS NULL OR
    corroboration BETWEEN 1 AND 9007199254740991),
  last_confirmed_at TEXT,

  purge_receipt_id TEXT REFERENCES event_purges(receipt_id),
  erased_at TEXT,
  tombstone_integrity TEXT,

  CHECK ((
    (row_state='retained'
      AND record_codec IS NOT NULL
      AND kind IS NOT NULL AND body IS NOT NULL AND frontmatter IS NOT NULL
      AND provenance IS NOT NULL AND subjects IS NOT NULL
      AND producer IS NOT NULL AND confidence IS NOT NULL
      AND status IS NOT NULL
      AND created_at IS NOT NULL AND body_hash IS NOT NULL
      AND (record_codec='kizuki.claim/v1'
        OR (body='' AND frontmatter='{}' AND body_hash=
          'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'))
      AND polarity IS NOT NULL AND authority IS NOT NULL
      AND sensitivity IS NOT NULL AND taint IS NOT NULL
      AND ((record_codec='kizuki.claim/v1' AND valid_from IS NOT NULL
            AND valid_from_second IS NOT NULL)
        OR (record_codec='kizuki.claim/v2'
            AND ((valid_from IS NULL AND valid_from_second IS NULL)
              OR (valid_from IS NOT NULL AND valid_from_second IS NOT NULL))))
      AND ((valid_to IS NULL AND valid_to_second IS NULL)
        OR (valid_to IS NOT NULL AND valid_to_second IS NOT NULL
          AND (valid_from_second IS NULL OR valid_to_second>=valid_from_second)))
      AND asserted_at IS NOT NULL
      AND corroboration IS NOT NULL
      AND purge_receipt_id IS NULL AND erased_at IS NULL
      AND tombstone_integrity IS NULL)
    OR
    (row_state='erased'
      AND record_codec IS NULL
      AND kind IS NULL AND target IS NULL AND body IS NULL
      AND frontmatter IS NULL AND provenance IS NULL AND subjects IS NULL
      AND producer IS NULL AND confidence IS NULL AND status IS NULL
      AND created_at IS NULL AND body_hash IS NULL AND subject IS NULL
      AND predicate IS NULL AND object IS NULL AND polarity IS NULL
      AND claim_key IS NULL AND authority IS NULL AND model_ref IS NULL
      AND valid_from IS NULL AND valid_from_second IS NULL
      AND valid_to IS NULL AND valid_to_second IS NULL AND asserted_at IS NULL
      AND retracted_at IS NULL AND superseded_by IS NULL AND receipt_id IS NULL
      AND corroboration IS NULL AND last_confirmed_at IS NULL
      AND taint IS NULL AND sensitivity='private'
      AND purge_receipt_id IS NOT NULL AND erased_at IS NOT NULL
      AND length(tombstone_integrity)=64
      AND tombstone_integrity NOT GLOB '*[^0-9a-f]*')
  ) IS TRUE)
) STRICT;
CREATE INDEX claims_v4_by_key
  ON claims_v4(claim_key, status, valid_from_second)
  WHERE row_state='retained';
CREATE UNIQUE INDEX claims_v4_v1_idempotency
  ON claims_v4(kind, coalesce(target,''), body_hash)
  WHERE row_state='retained' AND record_codec='kizuki.claim/v1'
    AND kind<>'purge_review';
```

The migration marks existing rows `kizuki.claim/v1` and swaps `claims_v4` to `claims` only after all rows and referencing tables validate. Recreate retained-row indexes with `WHERE row_state='retained'`, except legacy body idempotency, which additionally requires `record_codec='kizuki.claim/v1' AND kind<>'purge_review'`; the indexed validity key is the normalized coarse second, never the raw timestamp. The retained SQL arm preserves the current closed kind, status, producer, polarity, authority, sensitivity and taint vocabularies, finite confidence range, safe positive corroboration count, and lowercase SHA-256 fields; `purged` is represented only by the erased arm. The application migration/writer/restore validator still enforces RFC 3339 timestamps, exact `compareRfc3339` ordering, non-empty provenance, JSON array/object shapes and frontmatter scalar values before publication. Conflict and gap logic must use inclusive coarse candidate scans followed by exact original-value comparison; the current accepted offset/fraction forms cannot be ordered as strings. A v2 common row always has the neutral empty `body`, canonical empty `frontmatter` object, and the SHA-256 of empty bytes. Its checked admissions own rendering, and the canon writer owns durable Markdown; there is no third materialization/body authority. The v1 arm retains its real non-null start; a v2 row may keep `valid_from=NULL` when the meaning codec says validity is unknown. No migration invents a date. A legacy row whose old `status='purged'` lacks verifiable purge receipt/time cannot be converted into a valid terminal row by inventing authority; the upgrade must refuse with a typed repair/rebuild result.

The shared v2 meaning and admission tables extend the B1 names already used by the incomplete implementation lane.

```sql
CREATE TABLE claim_v2_semantics (
  claim_id TEXT PRIMARY KEY REFERENCES claims(claim_id),
  codec TEXT NOT NULL CHECK(codec='kizuki.claim-meaning/v1'),
  semantic_key TEXT NOT NULL UNIQUE
    CHECK(length(semantic_key)=64 AND semantic_key NOT GLOB '*[^0-9a-f]*'),
  conflict_key TEXT
    CHECK(conflict_key IS NULL OR
      (length(conflict_key)=64 AND conflict_key NOT GLOB '*[^0-9a-f]*')),
  valid_kind TEXT NOT NULL CHECK(valid_kind IN ('known','unknown')),
  valid_from TEXT,
  valid_from_second INTEGER,
  valid_until TEXT,
  valid_until_second INTEGER,
  payload TEXT NOT NULL CHECK(octet_length(payload)<=262144),
  CHECK((
    (valid_kind='known' AND valid_from IS NOT NULL
      AND valid_from_second IS NOT NULL
      AND ((valid_until IS NULL AND valid_until_second IS NULL)
        OR (valid_until IS NOT NULL AND valid_until_second IS NOT NULL
          AND valid_until_second>=valid_from_second)))
    OR
    (valid_kind='unknown' AND valid_from IS NULL AND valid_from_second IS NULL
      AND valid_until IS NULL AND valid_until_second IS NULL)
  ) IS TRUE)
) STRICT;
CREATE INDEX claim_v2_semantics_conflict
  ON claim_v2_semantics(conflict_key, claim_id);
CREATE INDEX claim_v2_semantics_valid
  ON claim_v2_semantics(valid_kind, valid_from_second, valid_until_second, claim_id);

CREATE TABLE claim_v2_support (
  support_id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL REFERENCES claims(claim_id),
  codec TEXT NOT NULL CHECK(codec='kizuki.claim-admission/v1'),
  support_key TEXT NOT NULL
    CHECK(length(support_key)=64 AND support_key NOT GLOB '*[^0-9a-f]*'),
  admission_key TEXT NOT NULL UNIQUE
    CHECK(length(admission_key)=64 AND admission_key NOT GLOB '*[^0-9a-f]*'),
  admission_seq INTEGER NOT NULL,
  admitted_at TEXT NOT NULL,
  effect_ordinal INTEGER NOT NULL CHECK(effect_ordinal>=0),
  epistemic_kind TEXT NOT NULL CHECK(epistemic_kind IN
    ('observed','reported','owner_assertion','model_inference','hypothesis',
     'recommendation','scenario')),
  authority TEXT NOT NULL CHECK(authority IN
    ('owner_correction','owner_authored','connector_evidence','model_inference')),
  confidence REAL NOT NULL CHECK(confidence>=0.0 AND confidence<=1.0),
  sensitivity TEXT NOT NULL CHECK(sensitivity IN ('public','personal','private')),
  payload TEXT NOT NULL CHECK(octet_length(payload)<=262144),
  rendering TEXT NOT NULL CHECK(octet_length(rendering)<=262144),
  FOREIGN KEY(admission_seq, admitted_at)
    REFERENCES core_authority_commits(admission_seq, admitted_at),
  UNIQUE(claim_id, support_id),
  UNIQUE(admission_seq, effect_ordinal)
) STRICT;
CREATE INDEX claim_v2_support_root
  ON claim_v2_support(support_key, admission_key, support_id);
CREATE INDEX claim_v2_support_claim
  ON claim_v2_support(claim_id, admission_seq, effect_ordinal, support_id);
CREATE INDEX claim_v2_support_sensitivity
  ON claim_v2_support(sensitivity, admission_seq, support_id);
```

The codec payloads are bounded canonical collision preimages. Meaning, admission, Observation, and retained rendering packets each have a 256 KiB stored-byte ceiling; occurrence packets have a 16 KiB ceiling; view metadata has the separate 8 KiB aggregate ceiling below. Closed parsers also enforce field, array, depth, and aggregate limits before JSON parsing. On duplicate `semantic_key` or `admission_key`, the writer compares the entire corresponding identity before returning idempotent success. A shared `support_key` also requires equal full support-root preimages, while distinct assessment tuples may retain separate admissions over that root. SQL hash equality alone is insufficient.

### Exact event versions and Observations

An admission may cite a checked event without a usable span, so direct event membership remains separate from Observation evidence.

```sql
CREATE TABLE claim_v2_support_events (
  support_id TEXT NOT NULL REFERENCES claim_v2_support(support_id),
  event_id TEXT NOT NULL,
  event_hash_version INTEGER NOT NULL,
  event_hash TEXT NOT NULL,
  text_hash TEXT NOT NULL,
  origin_binding TEXT NOT NULL,
  event_accepted_at TEXT NOT NULL,
  source_key TEXT,
  grant_revision INTEGER,
  policy_digest TEXT,
  FOREIGN KEY(event_id, event_hash_version, event_hash, text_hash,
              origin_binding, event_accepted_at)
    REFERENCES events(event_id, content_hash_version, content_hash, text_hash,
                      origin_binding, accepted_at),
  FOREIGN KEY(event_id, source_key, grant_revision, policy_digest)
    REFERENCES source_event_bindings(event_id, source_key, grant_revision, policy_digest),
  CHECK((source_key IS NULL AND grant_revision IS NULL AND policy_digest IS NULL)
     OR (source_key IS NOT NULL AND grant_revision IS NOT NULL AND policy_digest IS NOT NULL)),
  PRIMARY KEY(support_id, event_id),
  UNIQUE(support_id, event_id, event_hash_version, event_hash, text_hash,
         origin_binding, event_accepted_at)
) STRICT;
CREATE INDEX claim_v2_support_events_event
  ON claim_v2_support_events(event_id, event_hash_version, event_hash, support_id);
CREATE INDEX claim_v2_support_events_source
  ON claim_v2_support_events(source_key, grant_revision, support_id);

CREATE TABLE claim_observations (
  observation_id TEXT PRIMARY KEY,
  support_id TEXT NOT NULL REFERENCES claim_v2_support(support_id),
  codec TEXT NOT NULL CHECK(codec='kizuki.observation-record/v1'),
  fidelity TEXT NOT NULL CHECK(fidelity IN
    ('verbatim_text','source_metadata','lossy_transcript')),
  occurred_kind TEXT NOT NULL CHECK(occurred_kind IN ('known','unknown')),
  occurred_from TEXT,
  occurred_from_second INTEGER,
  occurred_until TEXT,
  occurred_until_second INTEGER,
  source_observed_at TEXT CHECK(source_observed_at IS NULL
    OR octet_length(source_observed_at) BETWEEN 1 AND 64),
  payload TEXT NOT NULL CHECK(octet_length(payload)<=262144),
  CHECK(((occurred_kind='known' AND occurred_from IS NOT NULL
          AND occurred_from_second IS NOT NULL
          AND ((occurred_until IS NULL AND occurred_until_second IS NULL)
            OR (occurred_until IS NOT NULL AND occurred_until_second IS NOT NULL
              AND occurred_until_second>=occurred_from_second)))
     OR (occurred_kind='unknown' AND occurred_from IS NULL
          AND occurred_from_second IS NULL AND occurred_until IS NULL
          AND occurred_until_second IS NULL))
    IS TRUE),
  UNIQUE(support_id, observation_id)
) STRICT;
CREATE INDEX claim_observations_occurred
  ON claim_observations(
    occurred_kind, occurred_from_second, occurred_until_second, observation_id);

CREATE TABLE claim_observation_evidence (
  evidence_id TEXT PRIMARY KEY,
  support_id TEXT NOT NULL,
  observation_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  event_hash_version INTEGER NOT NULL,
  event_hash TEXT NOT NULL,
  text_hash TEXT NOT NULL,
  origin_binding TEXT NOT NULL,
  event_accepted_at TEXT NOT NULL,
  evidence_kind TEXT NOT NULL CHECK(evidence_kind IN ('text_span','source_metadata')),
  start_utf16 INTEGER,
  end_utf16 INTEGER,
  source_field TEXT,
  FOREIGN KEY(support_id, observation_id)
    REFERENCES claim_observations(support_id, observation_id),
  FOREIGN KEY(support_id, event_id, event_hash_version, event_hash, text_hash,
              origin_binding, event_accepted_at)
    REFERENCES claim_v2_support_events(support_id, event_id,
      event_hash_version, event_hash, text_hash, origin_binding, event_accepted_at),
  CHECK(((evidence_kind='text_span'
          AND start_utf16 IS NOT NULL AND start_utf16>=0
          AND end_utf16 IS NOT NULL AND end_utf16>start_utf16
          AND source_field IS NULL)
     OR (evidence_kind='source_metadata'
          AND start_utf16 IS NULL AND end_utf16 IS NULL
          AND source_field IS NOT NULL
          AND octet_length(source_field) BETWEEN 1 AND 128)) IS TRUE),
  UNIQUE(support_id, evidence_id),
  UNIQUE(observation_id, evidence_id)
) STRICT;
CREATE INDEX claim_observation_evidence_event
  ON claim_observation_evidence(event_id, event_hash_version, event_hash, support_id);

CREATE TABLE claim_observation_attributions (
  attribution_id TEXT PRIMARY KEY,
  support_id TEXT NOT NULL,
  observation_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN
    ('sender','recipient','quoted_author','thread','place')),
  raw_kind TEXT NOT NULL CHECK(raw_kind IN ('occurrence','supplied')),
  raw_id TEXT NOT NULL CHECK(octet_length(raw_id) BETWEEN 1 AND 1024),
  basis TEXT NOT NULL CHECK(basis='source_field'),
  source_field TEXT NOT NULL CHECK(octet_length(source_field) BETWEEN 1 AND 128),
  FOREIGN KEY(support_id, observation_id)
    REFERENCES claim_observations(support_id, observation_id),
  UNIQUE(support_id, attribution_id)
) STRICT;
CREATE INDEX claim_observation_attributions_ref
  ON claim_observation_attributions(raw_kind, raw_id, support_id);

CREATE TABLE claim_observation_attribution_evidence (
  support_id TEXT NOT NULL,
  attribution_id TEXT NOT NULL,
  evidence_id TEXT NOT NULL,
  FOREIGN KEY(support_id, attribution_id)
    REFERENCES claim_observation_attributions(support_id, attribution_id),
  FOREIGN KEY(support_id, evidence_id)
    REFERENCES claim_observation_evidence(support_id, evidence_id),
  PRIMARY KEY(support_id, attribution_id, evidence_id)
) STRICT;

-- Source occurrence identity, not semantic-object authority. connector_id and
-- source_record_id are read from the exact immutable event rather than copied.
CREATE TABLE claim_occurrences (
  occurrence_id TEXT PRIMARY KEY
    CHECK(length(occurrence_id)=64 AND occurrence_id NOT GLOB '*[^0-9a-f]*'),
  event_id TEXT NOT NULL,
  event_hash_version INTEGER NOT NULL,
  event_hash TEXT NOT NULL,
  text_hash TEXT NOT NULL,
  origin_binding TEXT NOT NULL,
  event_accepted_at TEXT NOT NULL,
  source_key TEXT,
  grant_revision INTEGER,
  policy_digest TEXT,
  start_utf16 INTEGER NOT NULL CHECK(start_utf16>=0),
  end_utf16 INTEGER NOT NULL CHECK(end_utf16>start_utf16),
  label TEXT NOT NULL CHECK(octet_length(label) BETWEEN 1 AND 512),
  payload TEXT NOT NULL CHECK(octet_length(payload)<=16384),
  FOREIGN KEY(event_id, event_hash_version, event_hash, text_hash,
              origin_binding, event_accepted_at)
    REFERENCES events(event_id, content_hash_version, content_hash, text_hash,
                      origin_binding, accepted_at),
  FOREIGN KEY(event_id, source_key, grant_revision, policy_digest)
    REFERENCES source_event_bindings(event_id, source_key, grant_revision, policy_digest),
  CHECK((source_key IS NULL AND grant_revision IS NULL AND policy_digest IS NULL)
     OR (source_key IS NOT NULL AND grant_revision IS NOT NULL AND policy_digest IS NOT NULL)),
  UNIQUE(event_id, event_hash_version, event_hash, start_utf16, end_utf16),
  UNIQUE(occurrence_id, event_id, event_hash_version, event_hash, text_hash,
         origin_binding, event_accepted_at)
) STRICT;
CREATE INDEX claim_occurrences_event
  ON claim_occurrences(event_id, event_hash_version, event_hash, occurrence_id);
```

The writer validates RFC 3339 values and every `text_span` boundary against the exact stored event text before the transaction. It preserves the timestamp bytes and derives each `*_second` with the same instant normalization used by Core's `compareRfc3339`; the integer is a coarse index key only. Range scans use inclusive second bounds and then compare the original values with `compareRfc3339`, preserving arbitrary fractions and leap-second behavior. Raw SQLite text order is incorrect for accepted offsets and unequal fraction widths. Exact writer and restore validation require an end instant strictly after its start even when both fall in the same second. `source_metadata` evidence instead names one bounded exact source field and has null spans. At commit it rechecks the complete event and source-binding tuples. A null source tuple is valid only for an exact native-owner event with its native proof; application/restore validation enforces that conditional relationship. `source_observed_at` follows Core's source observation-time rule, remains null when the DTO says unknown, and is never copied from `admitted_at`.

### Typed endpoints and complete endpoint support

Meaning endpoints are normalized once for typed query/index integrity. They remain a checked projection of `claim_v2_semantics.payload`, not another authority.

```sql
CREATE TABLE claim_meaning_endpoints (
  claim_id TEXT NOT NULL REFERENCES claim_v2_semantics(claim_id),
  endpoint_id INTEGER NOT NULL CHECK(endpoint_id>=0),
  role TEXT NOT NULL CHECK(role IN
    ('subject','object','context','holder','speaker','addressee')),
  value_kind TEXT NOT NULL CHECK(value_kind IN
    ('raw','literal','vocabulary')),
  raw_kind TEXT NOT NULL CHECK(raw_kind IN ('','occurrence','supplied')),
  raw_id TEXT NOT NULL,
  typed_value TEXT,
  CHECK(((value_kind='raw' AND raw_kind IN ('occurrence','supplied') AND raw_id IS NOT NULL
          AND octet_length(raw_id) BETWEEN 1 AND 1024 AND typed_value IS NULL)
     OR (value_kind<>'raw' AND raw_kind='' AND raw_id=''
          AND typed_value IS NOT NULL AND octet_length(typed_value)<=4096)) IS TRUE),
  PRIMARY KEY(claim_id, endpoint_id),
  UNIQUE(claim_id, endpoint_id, raw_kind, raw_id)
) STRICT;
CREATE INDEX claim_meaning_endpoints_raw
  ON claim_meaning_endpoints(raw_kind, raw_id, role, claim_id);
CREATE INDEX claim_meaning_endpoints_typed
  ON claim_meaning_endpoints(value_kind, typed_value, role, claim_id);

CREATE TABLE claim_admission_endpoint_support (
  claim_id TEXT NOT NULL,
  support_id TEXT NOT NULL,
  endpoint_id INTEGER NOT NULL,
  evidence_id TEXT NOT NULL,
  endpoint_raw_kind TEXT NOT NULL CHECK(endpoint_raw_kind IN
    ('','occurrence','supplied')),
  endpoint_raw_id TEXT NOT NULL,
  FOREIGN KEY(claim_id, support_id)
    REFERENCES claim_v2_support(claim_id, support_id),
  FOREIGN KEY(claim_id, endpoint_id)
    REFERENCES claim_meaning_endpoints(claim_id, endpoint_id),
  FOREIGN KEY(claim_id, endpoint_id, endpoint_raw_kind, endpoint_raw_id)
    REFERENCES claim_meaning_endpoints(claim_id, endpoint_id, raw_kind, raw_id),
  FOREIGN KEY(support_id, evidence_id)
    REFERENCES claim_observation_evidence(support_id, evidence_id),
  CHECK(((endpoint_raw_kind='' AND endpoint_raw_id='')
      OR (endpoint_raw_kind IN ('occurrence','supplied')
          AND endpoint_raw_id IS NOT NULL
          AND octet_length(endpoint_raw_id) BETWEEN 1 AND 1024)) IS TRUE),
  PRIMARY KEY(claim_id, support_id, endpoint_id, evidence_id),
  UNIQUE(claim_id, support_id, endpoint_id, evidence_id,
         endpoint_raw_kind, endpoint_raw_id)
) STRICT;
CREATE INDEX claim_endpoint_support_evidence
  ON claim_admission_endpoint_support(evidence_id, support_id, claim_id);
```

Predicate registry validation determines which endpoints require support. Before commit and on restore, Core proves that every required raw endpoint and named perspective/context endpoint has at least one eligible support row. It also resolves each occurrence endpoint to the complete `claim_occurrences` mint preimage and each supplied endpoint to the exact namespaced ref present in a cited event. A child count cannot be enforced by a parent-row `CHECK`; admission is unpublished until this validation and all child inserts complete in the same transaction.

Occurrences retain their full RFC 0003 mint tuple and exact event/span. Supplied refs retain their connector/source namespace in the meaning and support preimages. A shared raw-ref registry is unnecessary and would risk becoming identity authority.

### Admission dependency DAG

```sql
CREATE TABLE claim_support_dependencies (
  dependent_claim_id TEXT NOT NULL,
  dependent_support_id TEXT NOT NULL,
  prerequisite_claim_id TEXT NOT NULL,
  prerequisite_support_id TEXT NOT NULL,
  FOREIGN KEY(dependent_claim_id, dependent_support_id)
    REFERENCES claim_v2_support(claim_id, support_id),
  FOREIGN KEY(prerequisite_claim_id, prerequisite_support_id)
    REFERENCES claim_v2_support(claim_id, support_id),
  CHECK(dependent_support_id<>prerequisite_support_id),
  PRIMARY KEY(dependent_support_id, prerequisite_support_id)
) STRICT;
CREATE INDEX claim_support_prerequisite_dependents
  ON claim_support_dependencies(prerequisite_support_id, dependent_support_id);
CREATE INDEX claim_support_dependencies_by_claim
  ON claim_support_dependencies(prerequisite_claim_id, dependent_claim_id);

CREATE TRIGGER claim_support_dependency_no_cycle
BEFORE INSERT ON claim_support_dependencies
BEGIN
  WITH RECURSIVE ancestors(support_id) AS (
    SELECT NEW.prerequisite_support_id
    UNION
    SELECT d.prerequisite_support_id
      FROM claim_support_dependencies AS d
      JOIN ancestors ON d.dependent_support_id=ancestors.support_id
  )
  SELECT RAISE(ABORT, 'claim support dependency cycle')
   WHERE EXISTS(
     SELECT 1 FROM ancestors WHERE support_id=NEW.dependent_support_id
   );
END;
```

The trigger is defense in depth. Preparation must reject candidates over the RFC bound and prove acyclicity and closure in memory; commit rechecks each prerequisite exact admission and its authorization/source fences. All recursive bitemporal reads use the same `knownAt` cutoff for the root and every prerequisite. A prerequisite admitted after the cutoff cannot leak into an earlier view.

### Bitemporal lifecycle and loss coverage

```sql
CREATE TABLE claim_lifecycle_history (
  transition_id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL REFERENCES claims(claim_id),
  codec TEXT NOT NULL CHECK(codec='kizuki.claim-transition/v1'),
  operation TEXT NOT NULL CHECK(operation IN
    ('assert','support_add','retract','supersede','reinstate','correct')),
  admission_seq INTEGER NOT NULL,
  recorded_at TEXT NOT NULL,
  effect_ordinal INTEGER NOT NULL CHECK(effect_ordinal>=0),
  before_state TEXT NOT NULL CHECK(before_state IN
    ('absent','active','retracted','superseded')),
  after_state TEXT NOT NULL CHECK(after_state IN
    ('active','retracted','superseded')),
  effective_kind TEXT NOT NULL CHECK(effective_kind IN ('known','unknown')),
  effective_from TEXT,
  effective_from_second INTEGER,
  effective_until TEXT,
  effective_until_second INTEGER,
  cause_receipt_id TEXT,
  integrity TEXT NOT NULL
    CHECK(length(integrity)=64 AND integrity NOT GLOB '*[^0-9a-f]*'),
  FOREIGN KEY(admission_seq, recorded_at)
    REFERENCES core_authority_commits(admission_seq, admitted_at),
  CHECK(((effective_kind='known' AND effective_from IS NOT NULL
          AND effective_from_second IS NOT NULL
          AND ((effective_until IS NULL AND effective_until_second IS NULL)
            OR (effective_until IS NOT NULL AND effective_until_second IS NOT NULL
              AND effective_until_second>=effective_from_second)))
     OR (effective_kind='unknown'
          AND effective_from IS NULL AND effective_from_second IS NULL
          AND effective_until IS NULL AND effective_until_second IS NULL)) IS TRUE),
  UNIQUE(admission_seq, effect_ordinal)
) STRICT;
CREATE UNIQUE INDEX claim_lifecycle_claim_transition
  ON claim_lifecycle_history(claim_id, transition_id);
CREATE INDEX claim_lifecycle_known_order
  ON claim_lifecycle_history(claim_id, admission_seq, effect_ordinal);
CREATE INDEX claim_lifecycle_valid
  ON claim_lifecycle_history(claim_id, effective_kind,
                             effective_from_second, effective_until_second,
                             admission_seq);

CREATE TABLE claim_history_support (
  transition_id TEXT NOT NULL REFERENCES claim_lifecycle_history(transition_id),
  claim_id TEXT NOT NULL,
  support_id TEXT NOT NULL,
  FOREIGN KEY(claim_id, transition_id)
    REFERENCES claim_lifecycle_history(claim_id, transition_id),
  FOREIGN KEY(claim_id, support_id)
    REFERENCES claim_v2_support(claim_id, support_id),
  PRIMARY KEY(transition_id, support_id)
) STRICT;
CREATE INDEX claim_history_by_support
  ON claim_history_support(support_id, transition_id);

CREATE TABLE claim_history_coverage (
  claim_id TEXT PRIMARY KEY REFERENCES claims(claim_id),
  first_complete_seq INTEGER NOT NULL,
  first_complete_at TEXT NOT NULL,
  reason TEXT NOT NULL CHECK(reason IN ('upgrade_baseline','physical_purge')),
  FOREIGN KEY(first_complete_seq, first_complete_at)
    REFERENCES core_authority_commits(admission_seq, admitted_at),
  UNIQUE(claim_id, first_complete_seq)
) STRICT;
```

The same preserved-bytes/coarse-second rule governs lifecycle validity. Core
validates the exact interval with `compareRfc3339` before write and restore;
the index only narrows candidates. `recorded_at` is different: it is a
Core-stamped fixed-precision UTC value paired to `admission_seq`, so its
existing ordering contract remains safe.

History stores state changes and their support references, not copied rendering or semantic preimages. A timestamp convenience request resolves once to the greatest committed `(admitted_at, admission_seq)` at or before that timestamp and returns an opaque scoped snapshot reference. Core parses the caller timestamp with the same exact RFC 3339 comparator, derives the greatest fixed-millisecond UTC boundary that cannot exceed it, and only then uses the canonical `admitted_at` ordering; it never compares an offset-bearing caller string directly with stored text. A read then uses that exact internal cutoff, applies the original meaning interval plus applicable effective transitions, and recurses into prerequisites using the same cutoff. Repeating the snapshot reference is stable even if a later transaction receives the same clamped wall-clock value. Current authorization is still applied on every use. No public result serializes the internal sequence. If the requested cutoff predates `first_complete_seq`, return `history_unavailable` with only an authorized coverage bound.

Physical purge deletes affected history/support rows and advances `claim_history_coverage` on surviving claims. It never inserts a fake empty past or a tombstone history row containing old linkage.

## Handle allocation and binding ownership

Handles are random 128-bit internal IDs. The allocation receipt proves only that Core allocated bookkeeping for a qualifying raw endpoint; it does not name, type, merge, or classify anything.

```sql
CREATE TABLE semantic_handles (
  handle_id TEXT PRIMARY KEY
    CHECK(length(handle_id)=32 AND handle_id NOT GLOB '*[^0-9a-f]*')
) STRICT;

CREATE TABLE semantic_allocation_receipts (
  allocation_receipt_id TEXT PRIMARY KEY,
  row_state TEXT NOT NULL CHECK(row_state IN ('retained','erased')),
  codec TEXT,
  operation_kind TEXT,
  raw_kind TEXT,
  raw_id TEXT,
  handle_id TEXT,
  owner_claim_id TEXT,
  owner_support_id TEXT,
  owner_endpoint_id INTEGER,
  owner_evidence_id TEXT,
  admission_seq INTEGER,
  allocated_at TEXT,
  sensitivity TEXT,
  purge_receipt_id TEXT REFERENCES event_purges(receipt_id),
  erased_at TEXT,
  integrity TEXT NOT NULL
    CHECK(length(integrity)=64 AND integrity NOT GLOB '*[^0-9a-f]*'),
  FOREIGN KEY(admission_seq, allocated_at)
    REFERENCES core_authority_commits(admission_seq, admitted_at),
  FOREIGN KEY(handle_id) REFERENCES semantic_handles(handle_id),
  FOREIGN KEY(owner_claim_id, owner_support_id, owner_endpoint_id, owner_evidence_id,
              raw_kind, raw_id)
    REFERENCES claim_admission_endpoint_support(
      claim_id, support_id, endpoint_id, evidence_id,
      endpoint_raw_kind, endpoint_raw_id),
  CHECK((
    (row_state='retained'
      AND codec='kizuki.semantic-allocation/v1'
      AND operation_kind='allocate'
      AND raw_kind IN ('occurrence','supplied') AND raw_id IS NOT NULL
      AND handle_id IS NOT NULL AND owner_claim_id IS NOT NULL
      AND owner_support_id IS NOT NULL AND owner_endpoint_id IS NOT NULL
      AND owner_evidence_id IS NOT NULL AND admission_seq IS NOT NULL
      AND allocated_at IS NOT NULL AND sensitivity IS NOT NULL
      AND purge_receipt_id IS NULL AND erased_at IS NULL)
    OR
    (row_state='erased'
      AND codec IS NULL AND operation_kind IS NULL
      AND raw_kind IS NULL AND raw_id IS NULL AND handle_id IS NULL
      AND owner_claim_id IS NULL AND owner_support_id IS NULL
      AND owner_endpoint_id IS NULL AND owner_evidence_id IS NULL
      AND admission_seq IS NULL AND allocated_at IS NULL
      AND sensitivity='private'
      AND purge_receipt_id IS NOT NULL AND erased_at IS NOT NULL)
  ) IS TRUE),
  UNIQUE(allocation_receipt_id, row_state),
  UNIQUE(allocation_receipt_id, row_state, purge_receipt_id)
) STRICT;

-- Immutable Core audit of the binding's current complete support. A revalidation
-- after allocation erasure is a new fact; it does not rewrite allocation history.
CREATE TABLE semantic_binding_revalidations (
  revalidation_id TEXT PRIMARY KEY,
  raw_kind TEXT NOT NULL CHECK(raw_kind IN ('occurrence','supplied')),
  raw_id TEXT NOT NULL CHECK(octet_length(raw_id) BETWEEN 1 AND 1024),
  handle_id TEXT NOT NULL REFERENCES semantic_handles(handle_id),
  allocation_receipt_id TEXT NOT NULL,
  allocation_receipt_state TEXT NOT NULL CHECK(allocation_receipt_state IN
    ('retained','erased')),
  owner_claim_id TEXT NOT NULL,
  owner_support_id TEXT NOT NULL,
  owner_endpoint_id INTEGER NOT NULL,
  owner_evidence_id TEXT NOT NULL,
  admission_seq INTEGER NOT NULL,
  revalidated_at TEXT NOT NULL,
  effect_ordinal INTEGER NOT NULL CHECK(effect_ordinal>=0),
  reason TEXT NOT NULL CHECK(reason IN ('initial','support_replacement','independent_survivor')),
  purge_receipt_id TEXT REFERENCES event_purges(receipt_id),
  FOREIGN KEY(allocation_receipt_id, allocation_receipt_state)
    REFERENCES semantic_allocation_receipts(allocation_receipt_id, row_state)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(allocation_receipt_id, allocation_receipt_state, purge_receipt_id)
    REFERENCES semantic_allocation_receipts(
      allocation_receipt_id, row_state, purge_receipt_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(owner_claim_id, owner_support_id, owner_endpoint_id, owner_evidence_id,
              raw_kind, raw_id)
    REFERENCES claim_admission_endpoint_support(
      claim_id, support_id, endpoint_id, evidence_id,
      endpoint_raw_kind, endpoint_raw_id),
  FOREIGN KEY(admission_seq, revalidated_at)
    REFERENCES core_authority_commits(admission_seq, admitted_at),
  CHECK(((reason IN ('initial','support_replacement')
          AND allocation_receipt_state='retained' AND purge_receipt_id IS NULL)
     OR (reason IN ('support_replacement','independent_survivor')
          AND allocation_receipt_state='erased' AND purge_receipt_id IS NOT NULL))
    IS TRUE),
  UNIQUE(revalidation_id, raw_kind, raw_id, handle_id,
         allocation_receipt_id, allocation_receipt_state,
         owner_claim_id, owner_support_id, owner_endpoint_id, owner_evidence_id),
  UNIQUE(admission_seq, effect_ordinal)
) STRICT;
CREATE INDEX semantic_binding_revalidations_owner
  ON semantic_binding_revalidations(owner_support_id, owner_evidence_id,
                                    admission_seq, revalidation_id);

-- Revalidation facts are immutable. Ordinary correction/revocation retires a
-- fact with another Core-stamped row; only physical purge deletes its payload.
CREATE TRIGGER semantic_binding_revalidations_immutable
BEFORE UPDATE ON semantic_binding_revalidations
BEGIN
  SELECT RAISE(ABORT, 'semantic revalidation is immutable');
END;

CREATE TABLE semantic_binding_revalidation_retirements (
  revalidation_id TEXT PRIMARY KEY
    REFERENCES semantic_binding_revalidations(revalidation_id),
  admission_seq INTEGER NOT NULL,
  retired_at TEXT NOT NULL,
  effect_ordinal INTEGER NOT NULL CHECK(effect_ordinal>=0),
  cause_kind TEXT NOT NULL CHECK(cause_kind IN
    ('correction','source_revocation','support_ineligible','binding_replaced')),
  FOREIGN KEY(admission_seq, retired_at)
    REFERENCES core_authority_commits(admission_seq, admitted_at),
  UNIQUE(admission_seq, effect_ordinal)
) STRICT;
CREATE TRIGGER semantic_binding_retirements_immutable
BEFORE UPDATE ON semantic_binding_revalidation_retirements
BEGIN
  SELECT RAISE(ABORT, 'semantic revalidation retirement is immutable');
END;

CREATE TABLE semantic_bindings (
  raw_kind TEXT NOT NULL CHECK(raw_kind IN ('occurrence','supplied')),
  raw_id TEXT NOT NULL CHECK(octet_length(raw_id) BETWEEN 1 AND 1024),
  binding_state TEXT NOT NULL CHECK(binding_state='active'),
  handle_id TEXT NOT NULL UNIQUE REFERENCES semantic_handles(handle_id),
  allocation_receipt_id TEXT NOT NULL,
  allocation_receipt_state TEXT NOT NULL CHECK(allocation_receipt_state IN
    ('retained','erased')),
  current_revalidation_id TEXT NOT NULL,
  owner_claim_id TEXT NOT NULL,
  owner_support_id TEXT NOT NULL,
  owner_endpoint_id INTEGER NOT NULL,
  owner_evidence_id TEXT NOT NULL,
  FOREIGN KEY(allocation_receipt_id, allocation_receipt_state)
    REFERENCES semantic_allocation_receipts(allocation_receipt_id, row_state)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(current_revalidation_id, raw_kind, raw_id, handle_id,
              allocation_receipt_id, allocation_receipt_state,
              owner_claim_id, owner_support_id, owner_endpoint_id, owner_evidence_id)
    REFERENCES semantic_binding_revalidations(
      revalidation_id, raw_kind, raw_id, handle_id,
      allocation_receipt_id, allocation_receipt_state,
      owner_claim_id, owner_support_id, owner_endpoint_id, owner_evidence_id)
    DEFERRABLE INITIALLY DEFERRED,
  PRIMARY KEY(raw_kind, raw_id)
) STRICT;
CREATE INDEX semantic_bindings_owner
  ON semantic_bindings(owner_support_id, owner_evidence_id, handle_id);
CREATE TRIGGER semantic_bindings_refuse_retired_insert
BEFORE INSERT ON semantic_bindings
WHEN EXISTS (
  SELECT 1 FROM semantic_binding_revalidation_retirements r
  WHERE r.revalidation_id=NEW.current_revalidation_id)
BEGIN
  SELECT RAISE(ABORT, 'retired semantic revalidation cannot be current');
END;
CREATE TRIGGER semantic_bindings_refuse_retired_update
BEFORE UPDATE OF current_revalidation_id ON semantic_bindings
WHEN EXISTS (
  SELECT 1 FROM semantic_binding_revalidation_retirements r
  WHERE r.revalidation_id=NEW.current_revalidation_id)
BEGIN
  SELECT RAISE(ABORT, 'retired semantic revalidation cannot be current');
END;
CREATE TRIGGER semantic_retirement_refuse_current
BEFORE INSERT ON semantic_binding_revalidation_retirements
WHEN EXISTS (
  SELECT 1 FROM semantic_bindings b
  WHERE b.current_revalidation_id=NEW.revalidation_id)
BEGIN
  SELECT RAISE(ABORT, 'current semantic binding must move before retirement');
END;
```

The initial binding, receipt, and revalidation point to the same complete endpoint support. Ordinary correction or revocation never deletes or rewrites that historical revalidation: one immediate Core transaction moves or deletes the current binding, inserts the closed retirement child for the old revalidation, and inserts any independently complete successor with reason `support_replacement`. A retained allocation keeps a null purge link; an already erased allocation keeps its exact existing purge link. `initial` is valid only for the first allocation transaction; `independent_survivor` denotes the physical allocation-erasure transition, not ordinary correction. The writer/restore validator checks those transaction relationships in addition to the foreign keys. A resolver reads only `semantic_bindings`, rejects a missing, retired, or currently ineligible revalidation, and returns `not_found`; historical rows grant no external resolution. Their foreign key intentionally retains the bookkeeping handle while undo/history can still name it.

Binding ownership may later move to an independently complete surviving admission. The immutable retained allocation receipt is not rewritten to claim the survivor allocated it. If physical purge removes its old attribution, one deferred-foreign-key transaction erases the receipt payload, deletes the old sensitive retirement/revalidation rows, inserts an `independent_survivor` revalidation when one exists, and updates the current binding before deleting old support. The binding explicitly records `allocation_receipt_state='erased'`; the new Core-stamped revalidation, rather than scrubbed receipt payload, proves its current raw-ref/handle/support relationship. Without complete surviving support, delete the current binding. Delete the handle only after no current or retained historical revalidation references it.

The erased receipt keeps exactly `allocation_receipt_id`, `row_state`, `purge_receipt_id`, `erased_at`, private sensitivity, and its new tombstone integrity. `operation_kind` is null in the terminal arm. The opaque receipt link on a current binding is retained only through the audited purge plan; it never reassigns the historical allocation to the survivor.

## Canon terminal receipt shape

Canon 5 must rebuild `canon_receipts` for the same reason as `claims`: current non-null columns cannot express a payload-free terminal row. Preserve `operation_kind` separately from `row_state` while retained so `write`, `revert`, and `purge_rewrite` are never collapsed or overwritten. In the erased arm, null `operation_kind` and every old payload field.

```sql
CREATE TABLE canon_receipts_v5 (
  receipt_id TEXT PRIMARY KEY,
  row_state TEXT NOT NULL CHECK(row_state IN ('retained','erased')),
  operation_kind TEXT CHECK(operation_kind IS NULL OR operation_kind IN
    ('write','revert','purge_rewrite')),
  claim_ids TEXT,
  provenance TEXT,
  sensitivity TEXT CHECK(sensitivity IS NULL OR sensitivity IN
    ('public','personal','private')),
  page_path TEXT,
  kind TEXT CHECK(kind IS NULL OR kind IN
    ('entity','claim','edit','merge','deletion','purge_review','revert')),
  before_hash TEXT CHECK(before_hash IS NULL OR
    (length(before_hash)=64 AND before_hash NOT GLOB '*[^0-9a-f]*')),
  after_hash TEXT CHECK(after_hash IS NULL OR
    (length(after_hash)=64 AND after_hash NOT GLOB '*[^0-9a-f]*')),
  at TEXT,
  page_action TEXT CHECK(page_action IS NULL OR page_action IN
    ('create','edit','archive')),
  archive_path TEXT,
  writer TEXT CHECK(writer IS NULL OR writer IN
    ('loop','correction','revert','import')),
  producer TEXT CHECK(producer IS NULL OR producer IN
      ('deterministic','model','owner')
    OR (substr(producer,1,6)='agent:'
      AND octet_length(substr(producer,7))>=1
      AND substr(producer,7,1) GLOB '[A-Za-z0-9]'
      AND substr(producer,7) NOT GLOB '*[^A-Za-z0-9._-]*')),
  model_ref TEXT CHECK(model_ref IS NULL OR octet_length(model_ref)>=1),
  authority TEXT CHECK(authority IS NULL OR authority IN
    ('owner_correction','owner_authored','connector_evidence','model_inference')),
  confidence REAL CHECK(confidence IS NULL OR confidence BETWEEN 0 AND 1),
  taint TEXT CHECK(taint IS NULL OR taint IN ('clean','quoted')),
  candidates TEXT,
  superseded TEXT,
  retrieval_ops TEXT,
  reverts TEXT,
  reverted_by TEXT,
  purge_receipt_id TEXT REFERENCES event_purges(receipt_id),
  erased_at TEXT,
  tombstone_integrity TEXT,
  CHECK ((
    (row_state='retained'
      AND operation_kind IN ('write','revert','purge_rewrite')
      AND claim_ids IS NOT NULL AND provenance IS NOT NULL
      AND sensitivity IS NOT NULL AND page_path IS NOT NULL
      AND kind IS NOT NULL AND after_hash IS NOT NULL AND at IS NOT NULL
      AND page_action IS NOT NULL AND writer IS NOT NULL AND producer IS NOT NULL
      AND authority IS NOT NULL AND confidence IS NOT NULL AND taint IS NOT NULL
      AND candidates IS NOT NULL AND superseded IS NOT NULL
      AND retrieval_ops IS NOT NULL
      AND purge_receipt_id IS NULL AND erased_at IS NULL
      AND tombstone_integrity IS NULL)
    OR
    (row_state='erased'
      AND operation_kind IS NULL
      AND claim_ids IS NULL AND provenance IS NULL AND page_path IS NULL
      AND kind IS NULL AND before_hash IS NULL AND after_hash IS NULL
      AND at IS NULL AND page_action IS NULL AND archive_path IS NULL
      AND writer IS NULL AND producer IS NULL AND model_ref IS NULL
      AND authority IS NULL AND confidence IS NULL AND taint IS NULL
      AND candidates IS NULL AND superseded IS NULL AND retrieval_ops IS NULL
      AND reverts IS NULL AND reverted_by IS NULL
      AND sensitivity='private'
      AND purge_receipt_id IS NOT NULL AND erased_at IS NOT NULL
      AND length(tombstone_integrity)=64
      AND tombstone_integrity NOT GLOB '*[^0-9a-f]*')
  ) IS TRUE)
) STRICT;
```

The retained arm preserves the current receipt, page-action, writer, producer, authority, sensitivity and taint vocabularies, finite confidence range, and exact lowercase SHA-256 page hashes. Application migration/writer/restore validation still checks the RFC 3339 stamp and the exact JSON shapes and bounds of claim IDs, provenance, candidates, superseded claims and retrieval operations. It also enforces the receipt relationships: a `revert` is written by `revert` and names the receipt it reverses; ordinary and purge-rewrite receipts do not fabricate that link.

The full implementation must also update the JSONL receipt protocol; otherwise SQLite erasure can leave the old receipt in `.kizuki/receipts/promotions.jsonl`. Purge 6 should reuse the existing `purge_ops`, source-erasure intent, writer, and JSONL ownership. It adds table/store enumeration and terminal rewrite work, not another purge journal or receipt authority.

## Rebuildable relation indexes

The common endpoint table is enough to rebuild Concept relations. A performance index may denormalize predicate, direction, polarity, perspective/context discriminator, original validity, and reverse claim/support IDs, but it has these rules:

- It is rebuilt only from surviving `claim_v2_semantics`, eligible admissions, endpoint support, and current identity authorization.
- It is excluded from backup authority and never accepted as a support or history source.
- Reads decode and compare the source meaning/admission payloads before returning a row.
- It has subject, object, alias, temporal, context/raw-endpoint, support, and claim reverse indexes. Candidate authorization occurs before ranking or counts.

No `concepts`, `beliefs`, `relations`, or per-noun mutable truth table is warranted by the named queries.

## Durable wire references and bounded views

Internal claim, support, Observation, event-version, handle, receipt, source,
page, raw-subject, captured-subject and principal IDs never cross a world adapter. Every
nested `Ref<K>` uses one closed wire-ref kind and a random 32-byte opaque token
bound by storage to its exact typed target tuple. A mapping row is resolution bookkeeping; every lookup
revalidates the authenticated principal and complete current authorization.
`EvidenceRef` is a struct containing admission/event-version refs and a span,
not another reference kind. `StateTransition` contains claim and receipt refs;
it has no transition ref.

| Public wire kind | Exact internal target |
| --- | --- |
| `object` | one surviving semantic handle |
| `claim` | one retained claim |
| `admission` | one claim/support pair |
| `observation` | one support/Observation pair |
| `event_version` | the complete immutable event-version tuple |
| `receipt` | one typed canon, allocation or purge receipt |
| `source` | one source grant key, rechecked as current |
| `page` | one canonical page ID, rechecked against current page bytes/index |
| `raw_subject` | one immutable raw occurrence/supplied ref with normalized exact retained memberships |
| `captured_subject` | one attribution raw ref plus its exact retained event/source binding |
| `claim_group` | one bounded derived set of currently authorized claim members |
| `principal` | the same authenticated principal in the same namespace |

`SnapshotRef` and `ViewToken` use the scoped-token family below; they are not
`PublicRef` rows. Adding a public kind requires a schema revision, an FK-backed
typed target, codec coverage, reverse purge enumeration and denial tests.

```sql
-- Claims 5 / backup 6: durable issuance namespace and public references.
CREATE TABLE world_authorization_namespaces (
  namespace_id TEXT PRIMARY KEY CHECK(octet_length(namespace_id) BETWEEN 16 AND 128),
  principal_id TEXT NOT NULL CHECK(octet_length(principal_id) BETWEEN 1 AND 512),
  purpose_policy TEXT NOT NULL CHECK(octet_length(purpose_policy) BETWEEN 1 AND 4096),
  normalized_scope TEXT NOT NULL CHECK(octet_length(normalized_scope)<=16384),
  sensitivity_ceiling TEXT NOT NULL CHECK(sensitivity_ceiling IN
    ('public','personal','private')),
  wire_schema TEXT NOT NULL CHECK(octet_length(wire_schema) BETWEEN 1 AND 128),
  namespace_generation INTEGER NOT NULL CHECK(namespace_generation>0),
  state TEXT NOT NULL CHECK(state IN ('current','rotated')),
  UNIQUE(principal_id, purpose_policy, normalized_scope,
         sensitivity_ceiling, wire_schema, namespace_generation),
  UNIQUE(namespace_id, principal_id)
) STRICT;
CREATE UNIQUE INDEX world_authorization_namespaces_one_current
  ON world_authorization_namespaces(principal_id)
  WHERE state='current';
CREATE INDEX world_authorization_namespaces_principal
  ON world_authorization_namespaces(principal_id, state, namespace_id);

CREATE TABLE world_wire_refs (
  namespace_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  wire_ref TEXT NOT NULL CHECK(length(wire_ref)=43
    AND wire_ref NOT GLOB '*[^A-Za-z0-9_-]*'
    AND substr(wire_ref,43,1) GLOB '[AEIMQUYcgkosw048]'),
  ref_kind TEXT NOT NULL CHECK(ref_kind IN
    ('object','claim','admission','observation','event_version','receipt',
     'source','page','raw_subject','captured_subject','claim_group','principal')),
  issued_at TEXT NOT NULL CHECK(octet_length(issued_at) BETWEEN 1 AND 64),
  FOREIGN KEY(namespace_id, principal_id)
    REFERENCES world_authorization_namespaces(namespace_id, principal_id),
  PRIMARY KEY(namespace_id, wire_ref),
  UNIQUE(namespace_id, principal_id, wire_ref, ref_kind)
) STRICT;

CREATE TABLE world_wire_object_targets (
  namespace_id TEXT NOT NULL, principal_id TEXT NOT NULL, wire_ref TEXT NOT NULL,
  ref_kind TEXT NOT NULL CHECK(ref_kind='object'),
  handle_id TEXT NOT NULL REFERENCES semantic_handles(handle_id),
  FOREIGN KEY(namespace_id, principal_id, wire_ref, ref_kind)
    REFERENCES world_wire_refs(namespace_id, principal_id, wire_ref, ref_kind),
  PRIMARY KEY(namespace_id, wire_ref),
  UNIQUE(namespace_id, handle_id)
) STRICT;
CREATE INDEX world_wire_object_targets_reverse
  ON world_wire_object_targets(handle_id, namespace_id, wire_ref);

CREATE TABLE world_wire_claim_targets (
  namespace_id TEXT NOT NULL, principal_id TEXT NOT NULL, wire_ref TEXT NOT NULL,
  ref_kind TEXT NOT NULL CHECK(ref_kind='claim'),
  claim_id TEXT NOT NULL REFERENCES claims(claim_id),
  FOREIGN KEY(namespace_id, principal_id, wire_ref, ref_kind)
    REFERENCES world_wire_refs(namespace_id, principal_id, wire_ref, ref_kind),
  PRIMARY KEY(namespace_id, wire_ref),
  UNIQUE(namespace_id, claim_id)
) STRICT;
CREATE INDEX world_wire_claim_targets_reverse
  ON world_wire_claim_targets(claim_id, namespace_id, wire_ref);

CREATE TABLE world_wire_admission_targets (
  namespace_id TEXT NOT NULL, principal_id TEXT NOT NULL, wire_ref TEXT NOT NULL,
  ref_kind TEXT NOT NULL CHECK(ref_kind='admission'),
  claim_id TEXT NOT NULL, support_id TEXT NOT NULL,
  FOREIGN KEY(claim_id, support_id)
    REFERENCES claim_v2_support(claim_id, support_id),
  FOREIGN KEY(namespace_id, principal_id, wire_ref, ref_kind)
    REFERENCES world_wire_refs(namespace_id, principal_id, wire_ref, ref_kind),
  PRIMARY KEY(namespace_id, wire_ref),
  UNIQUE(namespace_id, support_id)
) STRICT;
CREATE INDEX world_wire_admission_targets_reverse
  ON world_wire_admission_targets(support_id, namespace_id, wire_ref);

CREATE TABLE world_wire_observation_targets (
  namespace_id TEXT NOT NULL, principal_id TEXT NOT NULL, wire_ref TEXT NOT NULL,
  ref_kind TEXT NOT NULL CHECK(ref_kind='observation'),
  support_id TEXT NOT NULL, observation_id TEXT NOT NULL,
  FOREIGN KEY(support_id, observation_id)
    REFERENCES claim_observations(support_id, observation_id),
  FOREIGN KEY(namespace_id, principal_id, wire_ref, ref_kind)
    REFERENCES world_wire_refs(namespace_id, principal_id, wire_ref, ref_kind),
  PRIMARY KEY(namespace_id, wire_ref),
  UNIQUE(namespace_id, observation_id)
) STRICT;
CREATE INDEX world_wire_observation_targets_reverse
  ON world_wire_observation_targets(observation_id, namespace_id, wire_ref);

CREATE TABLE world_wire_event_version_targets (
  namespace_id TEXT NOT NULL, principal_id TEXT NOT NULL, wire_ref TEXT NOT NULL,
  ref_kind TEXT NOT NULL CHECK(ref_kind='event_version'),
  event_id TEXT NOT NULL, event_hash_version INTEGER NOT NULL,
  event_hash TEXT NOT NULL, text_hash TEXT NOT NULL,
  origin_binding TEXT NOT NULL, event_accepted_at TEXT NOT NULL,
  FOREIGN KEY(event_id, event_hash_version, event_hash, text_hash,
              origin_binding, event_accepted_at)
    REFERENCES events(event_id, content_hash_version, content_hash, text_hash,
                      origin_binding, accepted_at),
  FOREIGN KEY(namespace_id, principal_id, wire_ref, ref_kind)
    REFERENCES world_wire_refs(namespace_id, principal_id, wire_ref, ref_kind),
  PRIMARY KEY(namespace_id, wire_ref),
  UNIQUE(namespace_id, event_id, event_hash_version, event_hash, text_hash,
         origin_binding, event_accepted_at)
) STRICT;
CREATE INDEX world_wire_event_versions_reverse
  ON world_wire_event_version_targets(event_id, event_hash_version, event_hash,
                                      namespace_id, wire_ref);

-- ReceiptRef has one public kind. This parent selects exactly one storage family;
-- the matching family child below proves that target exists.
CREATE TABLE world_wire_receipt_targets (
  namespace_id TEXT NOT NULL, principal_id TEXT NOT NULL, wire_ref TEXT NOT NULL,
  ref_kind TEXT NOT NULL CHECK(ref_kind='receipt'),
  receipt_variant TEXT NOT NULL CHECK(receipt_variant IN
    ('canon','allocation','purge')),
  receipt_id TEXT NOT NULL,
  FOREIGN KEY(namespace_id, principal_id, wire_ref, ref_kind)
    REFERENCES world_wire_refs(namespace_id, principal_id, wire_ref, ref_kind),
  PRIMARY KEY(namespace_id, wire_ref),
  UNIQUE(namespace_id, principal_id, wire_ref, ref_kind,
         receipt_variant, receipt_id),
  UNIQUE(namespace_id, receipt_variant, receipt_id)
) STRICT;

CREATE TABLE world_wire_canon_receipt_targets (
  namespace_id TEXT NOT NULL, principal_id TEXT NOT NULL, wire_ref TEXT NOT NULL,
  ref_kind TEXT NOT NULL CHECK(ref_kind='receipt'),
  receipt_variant TEXT NOT NULL CHECK(receipt_variant='canon'),
  receipt_id TEXT NOT NULL REFERENCES canon_receipts(receipt_id),
  FOREIGN KEY(namespace_id, principal_id, wire_ref, ref_kind,
              receipt_variant, receipt_id)
    REFERENCES world_wire_receipt_targets(
      namespace_id, principal_id, wire_ref, ref_kind, receipt_variant, receipt_id),
  PRIMARY KEY(namespace_id, wire_ref),
  UNIQUE(namespace_id, receipt_id)
) STRICT;
CREATE INDEX world_wire_canon_receipts_reverse
  ON world_wire_canon_receipt_targets(receipt_id, namespace_id, wire_ref);

CREATE TABLE world_wire_allocation_receipt_targets (
  namespace_id TEXT NOT NULL, principal_id TEXT NOT NULL, wire_ref TEXT NOT NULL,
  ref_kind TEXT NOT NULL CHECK(ref_kind='receipt'),
  receipt_variant TEXT NOT NULL CHECK(receipt_variant='allocation'),
  receipt_id TEXT NOT NULL
    REFERENCES semantic_allocation_receipts(allocation_receipt_id),
  FOREIGN KEY(namespace_id, principal_id, wire_ref, ref_kind,
              receipt_variant, receipt_id)
    REFERENCES world_wire_receipt_targets(
      namespace_id, principal_id, wire_ref, ref_kind, receipt_variant, receipt_id),
  PRIMARY KEY(namespace_id, wire_ref),
  UNIQUE(namespace_id, receipt_id)
) STRICT;
CREATE INDEX world_wire_allocation_receipts_reverse
  ON world_wire_allocation_receipt_targets(receipt_id, namespace_id, wire_ref);

CREATE TABLE world_wire_purge_receipt_targets (
  namespace_id TEXT NOT NULL, principal_id TEXT NOT NULL, wire_ref TEXT NOT NULL,
  ref_kind TEXT NOT NULL CHECK(ref_kind='receipt'),
  receipt_variant TEXT NOT NULL CHECK(receipt_variant='purge'),
  receipt_id TEXT NOT NULL REFERENCES event_purges(receipt_id),
  FOREIGN KEY(namespace_id, principal_id, wire_ref, ref_kind,
              receipt_variant, receipt_id)
    REFERENCES world_wire_receipt_targets(
      namespace_id, principal_id, wire_ref, ref_kind, receipt_variant, receipt_id),
  PRIMARY KEY(namespace_id, wire_ref),
  UNIQUE(namespace_id, receipt_id)
) STRICT;
CREATE INDEX world_wire_purge_receipts_reverse
  ON world_wire_purge_receipt_targets(receipt_id, namespace_id, wire_ref);

CREATE TABLE world_wire_source_targets (
  namespace_id TEXT NOT NULL, principal_id TEXT NOT NULL, wire_ref TEXT NOT NULL,
  ref_kind TEXT NOT NULL CHECK(ref_kind='source'),
  source_key TEXT NOT NULL REFERENCES source_grants(source_key),
  FOREIGN KEY(namespace_id, principal_id, wire_ref, ref_kind)
    REFERENCES world_wire_refs(namespace_id, principal_id, wire_ref, ref_kind),
  PRIMARY KEY(namespace_id, wire_ref),
  UNIQUE(namespace_id, source_key)
) STRICT;
CREATE INDEX world_wire_sources_reverse
  ON world_wire_source_targets(source_key, namespace_id, wire_ref);

CREATE TABLE world_wire_page_targets (
  namespace_id TEXT NOT NULL, principal_id TEXT NOT NULL, wire_ref TEXT NOT NULL,
  ref_kind TEXT NOT NULL CHECK(ref_kind='page'),
  page_id TEXT NOT NULL REFERENCES page_index(page_id),
  FOREIGN KEY(namespace_id, principal_id, wire_ref, ref_kind)
    REFERENCES world_wire_refs(namespace_id, principal_id, wire_ref, ref_kind),
  PRIMARY KEY(namespace_id, wire_ref),
  UNIQUE(namespace_id, page_id)
) STRICT;
CREATE INDEX world_wire_pages_reverse
  ON world_wire_page_targets(page_id, namespace_id, wire_ref);

CREATE TABLE world_wire_raw_subject_targets (
  namespace_id TEXT NOT NULL, principal_id TEXT NOT NULL, wire_ref TEXT NOT NULL,
  ref_kind TEXT NOT NULL CHECK(ref_kind='raw_subject'),
  raw_kind TEXT NOT NULL CHECK(raw_kind IN ('occurrence','supplied')),
  raw_id TEXT NOT NULL CHECK(octet_length(raw_id) BETWEEN 1 AND 1024),
  occurrence_id TEXT REFERENCES claim_occurrences(occurrence_id),
  FOREIGN KEY(namespace_id, principal_id, wire_ref, ref_kind)
    REFERENCES world_wire_refs(namespace_id, principal_id, wire_ref, ref_kind),
  CHECK(((raw_kind='occurrence' AND occurrence_id=raw_id)
      OR (raw_kind='supplied' AND occurrence_id IS NULL)) IS TRUE),
  PRIMARY KEY(namespace_id, wire_ref),
  UNIQUE(namespace_id, raw_kind, raw_id),
  UNIQUE(namespace_id, principal_id, wire_ref, raw_kind, raw_id)
) STRICT;
CREATE INDEX world_wire_raw_subject_targets_reverse
  ON world_wire_raw_subject_targets(raw_kind, raw_id, namespace_id, wire_ref);

CREATE TABLE world_wire_raw_subject_memberships (
  namespace_id TEXT NOT NULL, principal_id TEXT NOT NULL, wire_ref TEXT NOT NULL,
  raw_kind TEXT NOT NULL, raw_id TEXT NOT NULL,
  occurrence_id TEXT,
  event_id TEXT NOT NULL, event_hash_version INTEGER NOT NULL,
  event_hash TEXT NOT NULL, text_hash TEXT NOT NULL,
  origin_binding TEXT NOT NULL, event_accepted_at TEXT NOT NULL,
  source_key TEXT, grant_revision INTEGER, policy_digest TEXT,
  FOREIGN KEY(namespace_id, principal_id, wire_ref, raw_kind, raw_id)
    REFERENCES world_wire_raw_subject_targets(
      namespace_id, principal_id, wire_ref, raw_kind, raw_id),
  FOREIGN KEY(event_id, event_hash_version, event_hash, text_hash,
              origin_binding, event_accepted_at)
    REFERENCES events(event_id, content_hash_version, content_hash, text_hash,
                      origin_binding, accepted_at),
  FOREIGN KEY(event_id, source_key, grant_revision, policy_digest)
    REFERENCES source_event_bindings(event_id, source_key, grant_revision, policy_digest),
  FOREIGN KEY(occurrence_id, event_id, event_hash_version, event_hash, text_hash,
              origin_binding, event_accepted_at)
    REFERENCES claim_occurrences(occurrence_id, event_id, event_hash_version,
      event_hash, text_hash, origin_binding, event_accepted_at),
  CHECK(((raw_kind='occurrence' AND occurrence_id=raw_id)
      OR (raw_kind='supplied' AND occurrence_id IS NULL)) IS TRUE),
  CHECK(((source_key IS NULL AND grant_revision IS NULL AND policy_digest IS NULL)
      OR (source_key IS NOT NULL AND grant_revision IS NOT NULL
          AND policy_digest IS NOT NULL)) IS TRUE),
  PRIMARY KEY(namespace_id, wire_ref, event_id)
) STRICT;
CREATE INDEX world_wire_raw_memberships_event
  ON world_wire_raw_subject_memberships(event_id, namespace_id, wire_ref);
CREATE INDEX world_wire_raw_memberships_source
  ON world_wire_raw_subject_memberships(source_key, grant_revision, namespace_id, wire_ref);

CREATE TABLE world_wire_captured_subject_targets (
  namespace_id TEXT NOT NULL, principal_id TEXT NOT NULL, wire_ref TEXT NOT NULL,
  ref_kind TEXT NOT NULL CHECK(ref_kind='captured_subject'),
  raw_kind TEXT NOT NULL CHECK(raw_kind IN ('occurrence','supplied')),
  raw_id TEXT NOT NULL CHECK(octet_length(raw_id) BETWEEN 1 AND 1024),
  occurrence_id TEXT REFERENCES claim_occurrences(occurrence_id),
  supplied_event_id TEXT,
  supplied_event_hash_version INTEGER,
  supplied_event_hash TEXT,
  supplied_text_hash TEXT,
  supplied_origin_binding TEXT,
  supplied_event_accepted_at TEXT,
  source_key TEXT,
  grant_revision INTEGER,
  policy_digest TEXT,
  FOREIGN KEY(supplied_event_id, supplied_event_hash_version,
              supplied_event_hash, supplied_text_hash,
              supplied_origin_binding, supplied_event_accepted_at)
    REFERENCES events(event_id, content_hash_version, content_hash, text_hash,
                      origin_binding, accepted_at),
  FOREIGN KEY(supplied_event_id, source_key, grant_revision, policy_digest)
    REFERENCES source_event_bindings(event_id, source_key, grant_revision, policy_digest),
  FOREIGN KEY(namespace_id, principal_id, wire_ref, ref_kind)
    REFERENCES world_wire_refs(namespace_id, principal_id, wire_ref, ref_kind),
  CHECK(((raw_kind='occurrence' AND occurrence_id=raw_id
          AND supplied_event_id IS NULL
          AND supplied_event_hash_version IS NULL AND supplied_event_hash IS NULL
          AND supplied_text_hash IS NULL AND supplied_origin_binding IS NULL
          AND supplied_event_accepted_at IS NULL
          AND source_key IS NULL AND grant_revision IS NULL AND policy_digest IS NULL)
     OR (raw_kind='supplied' AND occurrence_id IS NULL
          AND supplied_event_id IS NOT NULL
          AND supplied_event_hash_version IS NOT NULL
          AND supplied_event_hash IS NOT NULL AND supplied_text_hash IS NOT NULL
          AND supplied_origin_binding IS NOT NULL
          AND supplied_event_accepted_at IS NOT NULL
          AND ((source_key IS NULL AND grant_revision IS NULL AND policy_digest IS NULL)
            OR (source_key IS NOT NULL AND grant_revision IS NOT NULL
              AND policy_digest IS NOT NULL)))) IS TRUE),
  PRIMARY KEY(namespace_id, wire_ref)
) STRICT;
CREATE UNIQUE INDEX world_wire_captured_occurrences_unique
  ON world_wire_captured_subject_targets(namespace_id, occurrence_id)
  WHERE raw_kind='occurrence';
CREATE UNIQUE INDEX world_wire_captured_supplied_unique
  ON world_wire_captured_subject_targets(
    namespace_id, raw_id, supplied_event_id, supplied_event_hash_version,
    supplied_event_hash)
  WHERE raw_kind='supplied';
CREATE INDEX world_wire_captured_raw_reverse
  ON world_wire_captured_subject_targets(raw_kind, raw_id, namespace_id, wire_ref);
CREATE INDEX world_wire_captured_event_reverse
  ON world_wire_captured_subject_targets(
    supplied_event_id, supplied_event_hash_version, namespace_id, wire_ref);

CREATE TABLE world_wire_claim_group_targets (
  namespace_id TEXT NOT NULL, principal_id TEXT NOT NULL, wire_ref TEXT NOT NULL,
  ref_kind TEXT NOT NULL CHECK(ref_kind='claim_group'),
  member_set_hash TEXT NOT NULL CHECK(length(member_set_hash)=64
    AND member_set_hash NOT GLOB '*[^0-9a-f]*'),
  member_count INTEGER NOT NULL CHECK(member_count BETWEEN 2 AND 16),
  FOREIGN KEY(namespace_id, principal_id, wire_ref, ref_kind)
    REFERENCES world_wire_refs(namespace_id, principal_id, wire_ref, ref_kind),
  PRIMARY KEY(namespace_id, wire_ref),
  UNIQUE(namespace_id, member_set_hash),
  UNIQUE(namespace_id, principal_id, wire_ref, ref_kind, member_count)
) STRICT;
CREATE TABLE world_wire_claim_group_members (
  namespace_id TEXT NOT NULL, principal_id TEXT NOT NULL, wire_ref TEXT NOT NULL,
  ref_kind TEXT NOT NULL CHECK(ref_kind='claim_group'),
  member_count INTEGER NOT NULL CHECK(member_count BETWEEN 2 AND 16),
  member_ordinal INTEGER NOT NULL
    CHECK(member_ordinal>=0 AND member_ordinal<member_count),
  claim_id TEXT NOT NULL REFERENCES claims(claim_id),
  FOREIGN KEY(namespace_id, principal_id, wire_ref, ref_kind, member_count)
    REFERENCES world_wire_claim_group_targets(
      namespace_id, principal_id, wire_ref, ref_kind, member_count),
  PRIMARY KEY(namespace_id, wire_ref, member_ordinal),
  UNIQUE(namespace_id, wire_ref, claim_id)
) STRICT;
CREATE INDEX world_wire_claim_groups_claim_reverse
  ON world_wire_claim_group_members(claim_id, namespace_id, wire_ref);

CREATE TABLE world_wire_principal_targets (
  namespace_id TEXT NOT NULL, principal_id TEXT NOT NULL, wire_ref TEXT NOT NULL,
  ref_kind TEXT NOT NULL CHECK(ref_kind='principal'),
  target_principal_id TEXT NOT NULL,
  FOREIGN KEY(namespace_id, principal_id, wire_ref, ref_kind)
    REFERENCES world_wire_refs(namespace_id, principal_id, wire_ref, ref_kind),
  FOREIGN KEY(namespace_id, target_principal_id)
    REFERENCES world_authorization_namespaces(namespace_id, principal_id),
  CHECK(target_principal_id=principal_id),
  PRIMARY KEY(namespace_id, wire_ref),
  UNIQUE(namespace_id, target_principal_id)
) STRICT;

-- Serve 10 runtime cache. Seed exactly 64 partition rows (0..63).
CREATE TABLE world_view_runtime (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  generation TEXT NOT NULL CHECK(length(generation)=32
    AND generation NOT GLOB '*[^0-9a-f]*')
) STRICT;
CREATE TABLE world_view_partitions (
  partition_id INTEGER PRIMARY KEY CHECK(partition_id BETWEEN 0 AND 63),
  principal_id TEXT UNIQUE CHECK(principal_id IS NULL
    OR octet_length(principal_id) BETWEEN 1 AND 512),
  reserved_at TEXT CHECK(reserved_at IS NULL
    OR octet_length(reserved_at) BETWEEN 1 AND 64),
  CHECK((principal_id IS NULL AND reserved_at IS NULL)
     OR (principal_id IS NOT NULL AND reserved_at IS NOT NULL)),
  UNIQUE(partition_id, principal_id)
) STRICT;

-- One token namespace serves exact knownAt snapshots and complete view baselines.
CREATE TABLE world_scoped_tokens (
  token_key_hash TEXT PRIMARY KEY
    CHECK(length(token_key_hash)=64 AND token_key_hash NOT GLOB '*[^0-9a-f]*'),
  token_kind TEXT NOT NULL CHECK(token_kind IN ('snapshot','view')),
  runtime_generation TEXT NOT NULL CHECK(length(runtime_generation)=32
    AND runtime_generation NOT GLOB '*[^0-9a-f]*'),
  partition_id INTEGER NOT NULL REFERENCES world_view_partitions(partition_id),
  principal_id TEXT NOT NULL CHECK(octet_length(principal_id) BETWEEN 1 AND 512),
  namespace_id TEXT NOT NULL
    REFERENCES world_authorization_namespaces(namespace_id),
  subject_scope_codec TEXT NOT NULL
    CHECK(octet_length(subject_scope_codec) BETWEEN 1 AND 128),
  normalized_subject_scope TEXT NOT NULL
    CHECK(octet_length(normalized_subject_scope)<=4096),
  valid_kind TEXT NOT NULL CHECK(valid_kind IN ('all','at','overlap','unknown_only')),
  valid_at TEXT, valid_from TEXT, valid_until TEXT,
  snapshot_seq INTEGER NOT NULL,
  snapshot_at TEXT NOT NULL,
  created_at TEXT NOT NULL CHECK(octet_length(created_at) BETWEEN 1 AND 64),
  expires_at TEXT NOT NULL CHECK(octet_length(expires_at) BETWEEN 1 AND 64),
  FOREIGN KEY(snapshot_seq, snapshot_at)
    REFERENCES core_authority_commits(admission_seq, admitted_at),
  FOREIGN KEY(namespace_id, principal_id)
    REFERENCES world_authorization_namespaces(namespace_id, principal_id),
  FOREIGN KEY(partition_id, principal_id)
    REFERENCES world_view_partitions(partition_id, principal_id),
  CHECK(((valid_kind IN ('all','unknown_only') AND valid_at IS NULL
          AND valid_from IS NULL AND valid_until IS NULL)
     OR (valid_kind='at' AND valid_at IS NOT NULL
          AND octet_length(valid_at) BETWEEN 1 AND 64
          AND valid_from IS NULL AND valid_until IS NULL)
     OR (valid_kind='overlap' AND valid_at IS NULL
          AND valid_from IS NOT NULL AND valid_until IS NOT NULL
          AND octet_length(valid_from) BETWEEN 1 AND 64
          AND octet_length(valid_until) BETWEEN 1 AND 64)) IS TRUE)
) STRICT;
CREATE INDEX world_scoped_tokens_principal_expiry
  ON world_scoped_tokens(principal_id, expires_at, created_at, token_key_hash);
CREATE INDEX world_scoped_tokens_partition_expiry
  ON world_scoped_tokens(partition_id, expires_at, token_key_hash);
CREATE INDEX world_scoped_tokens_expiry
  ON world_scoped_tokens(expires_at, token_key_hash);

CREATE TABLE world_view_payloads (
  token_key_hash TEXT PRIMARY KEY REFERENCES world_scoped_tokens(token_key_hash),
  query_codec TEXT NOT NULL CHECK(octet_length(query_codec) BETWEEN 1 AND 128),
  normalized_query TEXT NOT NULL CHECK(octet_length(normalized_query)<=8192),
  view_schema TEXT NOT NULL CHECK(octet_length(view_schema) BETWEEN 1 AND 128),
  projection_codec TEXT NOT NULL CHECK(octet_length(projection_codec) BETWEEN 1 AND 128),
  projection BLOB NOT NULL CHECK(octet_length(projection)<=262144),
  projection_fingerprint TEXT NOT NULL
    CHECK(length(projection_fingerprint)=64
      AND projection_fingerprint NOT GLOB '*[^0-9a-f]*'),
  projection_bytes INTEGER NOT NULL
    CHECK(projection_bytes=octet_length(projection) AND projection_bytes<=262144),
  coverage TEXT NOT NULL CHECK(octet_length(coverage)<=8192),
  metadata_bytes INTEGER NOT NULL CHECK(
    metadata_bytes=octet_length(query_codec)+octet_length(normalized_query)
      +octet_length(view_schema)+octet_length(projection_codec)
      +octet_length(projection_fingerprint)+octet_length(coverage)
    AND metadata_bytes<=8192)
) STRICT;
```

Token issuance and restore validate the requested validity interval with
`compareRfc3339`; the SQL arm checks the closed `ValidQuery` shape (`all`,
`at`, `overlap`, `unknown_only`). It never turns a point into an open interval. These
fields are part of the exact authorization scope and are not ordered as raw
text. The Core-generated fixed-precision UTC `created_at`/`expires_at` values
retain their lexicographic expiry indexes.

`purpose_policy` is the canonical closed projection of the principal's actual
permitted tool/relay grant and the versioned Core operation-to-source-use mapping.
It is stable across requests within that grant, not the currently selected request
purpose. The namespace never includes unrelated source policy or evidence state.
One current namespace per principal therefore preserves a permitted read's exact
ClaimRef for an authorized correction. Every resolver separately checks the
requested tool, purpose/source use and current membership; no target exchange or
implicit grant expansion occurs. View queries bind the selected operation/purpose
in their normalized query and cannot be replayed for another operation.

`wire_ref` is 32 CSPRNG bytes encoded as 43 unpadded base64url characters. In one immediate transaction, issuance looks up the complete exact typed target under its namespace and reuses the existing mapping, or inserts a fresh random ref and retries the negligible primary-key collision. This removes an otherwise unspecified durable namespace-HMAC key and its backup/custody problem. Each typed child has namespace-scoped target uniqueness; claim-group issuance hashes the canonical sorted member IDs only as an internal lookup accelerator and compares every member before reuse. The hash is neither exposed nor authority.

A `raw_subject` target has at least one exact retained membership. Memberships
are a checked projection of raw source custody, not semantic identity or new
beliefs. The writer/restore validator decodes the supplied raw ref from every
exact cited event, or verifies the exact occurrence tuple, and checks native
proof for a null source binding. Store canonical membership order by complete
event identity. On read, validate current authorization on each candidate; only
permitted memberships can sustain resolution and no hidden member enters ranking,
counts or output identity. The stable target token is bound to the raw pair,
not a representative event. A new membership reuses it. Purge removes selected
memberships before events, and deletes the target/common row only when no custody
membership survives; denial alone does not turn retained bytes into erased ones.
A mapping with no current permitted membership returns fixed `not_found`.

The closed codec maps every nested wire field to one top-level target child. A receipt target must additionally have exactly one matching receipt-family child, and a claim group must have exactly `member_count` distinct, canonically ordered members. Captured occurrence targets resolve through `claim_occurrences`; captured supplied targets are accepted only when the exact retained event decodes to contain that namespaced raw ref. Those cardinality/membership rules are checked before commit and on restore because a parent `CHECK` cannot count children or inspect an event codec. Purge uses every reverse index, deletes a removed target child and its common row together, and retains no old mapping tombstone. A common row without one valid live target is corrupt and never resolves.

The scoped view token is also 32 random bytes encoded as 43 unpadded base64url characters. The cache stores only `SHA-256(token_bytes)`; 256 bits of random entropy prevents useful dictionary recovery without a runtime secret or key-version lifecycle. `world_view_runtime.generation` is freshly randomized on every service start and restore, and cache replacement plus generation publication is atomic, so all earlier tokens fail closed. A timestamp `knownAt` convenience resolves once to the greatest internal `(snapshot_at, snapshot_seq)` at or before that timestamp and issues a cache-local `snapshot` token bound to the authenticated principal, authorization namespace, normalized subject scope, and requested valid window. It is repeatable only while unexpired and not evicted under its own principal quota; it is not a durable historical link. A view baseline uses `token_kind='view'` and must have exactly one `world_view_payloads` child; a snapshot token has none. Closed writer/restore validation enforces that child cardinality.

Both token kinds use the same 15-minute TTL and quotas. Before insert, the same immediate transaction checks at most 16 live tokens and 4 MiB of view `projection_bytes` for that principal. View metadata is capped at 8 KiB per token in addition to projection bytes, for at most 8 MiB across 64 full partitions; snapshot-token row fields are separately bounded above. There are 64 fixed principal partitions, so the total retained projection cap is 256 MiB. At a principal's count or byte cap, delete that principal's deterministic oldest token(s), ordered by `(created_at, token_key_hash)`, in the same transaction and then issue the replacement. Never evict another principal. If no partition is reserved or available, an ordinary current read may return freshly authorized data with `view:{status:"not_issued"}`; a timestamp convenience returns the existing `ViewResult` unavailable branch with its fixed budget/storage reason because it cannot promise a repeatable cutoff. Expiry deletes tokens but does not release the principal's reserved partition. Partition reassignment requires an explicit principal/namespace retirement operation.

Each view baseline records its exact dependency set for invalidation, purge, and complete comparison:

```sql
CREATE TABLE world_view_admissions (
  token_key_hash TEXT NOT NULL REFERENCES world_view_payloads(token_key_hash),
  claim_id TEXT NOT NULL,
  support_id TEXT NOT NULL,
  FOREIGN KEY(claim_id, support_id)
    REFERENCES claim_v2_support(claim_id, support_id),
  PRIMARY KEY(token_key_hash, support_id)
) STRICT;
CREATE INDEX world_view_admissions_reverse
  ON world_view_admissions(support_id, token_key_hash);

CREATE TABLE world_view_events (
  token_key_hash TEXT NOT NULL REFERENCES world_view_payloads(token_key_hash),
  event_id TEXT NOT NULL,
  event_hash_version INTEGER NOT NULL,
  event_hash TEXT NOT NULL,
  text_hash TEXT NOT NULL,
  origin_binding TEXT NOT NULL,
  event_accepted_at TEXT NOT NULL,
  FOREIGN KEY(event_id, event_hash_version, event_hash, text_hash,
              origin_binding, event_accepted_at)
    REFERENCES events(event_id, content_hash_version, content_hash, text_hash,
                      origin_binding, accepted_at),
  PRIMARY KEY(token_key_hash, event_id)
) STRICT;
CREATE INDEX world_view_events_reverse
  ON world_view_events(event_id, event_hash_version, event_hash, token_key_hash);

CREATE TABLE world_view_handles (
  token_key_hash TEXT NOT NULL REFERENCES world_view_payloads(token_key_hash),
  handle_id TEXT NOT NULL REFERENCES semantic_handles(handle_id),
  PRIMARY KEY(token_key_hash, handle_id)
) STRICT;
CREATE INDEX world_view_handles_reverse
  ON world_view_handles(handle_id, token_key_hash);

CREATE TABLE world_view_history (
  token_key_hash TEXT NOT NULL REFERENCES world_view_payloads(token_key_hash),
  transition_id TEXT NOT NULL
    REFERENCES claim_lifecycle_history(transition_id),
  PRIMARY KEY(token_key_hash, transition_id)
) STRICT;
CREATE INDEX world_view_history_reverse
  ON world_view_history(transition_id, token_key_hash);

CREATE TABLE world_view_coverage (
  token_key_hash TEXT NOT NULL REFERENCES world_view_payloads(token_key_hash),
  claim_id TEXT NOT NULL,
  first_complete_seq INTEGER NOT NULL,
  FOREIGN KEY(claim_id, first_complete_seq)
    REFERENCES claim_history_coverage(claim_id, first_complete_seq),
  PRIMARY KEY(token_key_hash, claim_id)
) STRICT;
CREATE INDEX world_view_coverage_reverse
  ON world_view_coverage(claim_id, first_complete_seq, token_key_hash);
```

Scoped tokens, partitions, view projections, and dependency rows are runtime sensitive cache and are excluded from backup/export. Every service start and restore generates a new `world_view_runtime.generation`, making every prior snapshot or view token `new_view_required`. Authorization namespaces and issued wire-reference mappings are durable backup v6 state so an otherwise unchanged permitted object reference does not silently change after restore.

Token resolution first computes `SHA-256(token_bytes)`, then checks kind, generation, expiry, principal, namespace, normalized subject scope/valid window, and current grant. A historical snapshot always reads at its stored exact cutoff while that cache token remains valid. A view token stores the prior baseline cutoff and projection; comparison builds a fresh complete authorized projection at a newly resolved current cutoff, then compares old and new. Recomputing at the saved cutoff would incorrectly return `unchanged` forever. The stored fingerprint is a comparison accelerator, not authority. No response serializes `snapshot_seq`; no global epoch, cache generation, hidden count, or denied dependency participates in semantic equality.

## Write, read, purge, and restore order

### Admission

1. Bound and decode all versioned inputs before opening the immediate transaction.
2. Generate random handles/IDs and save the occurrence-to-handle map in the durable decision.
3. In one immediate transaction insert the Core commit row, meaning if new, admission, exact event links, Observations/spans/attribution, typed endpoint support, dependencies, lifecycle transition, allocation receipt/binding, decision completion, outbox, and frontier.
4. Recheck exact events, source bindings, policy/correction fences, semantic/support full identities, DAG closure, and required endpoint support before commit.
5. Publish no public v2 writer until backup/restore, replay, correction, purge, and dual readers pass together.

### Read

1. Authenticate and apply current source/grant/scope/sensitivity before candidate discovery.
2. Select candidates through retained claims and complete permitted admissions. Apply the same known-at cutoff recursively.
3. Decode and compare normalized rows with the versioned payloads. Relation/alias indexes only accelerate this step.
4. Resolve identity within the permitted subgraph and replace all internal IDs with namespace wire refs.
5. Revalidate authorization and invalidation fences before serializing any bytes.

### Physical purge

1. Commit the existing purge/source-erasure intent and holds before asynchronous work.
2. Find fan-out through event, source, raw endpoint, support dependency, history, handle, canon, wire-ref, and view reverse indexes.
3. Retarget a binding only after proving a complete independently authorized survivor. Otherwise delete the current binding; delete its handle only after no retained historical revalidation references it.
4. Rewrite affected claim/canon/allocation receipts to their terminal arms. Transfer unfinished work to `purge_ops` first.
5. Explicitly delete view/cache rows, wire refs without surviving handles, derived indexes, endpoint support, dependency edges, Observations/spans, admissions, affected history, replay/materialization inputs, old JSONL records/preimages, then source events as planned.
6. Advance history coverage for surviving claims and rebuild derived stores. Enable secure delete before any destructive rewrite. Transfer every batch to selector-free pending maintenance, then checkpoint/truncate WAL, vacuum owned SQLite and verify owned files/generations. Publish completion only after the complete four-phase protocol below settles; completion cannot share the transaction that first scrubs private selectors.

Foreign-key failure is a purge-plan bug, not permission to add cascade. A terminal claim/canon/allocation row containing any old raw ref, path, content hash, model identifier, auxiliary claim/support/event linkage, operation kind, or inverse is invalid. Its explicitly permitted own bookkeeping ID and purge linkage remain. The separately declared event-purge journal retains only the minimal event identity metadata described below.

### Restore

Restore stages and validates every authority stream before publication: exact event identities/bindings, claims union arms, meaning/admission codec bytes and indexes, Observations/spans, endpoint support, dependency ownership/acyclicity, Core ordering, lifecycle/coverage, current-versus-retired revalidation closure, handle binding ownership, allocation/canon tombstones, purge linkage, every wire target/member cardinality, and namespace/wire-ref uniqueness. It rebuilds projections from authority, rotates only view runtime generation, and refuses a newer or malformed component instead of parser guessing.

## Required implementation verification

This appendix specifies a proposed schema; the following implementation receipts are required before enabling any public writer:

- a deterministic migration outcome for every existing `claims.status='purged'` and every canon JSONL line, including typed refusal when purge authority is missing;
- retained claim/canon invalid-enum, producer, numeric-range and hash refusal, plus the fixed neutral v2 common body/hash;
- one exact codec definition and canonicalization fixture for `kizuki.claim-meaning/v1`, `kizuki.claim-admission/v1`, `kizuki.observation-record/v1`, terminal claim/allocation/canon integrity, random wire-ref issuance/reuse, and claim-group member keys;
- SQLite migration tests with foreign keys enabled, collision preimage comparison, cycle and overflow refusal, same-time transaction ordering, and no partially visible parent row;
- `validAt` plus `knownAt` fixtures with offsets, unequal fractional precision and leap seconds, including late evidence and dependency cutoff contamination, current authorization, and `history_unavailable` after purge;
- ordinary correction/revocation retirement that preserves immutable historical revalidation, plus physical source loss with a complete survivor and without one, exact retarget/delete behavior, JSONL/FTS/replay/cache closure, WAL/VACUUM proof, and no old digest residue;
- principal isolation, denied-only change equality, 16-token/4-MiB and 64-partition/256-MiB limits, no hidden eviction, expiry, restore generation, and internal-ID wire canaries;
- mixed-version replay, backup v4/v5/v6, older-reader refusal, independent security/specification review, and `bun run verify` on the final composed head.

These requirements are not evidence that migrations, validators, backup/restore or world consumers already exist. Design acceptance requires independent review of this complete appendix with the main RFC; implementation acceptance additionally requires the receipts above.


## Purge 6 receipt authority and completion

Use table-copy replacements for the existing `event_purges` and `purge_ops`. Extend the existing receipt authority with a declared source-root arm; do not add another purge journal. Keep exact private execution material while it is needed. After logical verification, enter a **pending maintenance** phase with that material already scrubbed. Mark completion only after owned file, WAL, preimage and generation maintenance settles. A completed receipt proves the recorded completion at that time; it cannot promise a fresh target-by-target absence check after its target identifiers have been erased.

`packages/core/src/ledger/purge.ts:838,869` currently makes `batchReceipt` the **first event's receipt ID**. Later event receipts have distinct IDs and no batch column. New rows must persist `batch_receipt_id`. Never reconstruct old groups from equal reason, connector, timestamp, ULID proximity or insertion order.

Source revocation reserves a purge ULID in `source_grants` before execution (`packages/core/src/ledger/source-grants.ts:443–480`). An empty selection creates no `event_purges` row (`packages/core/src/ledger/purge.ts:807–829`), and recognition falls back to the mutable grant (`packages/core/src/ledger/purge.ts:774–777`). Regrant clears that field (`packages/core/src/ledger/source-grants.ts:418`). The historical `source_grant_receipts` codec has no purge receipt ID (`packages/core/src/ledger/source-grants.ts:89–98,361–374,558–587`), so it cannot recover this linkage later. Materialize the **same already-authorized reserved receipt ID** as a source-root row in the revoke transaction. For new source purges, it is the root even when events exist; every selected event gets a child receipt. Direct event purges may retain the first-event-as-root convention. Both use this one table.

Core event IDs are non-content ULIDs, not content hashes (`packages/core/src/ledger/ledger.ts:87,204`; `packages/core/src/util/ulid.ts:1–4,28–34`). They expose a 48-bit creation timestamp and a stable link, with an 80-bit random/monotonic component. They are not fully random or unlinkable. The anti-resurrection exception permits this metadata; it does not retain content fingerprints or prevent recapture of equal content under a new event ID. Source consent separately denies future ingress. Existing restore/accept paths must consult the retained event IDs to enforce replay denial.

### Proposed replacement DDL

These names are staged replacements, renamed together under the RFC's exclusive migration publication boundary. The temporary self-FK name follows the rename in SQLite. Every primary or referenced ID is additionally checked by the shared codec; SQL length checks alone do not establish that an ID was generated by Core.

```sql
CREATE TABLE event_purges_v6 (
  receipt_id TEXT PRIMARY KEY,
  batch_receipt_id TEXT NOT NULL
    REFERENCES event_purges_v6(receipt_id) DEFERRABLE INITIALLY DEFERRED,
  selection_kind TEXT NOT NULL CHECK(selection_kind IN ('event','source_root')),
  event_id TEXT,
  state TEXT NOT NULL CHECK(state IN ('pending','done')),
  phase TEXT CHECK(phase IN ('work','maintenance')),
  connector_id TEXT,
  reason TEXT,
  source_authority TEXT,
  created_at TEXT NOT NULL,
  done_at TEXT,
  sensitivity TEXT NOT NULL CHECK(sensitivity='private'),
  terminal_integrity TEXT,
  CHECK(length(receipt_id)=26 AND length(batch_receipt_id)=26),
  CHECK(
    (selection_kind='event' AND event_id IS NOT NULL AND length(event_id)=26)
    OR
    (selection_kind='source_root' AND event_id IS NULL
      AND receipt_id=batch_receipt_id)
  ),
  CHECK(connector_id IS NULL OR
    length(CAST(connector_id AS BLOB)) BETWEEN 1 AND 128),
  CHECK(reason IS NULL OR length(CAST(reason AS BLOB)) BETWEEN 1 AND 240),
  CHECK(source_authority IS NULL OR
    (length(CAST(source_authority AS BLOB))<=4096 AND
      CASE WHEN json_valid(source_authority)
        THEN json_type(source_authority)='object' ELSE 0 END)),
  CHECK(terminal_integrity IS NULL OR
    (length(terminal_integrity)=64 AND
     terminal_integrity NOT GLOB '*[^0-9a-f]*')),
  CHECK(COALESCE((
    (state='pending' AND phase='work' AND done_at IS NULL
      AND terminal_integrity IS NULL AND reason IS NOT NULL
      AND (
        (selection_kind='event' AND connector_id IS NOT NULL
          AND source_authority IS NULL)
        OR
        (selection_kind='source_root' AND connector_id IS NULL
          AND source_authority IS NOT NULL)
      ))
    OR
    (state='pending' AND phase='maintenance' AND done_at IS NULL
      AND terminal_integrity IS NULL AND connector_id IS NULL
      AND reason IS NULL AND source_authority IS NULL)
    OR
    (state='done' AND phase IS NULL AND done_at IS NOT NULL
      AND terminal_integrity IS NOT NULL AND connector_id IS NULL
      AND reason IS NULL AND source_authority IS NULL)
  ),0))
) STRICT;
CREATE UNIQUE INDEX event_purges_v6_event ON event_purges_v6(event_id)
  WHERE event_id IS NOT NULL;
CREATE INDEX event_purges_v6_batch
  ON event_purges_v6(batch_receipt_id,receipt_id);

CREATE TABLE purge_ops_v6 (
  op_id TEXT PRIMARY KEY,
  receipt_id TEXT NOT NULL REFERENCES event_purges_v6(receipt_id)
    DEFERRABLE INITIALLY DEFERRED,
  store TEXT NOT NULL CHECK(store IN (
    'coordinator','ledger_sqlite','canon_files','canon_receipt_stream',
    'attachments','retrieval','graph','source_files','world_cache'
  )),
  state TEXT NOT NULL CHECK(state IN ('pending','done')),
  phase TEXT CHECK(phase IN ('work','maintenance')),
  ids TEXT,
  proof TEXT,
  completion TEXT,
  created_at TEXT NOT NULL,
  done_at TEXT,
  sensitivity TEXT NOT NULL CHECK(sensitivity='private'),
  CHECK(length(op_id)=26 AND length(receipt_id)=26),
  CHECK(ids IS NULL OR (length(CAST(ids AS BLOB))<=1048576 AND
    CASE WHEN json_valid(ids) THEN
      json_type(ids)='array' AND json_array_length(ids)<=10000
      ELSE 0 END)),
  CHECK(proof IS NULL OR (length(CAST(proof AS BLOB))<=1048576 AND
    CASE WHEN json_valid(proof) THEN json_type(proof)='object' ELSE 0 END)),
  CHECK(completion IS NULL OR (length(CAST(completion AS BLOB))<=65536 AND
    CASE WHEN json_valid(completion)
      THEN json_type(completion)='object' ELSE 0 END)),
  CHECK(COALESCE((
    (state='pending' AND phase='work' AND ids IS NOT NULL
      AND completion IS NULL AND done_at IS NULL)
    OR
    (state='pending' AND phase='maintenance' AND ids='[]'
      AND proof IS NOT NULL AND completion IS NULL AND done_at IS NULL)
    OR
    (state='done' AND phase IS NULL AND ids IS NULL AND proof IS NULL
      AND completion IS NOT NULL AND done_at IS NOT NULL)
  ),0))
) STRICT;
CREATE UNIQUE INDEX purge_ops_v6_coordinator ON purge_ops_v6(receipt_id)
  WHERE store='coordinator';
CREATE INDEX purge_ops_v6_pending ON purge_ops_v6(created_at,op_id)
  WHERE state='pending';
CREATE INDEX purge_ops_v6_receipt ON purge_ops_v6(receipt_id,op_id);
```

The `store` vocabulary names verification families, not captured source labels, filenames, arbitrary plugin strings or a new storage abstraction. `ledger_sqlite` covers all authoritative and derived SQLite families enumerated by the RFC; `world_cache` covers all cache dependencies even when stored in SQLite. Configured retrieval/graph instances are separately enumerated operations of the appropriate family. A reviewed adapter maps each exact pending work binding to its existing owner. Unknown adapters refuse before deletion. The coordinator is an operation in the existing `purge_ops`, recording the complete required operation set; it is not a second journal or receipt authority. Exactly one coordinator is required for every batch, including a source root with zero events and zero configured retrieval stores. Source reservation creates that coordinator with pending work, `ids='[]'`, `proof=NULL`; this means planning has not run, never an empty successful plan. Before planning this is the batch's only operation. Destructive work and maintenance require its checked non-null `CoordinatorPlanV6` first. A non-coordinator work operation with empty IDs and null proof is invalid; inventory absence/whole-generation work must name its exact existing owned inventory/generation resource, not use the reservation encoding or an empty document check.

### Closed codecs and agreement checks

Use component `purge=6` dispatch and strict discriminated unions; reject every extra key. `Ulid` means the existing canonical `[0-7][0-9A-HJKMNPQRSTVWXYZ]{25}` validator. Every timestamp uses the shared RFC 3339 parser and exact comparator, never lexical SQL ordering. Every JSON object is byte-bounded before parse; every selected-work array has at most 10,000 unique strings, each at most 4096 UTF-8 bytes, with the one-MiB aggregate bound above. Split a larger authorized selection into declared operations before destructive work; do not truncate. The whole coordinator manifest is capped at 256 operation entries and 64 KiB; a larger plan refuses before deletion.

```ts
type Ulid = string & { readonly codec: 'canonical_ulid' };
type Sha256 = string & { readonly codec: 'lowercase_sha256' };
type Rfc3339 = string & { readonly codec: 'validated_rfc3339' };
type StoreV6 = 'ledger_sqlite' | 'canon_files' | 'canon_receipt_stream'
  | 'attachments' | 'retrieval' | 'graph' | 'source_files' | 'world_cache';
type CoverageV6 = 'exact_targets' | 'owned_generation' | 'inventory_absent';
type RequiredOpV6 = { opId: Ulid; store: StoreV6 };

type SourceAuthorityV6 = {
  schema: 'kizuki.purge-source-authority/v1';
  sourceKey: Ulid; revokeOperation: string; purgeReceiptId: Ulid;
  grantRevision: number; policyDigest: Sha256;
  sourceReceiptSequence: number; sourceReceiptDigest: Sha256;
};
// The source receipt itself lacks purgeReceiptId. The reservation transaction
// checks BOTH that exact receipt and the current source-grant reservation,
// then persists their linkage here before either can be replaced.

type WorkProofV6 = {
  schema: 'kizuki.purge-work-proof/v1';
  opId: Ulid; receiptId: Ulid; store: StoreV6;
  checked: number; found: string[]; verifiedAt: Rfc3339;
};
// Core constructs this from a validated adapter result bound to exact pending
// IDs and the actual configured store. No free-form adapter method survives.

type StoreResultV6 = {
  opId: Ulid; receiptId: Ulid; store: StoreV6;
  coverage: CoverageV6; checked: number; absent: true;
  verifiedAt: Rfc3339; scope: 'owned_vault'; externalCopies: 'out_of_scope';
  sensitivity: 'private';
};
type BatchResultV6 = {
  opId: Ulid; receiptId: Ulid; store: 'coordinator';
  required: RequiredOpV6[]; selectedEvents: number; pagesRewritten: number;
  scope: 'owned_vault'; externalCopies: 'out_of_scope'; sensitivity: 'private';
};
type MaintenanceProofV6 = {
  schema: 'kizuki.purge-maintenance/v1';
  result: StoreResultV6 | BatchResultV6;
};
type CompletionV6 = {
  schema: 'kizuki.purge-completion/v1';
  result: StoreResultV6 | BatchResultV6;
  completedAt: Rfc3339; integrity: Sha256;
};
type PendingOpV6 = CommonOpV6 & (
  | { store: 'coordinator'; state: 'pending'; phase: 'work'; ids: [];
      proof: null; completion: null; doneAt: null }
  | { store: 'coordinator'; state: 'pending'; phase: 'work'; ids: Ulid[];
      proof: CoordinatorPlanV6; completion: null; doneAt: null }
  | { store: StoreV6; state: 'pending'; phase: 'work'; ids: [string, ...string[]];
      proof: WorkProofV6 | null;
      completion: null; doneAt: null }
  | { state: 'pending'; phase: 'maintenance'; ids: [];
      proof: MaintenanceProofV6; completion: null; doneAt: null }
);
type CompletedOpV6 = CommonOpV6 & {
  state: 'done'; phase: null; ids: null; proof: null;
  completion: CompletionV6; doneAt: Rfc3339;
};
type CommonOpV6 = {
  opId: Ulid; receiptId: Ulid; store: StoreV6 | 'coordinator';
  createdAt: Rfc3339; sensitivity: 'private';
};
type CoordinatorPlanV6 = {
  schema: 'kizuki.purge-plan/v1';
  opId: Ulid; receiptId: Ulid;
  required: RequiredOpV6[]; selectedEvents: number;
};
type EventReceiptCommonV6 = {
  schema: 'kizuki.purge-event-receipt/v1';
  receiptId: Ulid; batchReceiptId: Ulid;
  createdAt: Rfc3339; sensitivity: 'private';
};
type EventSelectionV6 =
  | { selectionKind: 'event'; eventId: Ulid }
  | { selectionKind: 'source_root'; eventId: null };
type EventReceiptV6 = EventReceiptCommonV6 & (
  | ({ state: 'pending'; phase: 'work'; doneAt: null; terminalIntegrity: null;
       reason: string } & (
      | { selectionKind: 'event'; eventId: Ulid; connectorId: string;
          sourceAuthority: null }
      | { selectionKind: 'source_root'; eventId: null; connectorId: null;
          sourceAuthority: SourceAuthorityV6 }
    ))
  | (EventSelectionV6 & { state: 'pending'; phase: 'maintenance';
      doneAt: null; terminalIntegrity: null })
  | (EventSelectionV6 & { state: 'done'; phase: null;
      doneAt: Rfc3339; terminalIntegrity: Sha256 })
);
type FreshStoreAuditV6 = {
  store: StoreV6; inspected: number; absent: true; checkedAt: Rfc3339;
  coverage: 'owned_generation' | 'inventory_absent';
};
type PurgeVerificationV6 = {
  status: 'pending'; receiptId: Ulid; phase: 'reservation' | 'work' | 'maintenance';
} | {
  status: 'completed_at'; receiptId: Ulid; completedAt: Rfc3339;
  completion: CompletionV6[];
} | {
  status: 'fresh_absence'; receiptId: Ulid; completedAt: Rfc3339;
  completion: CompletionV6[]; fresh: FreshStoreAuditV6[];
};
```

`checked` is a safe integer from 0 through 10,000 for an exact-target chunk; `selectedEvents` is a safe nonnegative integer and equals actual event membership. `pagesRewritten` is the safe nonnegative count of canon pages actually rewritten by this batch, deduplicated while private work still exists; it does not require preserving their paths. `grantRevision` and `sourceReceiptSequence` are positive safe integers. `revokeOperation` obeys the existing source-operation grammar `[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}` and cannot start with `complete:`. A whole-generation verifier reports its actual bounded count or uses `inventory_absent` with zero; it cannot pretend to have checked target IDs it no longer possesses. The coordinator plan's `ids` are exactly the sorted required operation IDs. Each work operation's store binding and ID list are immutable once its plan is published; a proof is accepted only from that operation's actual adapter invocation and must be rechecked against its exact list on recovery. Catch-up creates new operation IDs and extends the coordinator transactionally before those operations run; it cannot replace selectors beneath an old proof. Store operation IDs resolve to exact pending resources through the existing store-specific owner and intent; any required source/path/generation binding remains private pending material, must be included in that owner's declared codec, and must be erased before maintenance. No undeclared lookup table or hash-only target recovery is allowed.

Event receipt decoding has two outer states: pending and done. Pending work has exactly the SQL-selected event/source-root branch and its private fields; pending maintenance has those SQL fields all null and omits them from its closed object. Done has exactly the IDs, selection discriminator, creation/completion times, private sensitivity and fresh terminal integrity. It contains no old reason, connector, source policy, request hash or content digest. Hash the canonical terminal object without `terminalIntegrity` with `kizuki.erasure-tombstone/v1\0`, consistent with the RFC terminal rule. Hash a `CompletionV6` without `integrity` under `kizuki.purge-completion/v1\0`; both hashes are corruption checks over permitted metadata, not independent evidence that deletion occurred. The fixed component dispatcher reconstructs the object from typed columns and checks all SQL-null/object-absent correspondences; no unchecked JSON copy supplies receipt state.

`PurgeVerificationV6` is the proposed existing owner-administration report, not a scoped world tool. Its arrays obey the 256-operation/64-KiB metadata bound. `fresh` names only actual newly inspected stores, may cover a strict subset of the historical batch, and never implies that unlisted stores were rechecked. Duplicate store families represent distinct configured instances validated privately against the existing owner inventory; no source name, private path or old selector enters the report. A missing adapter or failed new audit returns an explicit verification failure, retaining the historical `completed_at` evidence; it cannot fabricate a successful fresh row. `inspected` is a nonnegative safe count of the scope actually examined. The existing CLI renders the result distinction and store coverage explicitly.

The same writer, migration, replay and restore validator must enforce the relationships SQL cannot express: the batch pointer names a self-root; source roots have no event ID; no cross-batch chain/cycle; every operation names that root; exactly one coordinator and, once planned, exactly its listed store operations exist; a reserved coordinator has no other operations; row fields equal codec fields; source-root reservation is checked against its existing authorized operation; event selection matches exact receipt membership; per-store exact-target proof `checked` equals the requested ID count, `found` is a subset, and store identity matches the actual binding; no duplicated, missing, unknown or late unlisted store; and all relevant pending source-erasure intents/holds participate before completion. Whole-generation/inventory coverage requires the existing owner's actual inspection, separately from an exact-document proof. Final event rows and all operation rows have one consistent batch completion time. A terminal root cannot coexist with pending work in its batch. The source-root subtype also makes the RFC's existing claim/canon/allocation and purge wire-reference foreign keys total for supported zero-event/source receipts.

For source-root work, restore/migration must stage the source authority streams before validating or publishing the root. The current restore order imports event purge rows before source policy receipts (`export.ts:1820–1826,2041–2066`); that order cannot publish a partially checked v6 root. Require the exact `sourceReceiptSequence` row, a non-null matching receipt digest, its closed revoke receipt codec, matching source key/revoke operation/prior and revoked revisions/policy digest, and the current pending source-grant reservation of this exact purge receipt ID. A legacy nullable receipt digest does not establish this linkage. Pending maintenance roots have deliberately scrubbed authority: validate their already-established coordinator/store maintenance receipts and fail closed on inconsistency; do not reconstruct old authority or resume selector-dependent work. Terminal roots validate through their completed batch metadata, never a mutable current grant.

### Completion and recovery order

1. Under the existing writer/maintenance ownership, persist the exact-selection root, event children, private work, existing source-erasure intents and canon holds before deleting their evidence. A source root and its reserved coordinator are created in the source revoke transaction; they cannot by themselves mean planning or deletion has started. Persist the full coordinator plan before starting store work. Consumers must distinguish reservation, work, maintenance and completion by checked coordinator state, not receipt existence.
2. Finish exact-ID deletion and verification for every required store, all new world tables, receipt stream rewrites and independently grounded survivors. Catch-up discovery extends the persisted coordinator before new work runs. A timeout retains ownership until the real external operation settles; a process restart resumes through durable pending work. No adapter failure, malformed proof or missing configured store becomes an empty success.
3. Once no logical erasure step needs the old identifiers or hashes, one transaction changes all batch operations to pending maintenance with `ids='[]'` and only `MaintenanceProofV6`; null all event receipt private fields and remove old payload-bearing intents. Persist the existing durable maintenance hold/coordinator so restart cannot serve, back up, regrant around, or republish intermediate state. Restart now repeats selector-free maintenance of owned stores/generations, using their existing ownership inventory. If a store still needs sensitive selectors for recovery, it has not reached this boundary.
4. Complete/fsync replacement receipt streams and owned files, remove old temporary copies/preimages, rebuild affected FTS/shadow structures and sanitize owned SQLite/WAL/generations. A failed or busy checkpoint stays pending. Only then publish the terminal batch rows and completion codecs, with `ids=NULL`, `proof=NULL`, and all event-private fields null. The final transaction and its predecessor contain only permitted non-content metadata, so final checkpoint retry does not require retaining erased selectors. Release the maintenance hold after the final durability check.

This intermediate maintenance arm is necessary: changing `ids` from sensitive JSON to null in the same transaction that claims physical completion otherwise leaves the previous sensitive version in WAL/preimages after the claim. Keep the existing source/canon intent ownership; this is a phase extension, not another erasure authority.

### Existing consumers that must change together

| Consumer | Required behavior |
| --- | --- |
| `ledger/purge.ts:281–300,537–604` (`parseJsonStrings`, `parseProof`, `rowToOp`, `listOps`) | Replace the current empty-array/null fallbacks and unknown-state-to-pending coercion with closed decoding and typed refusal; keyset-page bounded scans. Dispatch pending work, pending maintenance and done without reconstructing target IDs. |
| `ledger/purge.ts:838–950` (`purgeEventsLocked`) | Persist explicit batch membership and complete store inventory; support the already-reserved source root. Keep first-event-root compatibility only for ordinary event purges. |
| `ledger/purge.ts:969–1002,1201–1274` (`ownedErasureProof`, `reconcileOps`, `verifyPurge`, `resumePurge`) | Verify the exact store and selection while work is pending, then use the maintenance and completion protocol. Source inventory status alone must not fabricate a fresh count after scrub. Normalize any child receipt to its persisted root. |
| `ledger/purge.ts:245–252,1025–1035,1097–1105` | Historical connector enumeration excludes null/completed receipt payload and uses remaining events/connections/source policy. Anti-resurrection citation lookup uses only non-null event IDs. Catch-up holds cannot read a completed reason or append IDs to a terminal operation. |
| `ledger/purge.ts:1230–1246` | `pages_rewritten` currently infers from canon receipt provenance and only `event_purges.receipt_id=?`, i.e. the first event. Use recorded non-content completion counts; erased canon provenance and unlinked later events cannot support this query. |
| `ledger/source-grants.ts:443–587,828–882` | Reserve the generalized source root with the existing receipt ID; distinguish root reservation from completed selection, block regrant while its operation needs old authority, and preserve historical recognition after regrant. Source status becomes complete only with checked batch completion and owned-store maintenance. |
| `canon/source-erasure-intent.ts:75–101`; `canon/apply.ts:843–900`; `ledger/source-erasure.ts:14–63,251+` | Retain old receipt/path/policy digests only while exact recovery needs them. Transfer work before terminalizing receipts, then delete/scrub intents and source inventory reports including affected IDs and hashes. The declared source-consent policy record may remain; old payload reports are not policy authority. |
| `ledger/source-canon-erasure.ts:254–313` | Replace the existing partial field scrub in SQLite/JSONL with the same closed terminal receipt union. Existing before/after hashes and provenance must not survive in old stream lines. |
| `export.ts:162–168,667–680,1420–1431,1944–1958` | Add component-dispatched backup/restore codecs for both receipt arms and completed operations; current purge backup requires reason/connector and omits `purge_ops`. Refuse backup during pending maintenance. Complete backup must include the terminal coordinator/store receipts needed to justify terminal foreign keys. Do not export old source-report payload as completion metadata. |
| `claims/identity.ts:193–200`; event accept/restore | Preserve exact event anti-resurrection membership, excluding source-root null IDs. Do not treat a new equal-content ID as the same purged record. |
| `serve/rails.ts:177–213`; `serve/doctor.ts:308–337`; CLI purge verification | Sweep must resume actual work/maintenance (the current sweep calls verification only); doctor counts both pending phases. CLI distinguishes current absence observations from historical completion and never prints a scrubbed reason. |

For `verifyPurge`, use the closed `PurgeVerificationV6` union: `pending`, `completed_at` with recorded per-store completion metadata, or `fresh_absence` with genuinely new observations. Do not return a newly timed `AbsenceProof` for a terminal exact-target operation by calling `verifyAbsent([])`. A fresh full-owned-generation audit is possible only where the adapter actually enumerates and proves that scope; it does not recreate the erased target selection. This explicitly amends RFC0002 §13.1's repeated per-target `--verify` promise and architecture invariant 14 at the contract boundary.

### Legacy migration and verification

Copy in bounded pages under the exclusive maintenance boundary; publish both tables and all terminal FK consumers atomically after their shared validator succeeds. Preserve the original five legacy receipt fields until exact completion eligibility is established. Legacy `purge_ops.state='done'`, an empty `found` array or receipt existence alone cannot prove the full Purge6 store closure. Validate old work/proofs against their declared adapter and exact membership; verify configured stores, owned payload/files, holds and source intent recovery. A current check gets its current timestamp; never backdate new world-store verification to an old `done_at`.

Recover an old batch only from an existing exact operation/selection binding that demonstrably names all its members and the original root; the v5 op's complete validated event selectors can be such evidence, while matching time/reason cannot. An existing current source reservation can bind its old source root, with its recorded revoke authority checked; a regranted source whose reserved purge ID was lost cannot. Never fabricate an event for a zero-event root. A previously purged claim likewise needs exact receipt/selection and completion linkage before becoming a valid terminal claim. Missing or ambiguous evidence returns `repair_required` with a bounded owner-only affected count and leaves the source database untouched. It does not silently discard rows, invent singleton batches, add fake authority, or execute an irreversible new purge merely because upgrade was requested.

Acceptance fixtures must cover multi-event roots and child receipt lookup; source zero-event reservation, crash and later regrant; migration with missing/ambiguous historical grouping; unavailable/unknown stores; corrupt IDs/proof/extra keys; late-discovered work; each crash boundary through payload-free maintenance; JSONL replacement without duplicate IDs; all terminal receipt FKs; backup/restore after completion; attempted resurrection of a retained event ID; and truthful historical versus fresh verification. Existing tests that inspect completed `purge_ops.ids` must instead verify observable deletion and a payload-free completion row. These are future implementation gates, not passes claimed here.


## Reproduce the design checks

Use pinned Bun 1.3.10 from the repository root:

```bash
bun rfcs/fixtures/validate-world-design.ts
bun rfcs/fixtures/validate-world-storage.ts
```

The first command validates the synthetic fixture inputs and declared oracle
relationships. The second executes this appendix's SQL against explicitly
minimal synthetic parent tables, checks every FK target, and exercises positive
and negative constraints including terminal NULL arms, exact ownership, current
versus retired bindings, wire target variants and v1-only body idempotency.
Negative ownership cases check the actual rejection cause so a duplicate index
cannot masquerade as a missing FK. These checks do not execute a production
migration, codec parser, policy resolver, erasure engine, backup or world read.
They support review of the proposed contract; consumer acceptance remains the
separate implementation work specified above.
