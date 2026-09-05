# RFC 0004: A claim-backed world model and scoped views

Status: **Proposed — not binding and not implemented**. Date: 2026-09-05.
Owner: Kizuki core. Design packet: #481.
Implementation baseline: `a96c5f4a4455d22fb4b40537c308c6d019a36d0d`.

This proposal reconciles the world-model epic (#497)
with [RFC 0003](0003-rich-subject-foundation.md), which is merged as an explicitly
**Proposed** document. Its pure contracts exist; its durable writer and identity
lifecycle do not. This RFC authorizes neither migrations nor public capability
claims. Binding [RFC 0002](0002-autonomous-canon.md), [RFC 0000](0000-constraints.md)
and the [decision log](../docs/decision-log.md) govern until an accepted amendment
explicitly changes the named contract.

## Problem and first useful outcome

A person should be able to resume a project with another authorized client,
retain its decisions and constraints, and correct an interpretation once. The
current evidence/claim/context seams can prove an initial continuity journey
under #502 Stage A. They do not
yet provide stable Concept identity, complete interpreted provenance, or a
permission-safe world revision/diff protocol.

The first semantic delivery is one evolving **Concept card**: a useful bounded
description, attributable definitions and disagreement, independently evidenced
personal learning facets, known coverage and freshness limits, and exact
correction/history links. Its machine result and existing interface projections
must mean the same thing for the same principal. Automatic cross-source
resolution requires its own real producer and held-out quality proof; manually
seeded claims establish only mechanics.

This RFC defines the shared contract and the first slice. It does not install
every noun in the roadmap, a task manager, agent executor, new chat UI, competing
belief database, or mandatory model-backed read path. Questions, situations,
skills and outcome learning reuse these contracts in subsequent bounded packets.

## Authority and compatibility decisions

| Source and present status | Preserve | Explicit proposal or amendment |
| --- | --- | --- |
| RFC 0000 / RFC 0002, binding | Frozen `kizuki.event/v1`; append-only capture except receipted physical purge; local SQLite authority; Markdown canon; grants below adapters; untrusted capture | No ingress change, new engine, network dependency or second canon writer |
| RFC 0002 / decisions D9–D16, binding | Autonomous receipted canon; highest owner correction; supersession/undo; automatic sensitivity; useful model-free capture, ledger, search, timeline, context, audit and undo | No owner review/promote queue; autonomous model interpretation and canon still need a configured model |
| RFC 0002 §6.5, §10.6 and §17, binding legacy packet | Machine-origin marker and model-free authorized reads | Explicit envelope/surface major negotiation below replaces all global epochs and denied counts for scoped clients; conditional/diff/as-of capabilities require their own implemented consumer tests |
| RFC 0002 §7.1–7.2 and §16.4, binding undo and irreversible purge | Exact undo of retained bytes; one receipted writer; purge already irreversible | Extend the physical-purge exception to dependent prose, archived preimages, receipt hashes and linkage; erased receipt tombstones cannot undo or restore removed content |
| RFC 0003 B1a, pure contracts implemented | Exact v1/v2 parsers, immutable raw refs, perspective, original validity, explicit producer-major binding, no public v2 writer | Keep anchored `kizuki.claim/v2` admission DTO unchanged; use a separately named private durable meaning codec, with explicit version dispatch |
| RFC 0003 B1b–d, incomplete draft #500 | One shared claim writer and complete lifecycle merge group; original admission snapshots; atomic frontier/outbox effects | Resolve support-specific rendering, history erasure, dependency closure and typed readers below before exposing any durable v2 mutation |
| RFC 0003 A1, proposed | Receipted raw-ref identity controls, bounded components, owner negative constraints, immutable assertions, undo and source fences | Add opaque handle allocation as receipted bookkeeping; never use handles to replace raw semantic keys; resolve identity separately for each permitted view |
| RFC 0003 B2/C and issue #472, proposed | Real grounded producer, closed vocabulary, automatic identity qualification and authorized projections | Deliver the small Concept vocabulary and its required projections first; defer the broader taxonomy, not shared lifecycle correctness |
| #476, owner product direction | UX/DX/AX parity, evidence, independent commitments, low ceremony | Later Concept-first direction supersedes Situation-first delivery; retain Situation work in #488 |
| #480/#497/#496/#502/#503, owner direction | Partial/fallible understanding, cross-client continuity, day-one evaluation and bounded consolidation | Their diagrams are conceptual dependencies, not separate databases or a requirement that every read traverse canon |

Canon is a durable projection produced only by the existing receipted writer.
Authorized reads may use evidence, claims, canon and rebuildable indexes. A
slice's display Markdown is not canon; canon is never generated from a client
slice or agent context. No inferred mental state becomes an observed fact.

## Existing seams and missing prerequisites

Reuse `packages/core/src/contracts/{event,producer-v2,claim-v2}.ts`, the shared
producer result boundary, ledger source grants, claims/staging, correction,
canon receipts, serving, and the extraction transaction/outbox. Existing core
operations own storage; adapters do not query component tables directly.

The pure `RawSubjectRef` has exactly `occurrence | supplied`. A connector's
supplied identifier is namespace-bound source identity, not a world object ID.
A mention is one source occurrence. The proposed B1b meaning codec, support,
dual readers and history are incomplete; no stable semantic object, complete
Observation, lineage DAG or world-view token exists at this baseline.

Before the first public Concept write, complete B1b–d's migrations, common
admission, temporal consumers, replay, backup/restore, correction and every
source-loss path together. Then complete the required A1 identity subset and
#483 dependency/view lifecycle. The current A0 alias refusal cannot be bypassed
with a Concept-specific alias table.

## Identity: six different things

| Thing | Identity and meaning | Authority/lifecycle |
| --- | --- | --- |
| Source record/version | Source binding plus record ID and exact accepted event/hash version | Immutable ingress evidence; revisions are distinct records of evidence |
| Real-world occurrence | A meeting, delivery or role change that records describe | A semantic object inferred/asserted through claims; two records need not describe two real occurrences |
| Observation | A source-faithful evidence selection with exact spans and source-supplied attribution | Normalized child of a checked support admission, not another ledger |
| Mention/raw endpoint | Existing occurrence tuple or exact supplied ref | Immutable; names and resolution never rewrite it |
| Semantic handle | Random opaque 128-bit identifier allocated by Core | Minimal receipted bookkeeping; no name, type, confidence or belief authority in the handle row |
| Assertion | Existing shared claim ID and raw semantic key | Proposition, perspective, context and original validity remain immutable; changes create controls/supersession/history |

Each newly admitted raw endpoint may acquire one persistent handle, in the same
transaction as its first qualifying assertion, complete support and allocation
receipt. Orphan model mentions allocate nothing. The writer persists the random
allocation in the saved decision before acknowledging completion; replay uses
that saved map. Handles are 32 lowercase hexadecimal characters from 16 cryptographically random
bytes; generation rejects collisions inside the transaction. They encode no time,
source or content. Unique raw-ref binding plus full collision checks make retries
idempotent. Connector-supplied refs retain their exact namespace and authority.

Handles are not a new `RawSubjectRef` kind and never enter existing semantic
keys. A handle has no truth merely because it exists. Type, label, definition,
membership and relations are qualified assertions about its bound raw refs.
Correcting a classification changes claims, not the handle's identity.

An identity merge adds an accepted, receipted same-as relationship over raw refs
under A1; it never rewrites claims or moves every binding to a chosen survivor.
Separation retracts eligible crossing edges and adds the owner negative
constraint; original handles remain. Undo uses the existing checked inverse and
after-component fence. A1's 256-member / 1,024-edge / 256-page bounds and
2..16 complete partitions remain; overflow refuses the whole mutation.

Automatic merging requires the A1 independent-root and authority rules, complete
endpoint support, no owner separation and a valid component fence. Name equality,
co-occurrence, embedding similarity or two copies cannot decide identity.
Ambiguity is an ordinary result. An owner correction may resolve it through the
same narrow authority path; it never supplies a general write grant.

**Stable references are not a global canonical representative.** An issued
handle remains addressable while it has permitted complete support. A lookup
keeps the requested handle as its anchor. A discovery result deduplicates only
within the authorized identity subgraph; deterministic representative selection
uses only that subgraph. Adding a hidden member or hidden merge cannot change
the visible anchor, labels, grouping, rank or counts. Different principals can
legitimately see different groupings. Merge/separation may change a visible
group, but retained member handles are still resolvable subject to current
policy, so old client references do not silently name an unrelated object.

External object references are random 32-byte opaque values allocated once per
authorization namespace and exact typed target. The durable mapping has uniqueness
on both its token and its namespace/kind/target tuple; lookup reuses the saved ref.
There is no content-derived pseudonym or durable derivation key to back up. Core resolves them
under the authenticated principal; the token itself confers no authority. The
namespace binds principal, normalized permitted scope/purpose/ceiling and schema,
remains stable through ordinary visible evidence additions, and rotates when
that authorization namespace changes. Losing all authorized support makes a
previous object indistinguishable from an unavailable/unknown reference.

## Exact proposed semantic contracts

The following are design contracts, not exported runtime symbols. Durable codecs
and authorized wire codecs are distinct closed discriminated types. The existing
`RawSubjectRef`, `ClaimV2Perspective` and `AuthorityTier` names refer to their
actual Core contracts. Branded identifiers prevent accidental cross-kind use;
parsers enforce the underlying byte, kind and identifier constraints at runtime.

```ts
type InternalId<K extends string> = string & { readonly internalKind: K };
type KnownTime =
  | { kind: "known"; from: string; until: string | null }
  | { kind: "unknown" };
type Recorded = { admittedAt: string; admissionSeq: number };
type EpistemicKind = "observed" | "reported" | "owner_assertion"
  | "model_inference" | "hypothesis" | "recommendation" | "scenario";
type DurableEvidence = {
  id: InternalId<"evidence">;
  admissionId: InternalId<"admission">; eventId: InternalId<"event">;
  eventHashVersion: 1 | 2; eventHash: string;
  textHash: string; originBinding: string; eventAcceptedAt: string;
  sourceBinding: { sourceKey: string; grantRevision: number; policyDigest: string } | null;
  span: { kind: "text"; startUtf16: number; endUtf16: number }
      | { kind: "metadata"; field: string };
};
type DurableObservation = {
  schema: "kizuki.observation-record/v1"; id: InternalId<"observation">;
  admissionId: InternalId<"admission">; evidence: readonly DurableEvidence[];
  attribution: readonly {
    id: InternalId<"attribution">;
    role: "sender" | "recipient" | "quoted_author" | "thread" | "place";
    ref: RawSubjectRef; basis: "source_field"; field: string;
    evidenceIds: readonly InternalId<"evidence">[];
  }[];
  fidelity: "verbatim_text" | "source_metadata" | "lossy_transcript";
  occurred: KnownTime; sourceObservedAt: string | null;
  recorded: Recorded;
};
// Closed wire objects; tokens resolve only in the current authorization namespace.
type Ref<K extends string> = { kind: K; token: string };
type ObjectRef = Ref<"object">;
type ClaimRef = Ref<"claim">;
type AdmissionRef = Ref<"admission">;
type EventVersionRef = Ref<"event_version">;
type ReceiptRef = Ref<"receipt">;
type EvidenceRef = {
  admission: AdmissionRef; eventVersion: EventVersionRef;
  span: { kind: "text"; startUtf16: number; endUtf16: number }
      | { kind: "metadata"; field: string };
};
type Perspective = {
  holder: ObjectRef | null; speaker: ObjectRef | null; addressee: ObjectRef | null;
  mode: "asserted" | "quoted" | "reported" | "hypothetical" | "suggested"
      | "questioned" | "uncertain";
  interpretation: "explicit" | "inferred";
  evidence: readonly EvidenceRef[];
};
type AdmissionAssessment = {
  admission: AdmissionRef; epistemicKind: EpistemicKind; authority: AuthorityTier;
  confidence: { kind: "known"; value: number } | { kind: "unknown" };
  independence: "independent" | "dependent" | "unknown";
  evidence: readonly EvidenceRef[];
};
type KnowledgeNode = {
  schema: "kizuki.knowledge-node/v1";
  ref: ObjectRef; kind: "concept"; classificationClaims: readonly ClaimRef[];
  labels: readonly { text: string; claim: ClaimRef }[];
  resolution: "distinct" | "resolved" | "ambiguous";
};
type Relation = {
  schema: "kizuki.relation/v1"; claim: ClaimRef;
  subject: ObjectRef; predicate: string;
  object: { kind: "node"; ref: ObjectRef }
        | { kind: "literal"; value: string }
        | { kind: "vocabulary"; id: string };
  perspective: Perspective; context: readonly ObjectRef[];
  polarity: "positive" | "negative"; valid: KnownTime;
  temporalBasis: "explicit" | "observed" | "unknown";
  assessments: readonly AdmissionAssessment[];
  conflict: "none_observed" | "present" | "unknown";
};
type Observation = {
  schema: "kizuki.observation/v1"; ref: Ref<"observation">;
  evidence: readonly EvidenceRef[];
  attribution: readonly {
    role: "sender" | "recipient" | "quoted_author" | "thread" | "place";
    ref: ObjectRef; basis: "source_field"; field: string;
  }[];
  fidelity: "verbatim_text" | "source_metadata" | "lossy_transcript";
  occurred: KnownTime; sourceObservedAt: string | null; admittedAt: string;
};
type StateTransition = {
  schema: "kizuki.state-transition/v1";
  claim: ClaimRef; causeReceipt: ReceiptRef | null; recordedAt: string;
  before: "absent" | "active" | "retracted" | "superseded";
  after: "active" | "retracted" | "superseded";
  valid: KnownTime;
};
```

The private meaning codec is `kizuki.claim-meaning/v1`: it keeps the complete
assertion discriminator, raw subject/object, predicate, polarity, anchor-free
perspective, context, original validity and temporal basis. It has neither
rendering nor source anchors. `kizuki.claim-admission/v1` owns the immutable
checked anchored DTO, producer/model, Core authority, epistemic kind, confidence,
recorded stamp, exact support/lineage and independently attributable rendering.
Both use explicit schema dispatch, never the anchored DTO parser as a fallback.
Identity controls keep their distinct existing discriminator and A1 receipt path.

Wire refs for every object/claim/admission/event-version/observation/receipt use
32 cryptographically random bytes, encoded as 43 unpadded base64url characters.
Their kind is a separate closed discriminator. Core allocates and persists each
exact namespace/kind/target mapping atomically, reuses it for that tuple, and
retries a random collision without changing the target. Names, hashes, internal
sequences and source IDs never substitute for refs. Durable mapping rows survive
backup/restore only with valid typed targets and current policy; physical purge
and authorization-namespace retirement erase their sensitive targets and tokens.
No derivation secret or raw target appears in the wire value. Event-version refs name an exact retained version
without publishing its content digest. The protected resolver performs current
support authorization before returning the object; the ref does not grant access.
All identified endpoints and perspective/context roles must have complete
permitted support, or that admission cannot contribute to the result. Do not
replace an inaccessible known holder with null to make the assertion serveable.
Null means an actually unknown role in the admitted meaning.

A well-formed absent, purged, revoked, wrong-namespace or denied object reference
returns exactly `{status:"not_found"}` without differing counts or lifecycle
explanations. `new_view_required` is exclusively a view/cursor-token outcome,
never an object-existence oracle. Invalid syntax returns a fixed validation error
before lookup. Operation-level grant denial is independent of object existence.
All wire arrays have explicit registry/response bounds; no raw `unknown` field or
arbitrary nested JSON is part of these semantic codecs. Admission assessments
stay separate; conflict and confidence describe only the permitted evidence.

The world-read root fixes card composition rather than leaving generic `T` to
adapters. A summary is optional derived prose, with complete authorized admission
support; definitions and qualifiers remain accessible even without a summary.
Learning facets carry the actor and context from their qualified Relations and
cannot assert independent mastery from exposure or a reported explanation.

```ts
type SnapshotRef = Ref<"snapshot">;
type KnownAt = { kind: "current" }
  | { kind: "time"; at: string }
  | { kind: "snapshot"; ref: SnapshotRef };
type Coverage = {
  status: "complete_for_query" | "partial";
  gaps: readonly ViewGap[];
  validWindow: KnownTime;
  history: "retained_for_query" | "baseline_only" | "unavailable";
};
type ConceptCard = {
  schema: "kizuki.concept-card/v1";
  concept: KnowledgeNode;
  summary: { text: string; admissions: readonly AdmissionRef[] } | null;
  definitions: readonly Relation[];
  relations: readonly Relation[];
  learning: readonly {
    facet: "exposure" | "explanation" | "application" | "demonstration";
    assertion: Relation;
    assistance: "assisted" | "unassisted" | "unknown";
    assistanceEvidence: readonly Relation[];
  }[];
  knownAt: { kind: "current" } | { kind: "snapshot"; ref: SnapshotRef };
  coverage: Coverage;
};
type HistoryPage = {
  schema: "kizuki.world-history/v1";
  snapshot: SnapshotRef; transitions: readonly StateTransition[];
  coverage: Coverage;
};
type WorldView = {
  schema: "kizuki.world-view/v1";
  result: ViewResult<ConceptCard | HistoryPage>;
};
```

Every array consumes the common claim/ref/edge/byte/token budget. Duplicate
Relations refer to one claim and do not count as independent support. Empty
arrays state absence within permitted coverage; `partial` coverage requires
`incomplete`, never current/unchanged. Assistance defaults to unknown unless
separate complete claims establish it in the exact actor/task/context. No prose
classifier or numeric confidence can invent assistance. The initial registry
includes `learning.assistance` on the supported task-context raw ref, with only
trusted vocabulary values `learning/assisted` and `learning/unassisted`; the
learning Relation must share that exact context. Opposing supported claims
produce unknown assistance and retain the conflict. `assistanceEvidence` contains
the complete qualifying Relations, including perspective, actor/context, validity,
assessment and conflict; the scalar is derived only from that displayed set.
Claim refs alone do not replace those qualifiers. A claim of unassisted work
is still attributed evidence, not proof of mastery or an independently observed
successful outcome.


An Observation preserves source assertions about attribution; a source's sender
field does not prove real-world authorship, endorsement or identity. Model
interpretations of actors/intent become ordinary claims with their own support,
never edits to Observation metadata. Unknown roles remain absent. An event with
no usable span can still be retrieved as evidence but cannot satisfy a claim
whose required grounding is unavailable. Derived transcripts retain their exact
artifact/transformation lineage; they do not masquerade as verbatim originals.

The epistemic-kind decision belongs to immutable checked support admission,
alongside producer/model and Core-clamped authority. It is not another numeric
confidence or inferred holder. Perspective retains holder/speaker/addressee,
quoted/reported/hypothetical modes and explicit/inferred interpretation. An
unknown holder never defaults to the owner. A recommendation/scenario can be
retrieved as such but cannot satisfy current-fact, independent-outcome or action
authorization requirements. If supports of different kinds concern the same
raw proposition, the read preserves those distinct admissions.

`KnowledgeNode`, typed `Relation`, personal facets and `StateTransition` are
projections over claims, support and actual history. They have no independent
mutable truth table. Every derived relation carries the source claim's polarity, perspective, context,
original validity and admission-specific uncertainty in the closed codec above.

## Small versioned registry

The first registry is `kizuki.world-vocabulary/v1`, checked into Core and selected
by the real producer descriptor. It implements only Concept classification,
names, definitions and the following relations/facets. Later noun families are
reserved design work, not accepted production enum members.

| Predicate/facet | Endpoints and cardinality | Interpretation |
| --- | --- | --- |
| `world.kind` | raw subject → trusted `world/concept`; potentially conflicting assertions | Correctable classification, not a handle field |
| `concept.label` | Concept → bounded literal; many with attributable language/context | Alias candidates do not establish identity |
| `concept.definition` | Concept → literal; many qualified definitions | Preserve contradictory definitions and perspectives |
| `concept.requires` | Concept → Concept; many directed edges | Claimed prerequisite in its stated context, not proven causation |
| `concept.example` / `concept.counterexample` | Concept → literal or existing supported raw subject ref; many | Exact evidence/version required; no new artifact object discriminator |
| `concept.distinguished_from` | Concept → Concept; many | A semantic distinction, not automatically an owner identity-separation control |
| `learning.exposure`, `learning.explanation`, `learning.application`, `learning.demonstration` | Person raw ref → Concept; many context/time-scoped claims | Independent evidence facets, never ordinal transitions |
| `learning.assistance` | Supported task-context raw ref → trusted `learning/assisted` or `learning/unassisted`; qualified claims | Joins only the exact actor/task context; absence or conflict stays unknown |

Existing source people/project refs can appear as context and holders without
shipping a general Person/Project API. Explanations, applications and independent
outcomes may exist in any combination. Assisted work remains assisted; consumption
does not prove understanding; lack of recent evidence does not prove forgetting;
mention/retrieval frequency does not establish curiosity, importance or truth.

The registry declares exact object alternatives, endpoint requirements, allowed
polarity, conflict scope and value bounds per predicate. Validation rejects
invalid endpoint shapes before admission. Unknown predicates remain explicit
per-draft abstentions under the existing complete-result policy, not invented
ontology. Additive meanings require a new registry revision and fixtures;
reinterpreting an existing predicate requires a new identifier plus migration.
No model supplies registry code or namespaces. SDK/schema versioning alone
cannot silently change stored meaning.

## Storage selected by queries and integrity

Required queries are: exact supported Concept lookup; bounded alias candidates;
qualified outgoing/incoming relations; current and bitemporal assertions;
support/dependent lookup on correction or loss; and authorized view comparison.
They need indexed keys and relational integrity. A table per semantic noun
duplicates claim authority and lifecycle. Unrestricted EAV hides endpoint and
temporal constraints. A graph engine adds no necessary authority primitive.

Choose existing `claims` plus normalized common support/history children, small
identity bookkeeping and rebuildable indexes. No new dependency is selected.
The [storage and codec appendix](0004-world-storage.md) gives the proposed
closed payloads, component version allocation, exact event/source and composite
ownership constraints, normalized Observation/endpoint/dependency/history tables,
raw handle/receipt lifecycle, wire mapping and bounded cache schema. It extends
the existing B1 `claim_v2_semantics` and `claim_v2_support` family; there is no
parallel meaning/admission authority. Its SQL, validators, migrations and
consumers must be implemented as one accepted lifecycle unit before mutation.

Explicitly ordered erasure, full-preimage comparison, same-transaction child
cardinality checks and restore validation are required alongside SQL foreign
keys. A digest match or a successfully parsed DDL block is not authority.

The meaning codec excludes source anchors and rendering, retains raw endpoints,
perspective excluding its anchors, context, original validity and record
discriminator, and declares its own version. It cannot be parsed as the existing
anchored DTO. Semantic equality still compares raw meaning, never resolved
handles; independent source-distinct assertions converge only in the authorized
identity projection. Support/admission keys include complete checked anchors,
source/event versions and derivation lineage. Full identities are compared on
collision; a digest match alone never accepts differing payload.

**Rendering decision:** retain independently attributable, bounded rendering per
complete admission. Common legacy `claims.body/frontmatter/body_hash` columns on
v2 rows are always neutral compatibility storage: empty body, canonical empty
frontmatter object and the digest of the empty body. They are never a v2 rendering
cache. Every v2 reader dispatches on `record_codec` and builds its permitted
projection from complete admission rendering; no unconverted v1 body path can
expose it. This avoids another materialization and dependency table.

Loss of any contributing admission immediately holds affected canon/retrieval
outputs and invalidates dependent views. Rebuild uses only remaining eligible
complete admissions, never relabels old prose as supported by a survivor, and
uses the existing canon writer and child receipts. Physical purge removes the
old admission rendering, canon preimages and old output hashes through that
same erasure closure.

History stores actual state transitions plus support references, not copied
rendering/preimages by default. Where rollback requires payload, that payload
is dependency-indexed sensitive state subject to the same erasure closure.
Legacy v1 bytes/keys retain their explicit reader and loss behavior. New v2
support semantics are not retroactively inferred for old claims.

Derived Concept indexes contain typed endpoints/predicate/validity and reverse
claim/support IDs. Index equality is not admission authority. Read plans filter
permitted candidate support before ranking, joining identity or expanding edges;
post-filtering a global top-k can leak hidden competition and is insufficient.
No common read may perform all-vault pairwise semantic comparison.

## Time, perspective and longitudinal truth

Source occurrence time, source-reported observation time and Core admission time
are three different fields. `sourceObservedAt` is untrusted connector metadata;
`events.accepted_at` is Core's capture admission time. Neither a source timestamp
nor an earlier event acceptance proves that a later interpretation was already
known. Each Observation and support admission records Core `admittedAt` plus the
transaction's monotone `admissionSeq`; state history records its own Core stamp.
Core never accepts those stamps from a connector or model. A transaction uses
one sequence and deterministic effect ordinal; wall-clock equality does not
identify a revision. Core clamps recorded time to the last committed time on
clock rollback and uses the sequence as the final tie-breaker. These counters
remain internal and never serialize into scoped references or fingerprints.

Store original half-open valid intervals separately from that recorded order.
`knownAt` is the closed `KnownAt` union above. A timestamp convenience request
resolves **once** to an exact committed internal cutoff `(recorded_at, seq)` and
returns a Core-issued opaque `SnapshotRef`; subsequent stable history reads use
that ref, not the timestamp again. On clock rollback several commits may share
a clamped timestamp, so a new resolution of the same timestamp is explicitly a
new lookup, never a promise to reproduce an earlier resolved snapshot. A caller requiring repeated reads within the cache session must retain the
issued ref. This is **cache-local reproducibility only while that token remains
valid**. It is not a durable history link: expiry, principal-local quota eviction,
policy change, purge or restart/restore may invalidate it earlier. Repeating the
timestamp afterward is a new resolution and may select a different exact cutoff.
Durable bookmarked history is a separate future contract, not implied here.
No sequence is exposed merely to make the cutoff precise.

Snapshot tokens use the same 32-random-byte, principal-namespace, purpose/scope,
fixed-15-minute-TTL and shared 16-token/4-MiB reservation rules as views, with
domain-separated lookup. Their private record stores the exact cutoff and the
normalized Concept/history subject scope; requested valid time must remain
within that scope's permitted time bounds. Issuing both a view and snapshot
reserves two slots atomically before eviction/serialization. A missing, expired,
erased, restored or wrong-namespace snapshot returns the same fixed
`new_view_required` without an identifier-specific explanation. A timestamp
history request that cannot retain its resolved cutoff returns unavailable;
ordinary current reads still work for an unreserved principal.

For `validAt=T, knownAt=snapshot`, require each admission and lifecycle transition
to satisfy `(recorded_at < cutoff_at) OR (recorded_at = cutoff_at AND seq <=
cutoff_seq)`, then select the last retained transition per admission in sequence
and effect order. Neither later delivery time nor a new clock-clamped transaction
can move this cutoff. Apply `valid_from <= T AND (valid_to IS NULL OR T < valid_to)`
only to known validity. Unknown validity remains a separate explicit result; it cannot satisfy
an effective-at predicate. A query must opt into a bounded unknown-validity
section to receive it. A dependency must itself have been admitted and valid
for the interpretation by the same known-at cut; a late root cannot backfill a
prior view. The storage appendix specifies the recorded/valid/reverse indexes.

Late evidence therefore cannot enter an earlier known-at view. A source note
backdated Monday and admitted Wednesday is unknown on Tuesday. An interpretation
admitted Thursday is also absent from Wednesday's interpreted view even though
its raw event was captured Wednesday. Current correction of a historical belief
creates a new transaction-time fact and, only when supported, a valid-time
amendment. It never rewrites the original report. Conflicting speakers and
perspectives remain distinct; authority, confidence and independence stay separate.

Historic state is reconstructed from surviving complete history, under **current**
authorization. If purge or the upgrade baseline removed required history, report
`history_unavailable` with a permitted coverage bound; never reconstruct from
scrubbed hashes, make up an empty past, or replay a model. Owner undo after
erasure cannot recover erased content. Reading a later receipt at an earlier
known-at date is future-evidence contamination.

## Dependencies, support independence and loss

Each admission declares exact direct event versions and prerequisite admissions.
Core validates closure, complete endpoint/attribution support, permitted uses and
acyclicity inside a bounded candidate graph. Referencing an earlier immutable
admission rather than mutable current aggregate gives stable dependency meaning.
A cycle, missing prerequisite or unresolved bound refuses admission; cached
lineage indexes are accelerators, never substitute proof.

Distinct captures are not automatically independent roots. Revisions, explicit
forwards/copies, matching source identities, exact copied text and generated
summaries are grouped conservatively. Unknown dependence cannot satisfy a
two-independent-root threshold. A summary keeps the union of its actual roots
and transformation identity; it is not another witness. Repeated retrieval does
not update truth confidence. Evidence that arrives later may add support through
a new checked admission; it cannot rewrite an earlier snapshot's strength.

| Operation | Immediate authoritative effect | Dependent and retained state |
| --- | --- | --- |
| Owner correction | Exact authorized assertion/control, supersession and fence in existing transaction | Same-pass correction/canon protocol; invalidate dependent semantic state immediately; unrelated supported assertions remain |
| Source revocation | Deny new and current use under current policy | Hold affected outputs, jobs and views before later delivery; retained custody is not permission to serve |
| Provider deletion | Existing source-authorized tombstone admission/control | Apply specified withdrawal/derive gates and retry semantics; do not silently equate deletion with complete physical erasure |
| Retention/physical purge | Existing planned exact event selection and purge journal | Erase dependent admissions, Observation/spans, labels, alias mappings, histories, prose, preimages, old digests, jobs, caches, replay inputs and derived stores; verify each store |
| Support loss with complete independent survivor | Remove affected admission and dependent interpretations | Survivor may sustain raw meaning only if it independently covers every endpoint/attribution; regenerate affected prose from survivor, never reuse removed wording |

Correction, loss and policy changes commit an invalidation fence with authority.
Readers test it before delivery; an asynchronous rebuild cannot keep stale text
marked current. Fan-out work is indexed and chunked after commit with durable
holds. Rebuild/worker commit rechecks exact evidence, policy and correction
versions; stale prepared output cannot resurrect a purged fact or overwrite a
new correction. In-flight model context is untrusted work and cannot confer
authority when it returns.

### Physical erasure and the existing undo exception

RFC 0002 §16.4 already makes purge irreversible, but its example allows undo of
purge-rewritten prose; §7.1–7.2 promise archived preimages and append-only history.
This RFC explicitly amends those paragraphs: **physical purge also irreversibly
erases dependent prose, preimages and receipt payloads**. A receipt remains
reversible only while its required authority and bytes have not been physically
erased. Undo of an erasure tombstone returns a fixed `erased` result and cannot
invoke a model, restore an archive or reinstate dependent claims. Ordinary
correction/supersession/undo remain receipted and reversible while retained.

At the baseline, regular event purge only reduces claim provenance and its canon
rewrite can archive old prose. The stronger source-revocation path already uses
`eraseSourcePayload`, a resumable intent, `erase_prior:true` on the same canon
writer, JSONL rewrite and same-row receipt sanitization. It is the implementation
base to extend, not proof that all erasure is already complete. Reuse that writer,
capability, purge receipt and resumable journal; introduce no second log or chain.

The new closed `kizuki.canon-receipt/v2` union has `state:"retained"` with the existing
validated receipt fields (preserving `kind:"write"|"revert"|"purge_rewrite"`),
or `state:"erased"` with only receipt ID, purge
receipt ID, erased-at time, private sensitivity and fresh tombstone integrity.
An erased variant contains no page/archive path, claim/event ID, old digest,
model/prompt, candidate text, supersession/retrieval/inverse/revert linkage or
source-derived identifier. Existing `canon_receipts` rows and the same
`promotions.jsonl` entries dispatch explicitly by codec/state discriminator.
The migrated table requires existing payload columns for retained rows and
requires them all null for erased rows; opaque receipt ID, codec/state, purge
receipt ID, erased-at time, private sensitivity and new integrity are its only
terminal fields. The existing operation `kind` is not overloaded as lifecycle. Read,
audit, export, restore, recovery and undo all understand the tombstone before
any writer can emit it. The regular write payload is not parsed through a cast.
Purge-journal opaque linkage validates tombstone integrity without retaining an
old content digest as evidence. A1's similarly proposed receipt tombstone is
extended consistently; it is not an already implemented protocol.

A generalized erasure intent references the existing exact-selection purge
receipt and records bounded phases: hold/fence; erase dependent authority and
jobs; recompose survivor canon through the same writer without archive; rewrite
sensitive JSONL entries and rows; remove archive/preimage/replay/cache material;
rebuild/verify derived stores; compact/checkpoint affected SQLite; verify and
complete. Crashes replay the same planned IDs and phases idempotently. Holds stay
until both file/log and SQLite erasure are durable; backup/restore/read barriers
refuse a partially scrubbed view. The complete storage map must enumerate every
payload/hash column, FTS/shadow table, sidecar and retained inverse that changes.
Where a non-null legacy row must survive, use an explicit non-content tombstone
codec and newly generated tombstone hash, never an old body/semantic digest.
An admission with erased support is deleted with its payload children; if
no complete survivor remains, delete the meaning and rewrite the shared claim
as a closed purged row containing only its opaque ID, purge linkage and Core
erasure stamp. Its old subject/key, provenance, body/frontmatter, validity,
perspective, derived indexes and original body hash cannot remain. Consumers
dispatch on this state before dereferencing legacy non-null fields.

Do not delete a separately captured raw copy merely because it repeats selected
text. Source S1 purge erases S1 and all interpretations/projections dependent on
S1; independently captured S3 bytes remain unless the owner explicitly selects
that record/source too. A copy's separate custody does not make it independent
corroboration. Report exact selection and residual authorized custody honestly;
never claim a phrase has vanished from the vault while an unselected copy remains.

### Allocation receipt and binding after erasure

`kizuki.semantic-allocation/v1` is a closed union: `kind:"allocated"` holds opaque
receipt ID, exact raw-ref/handle pair, qualifying admission, Core stamp and
integrity; `kind:"erased"` holds only opaque receipt/purge IDs, erasure time,
private sensitivity and fresh tombstone integrity. Both are in the same
allocation-receipt table; composite constraints and transaction validation bind
the live record to its raw-ref, handle and qualifying admission. On erasure,
remove those sensitive fields and dependency rows, then retain only the erased
variant. No inverse or original raw/source hash survives in the tombstone.

For each binding the erasure transaction re-evaluates complete surviving
admissions. If raw occurrence A/H-A merged with independent B/H-B, purging A
removes A's binding and unsupported identity decisions; B/H-B survives. Delete
H-A when it has no admissible binding. If independent complete admission B still
supports the **same** retained supplied raw ref, its existing handle remains.
The binding remains `state:"active"`; only `allocationReceiptState:"erased"`
marks unavailable original provenance. In the same fenced erasure transaction,
Core writes a binding revalidation record over the unchanged raw-ref/handle,
complete surviving B admission, Core recorded stamp, current policy and purge
receipt. It references the original allocation's opaque tombstone ID only as
unavailable history, never as proof of the old raw-ref association. The current
revalidation is the retained authority for that active binding, not an invented
reassignment of allocation history to B. Restore validates its exact raw-ref,
handle, surviving complete support, current lifecycle and purge linkage together;
it does not demand or reconstruct forbidden metadata from the erased receipt.
Ordinary correction, supersession or revocation of B records a Core-stamped
retirement transition and removes its *current* authority; it retains the original
revalidation and its history for authorized audit/undo. If complete C survives,
the same transaction makes C's new revalidation current. Otherwise there is no
externally resolvable current binding, although retained historical revalidations
may keep the internal bookkeeping handle alive. Only physical purge deletes
sensitive revalidation payload/history under the explicit erasure exception.
Every current binding needs at least one independently complete eligible support,
enforced on admission/loss/restore. No current support means fixed not_found on
external resolution, not invented active authority from a historical record. A revoked support may remain in custody
but cannot sustain an externally resolvable object. Surviving binding/support
ownership and receipt variant are validated together after every purge phase.

## Scoped revisions, views and differences

An internal world revision is one SQLite authority snapshot plus exact retained
dependency versions and explicit pending materializations. It describes Kizuki's
model, not the real world. It is neither a public sequence nor an external-action
lock. External clients retain their own execution checks.

```ts
type ViewToken = Ref<"view">; // random opaque wire value, no readable metadata
type ViewResult<T> =
  | { status: "current"; view: ViewToken; data: T; validUntil: string }
  | { status: "current"; view: { status: "not_issued" }; data: T; validUntil: string }
  | { status: "unchanged"; view: ViewToken; validUntil: string }
  | { status: "incomplete"; data: T; reasons: readonly ViewGap[] }
  | { status: "new_view_required" }
  | { status: "unavailable"; reason: "model" | "storage" | "history" | "budget" }
  | { status: "denied" };
type ViewGap = "coverage" | "pending_consolidation" | "stale_dependencies"
  | "required_context_overflow" | "traversal_limit";
```

Server-side token records bind random ID, principal, normalized query, purpose,
effective scope/ceiling, relevant authorization namespace, view schema, fixed
expiry, exact authorized dependency set and complete canonical projection.
Their fingerprint covers only that authorized projection and relevant visible
freshness/coverage. It excludes global epochs, hidden names/support IDs, denied
edge counts, unrelated policy activity, workload timestamps and cache generations.
No token or signature is a grant. Retained view material is bounded sensitive
cache, indexed for purge and partitioned by principal quotas. Each token uses
32 cryptographically random bytes encoded as unpadded base64url (43 characters),
with collision retry; server storage keeps only SHA-256 of the random token.
The 256-bit unpredictable token is the preimage, never a low-entropy name or
source identifier, so this needs no persistent or process-secret derivation key. Fixed TTL
is 15 minutes from issuance, never extended by reads. Each principal namespace
has 16 token slots and 4 MiB total retained payload, each token at most 256 KiB;
an authenticated principal has at most one active namespace. Namespace change
erases its predecessor tokens. Admission of a new token expires old entries then
evicts its own oldest-issued token, with token digest as the tie-breaker.

At most 64 principal cache partitions and 256 MiB retained payload exist per
vault. Partition capacity is reserved by explicit principal enrollment/config
in the owner plane, not opportunistically consumed by hidden source mutations.
An unreserved principal receives complete fresh reads with view status
`not_issued`; token/diff capability is unavailable for that principal until
capacity is assigned. Existing reservations are never displaced by another
principal or background data. TTL cleanup does not change another principal's
unchanged decision. Purge erases each affected token payload, dependency mapping
and token digest; failed lookup then gives the same `new_view_required` result
as expiry or an unknown well-formed token. Per-response requests/time stamps may
vary normally; hidden state cannot alter token status or eviction order.

1. Authenticate and validate current grant before candidate discovery. Apply
   source use, scope and sensitivity at every support/endpoint/edge lookup,
   identity step, ranking and packing operation.
2. Build under one consistent authority snapshot. Validate dependency completeness
   and materialization freshness; a timestamp alone proves neither.
3. Before serializing any payload, revalidate relevant authorization and invalidation
   fences. A race retries at most once within budget or returns a fixed unavailable
   result. Do not stream bytes before that check. A later external revocation
   cannot recall bytes already delivered; record that boundary honestly.
4. Issue a current token only for a complete result under the stated query and
   budget contract. Unknown domain facts may be honestly represented in a complete
   view; unfinished work or missing required context cannot.
5. For unchanged delivery, recompute/revalidate the complete authorized projection
   and compare it with the retained complete baseline under the same namespace.
   Denied-only changes must produce the same semantic result and unchanged decision.
   A global counter or a changed hidden cache cannot force a visible stale signal.

World Diff compares the permitted baseline with a newly validated view for the
same principal/query/namespace. Return bounded additions, changed qualified
assertions and removals only when both sides can still be served under current
policy and retained history. Changed/narrowed grant, erased baseline dependencies,
wrong principal/scope, expired token or restore generation yields the same
`new_view_required` result without old identifiers, counts or explanations that
enumerate inaccessible state. Obtain a fresh view separately. Missing history
never means no change. A diff does not infer what an external client retained.

Pagination binds to one immutable authorized snapshot and query, with fixed
expiry and current-policy validation on every page. Do not silently mix revisions
or expose hidden total/remaining counts. If required dependency closure exceeds
the bound, return incomplete/unavailable rather than a complete partial graph.
Budget omissions describe only authorized work and state whether essential
context is missing. Essential short constraints are selected before optional
detail; the exact serialized result must fit its declared tokenizer budget.

Identity changes based only on denied evidence do not increment a client's
authorization namespace or invalidate its visible baseline. Internal global
sequences may accelerate scheduling, but cannot decide public equality or stale
status alone. Cache eviction is governed by fixed lifetime and principal-local
quotas, not hidden-source activity. Ordinary variable latency remains possible;
this is a bounded non-disclosure contract, not a blanket constant-time promise.

### Explicit envelope, packet and surface migration

This is a limited security compatibility break, not a silent change to v1.
At the baseline `claimsEpoch` adds all source-policy receipts, owner corrections
and supersessions, and packet body/header plus `claims_epoch` expose that number.
More broadly every v1 serving envelope may expose global `source_policy.epoch`
and `denied` counts. Thus merely removing packet epochs or recommending old
recall/context leaves an observation channel. The current MCP schema even omits
`source_policy` while Core can serialize it. The implementation must inventory
all fields on the actual wire, not rely on that incomplete schema.

Proposed contracts and negotiation are exact:

| Contract | Version/capability and permitted use |
| --- | --- |
| Serving output | `kizuki.envelope/v2`; closed `schema, tool, principal, at, canon, quoted, data` fields with typed authorized refs; no `denied`, global epochs, source-policy counters or raw internal IDs. Request timestamp is ordinary response metadata, excluded from view equality. Operation-level errors remain fixed independent of hidden candidate counts. |
| Semantic response | `kizuki.world-view/v1`; the complete `ViewResult` union above, closed Concept/Relation/Observation/history codecs and no authority implied by a token. |
| Context packet | Selecting `kizuki.envelope/v2` forces `kizuki.context-packet/v2`; no separate content-version request switch exists. `scoped-view-v1` is a server capability advertisement only after implementation. Opaque `view`, no numeric `epoch` or `claims_epoch`; body starts `KIZUKI CONTEXT v2` and preserves CANON/QUOTED separation. Ingress machine-origin detection must recognize both markers before v2 emission. |
| Surface port | Existing `kizuki.surface/v1` serves `doctor.report` and `serve.run`, not context. Reserve `kizuki.surface/v2`, minor 0, only if a world-read consumer uses this port; add exact compiled-major support and that real consumer together. CLI/MCP envelope negotiation does not imply this port already serves world reads. |
| Conditional/diff | Additional `world-diff-v1`, implemented and tested only under #490; no capability advertisement until conformance passes. |
| Historical query | Additional `world-history-v1`, implemented with #483 and an actual Core/adapter consumer; `validAt`/`knownAt` are rejected as unsupported before that point. |

Core dispatch chooses a supported contract after authenticating the principal
and before the v1 gate can serialize anything. Existing CLI/MCP/HTTP output
schemas change together; surface descriptors and port-major validation change
only with their actual world-read consumer; built-in
adapters request v2 explicitly. An MCP v2 server declares only its actual v2
output schema and validates every response against it. A retained explicit
legacy adapter accepts v1 only for the built-in fully authorized OWNER context;
an agent named owner or holding a broad private grant is still not that context.
All narrow legacy requests get one fixed `unsupported_contract` response before
candidate discovery or v1 envelope creation. No old recall/context bypass is
promised: upgrading the existing adapter restores authorized model-free reads.
No grants are widened, fake zero epochs emitted, or v1 fields quietly redefined.

This explicitly amends RFC 0002 §6.5's global packet invalidation, §10.6's v1
header example and §17's deferred conditional/as-of surfaces. It permits those
new capabilities only after an advertised consumer exercises conformance;
stateless full reads remain sufficient and never need a model. Mid-session
recall of delivered bytes and external action locks remain out of scope.
Acceptance includes v1 owner success, narrow v1 fixed refusal, every v2 adapter's
full wire-schema validation, marker round-trip, denied-only source/correction/
identity/queue changes, no leaked metadata/counts, and old/new clients across
restore and policy changes. Internal global epochs remain useful race fences,
but never serialize or alone decide external equality/staleness.

### Exact adapter selector and nested v2 output

One selector, `response_contract: "kizuki.envelope/v1" |
"kizuki.envelope/v2"`, chooses the complete serving contract. It grants no
authority. Authenticate first, choose the following branch before candidate
discovery, then check the existing operation grant:

| Selector | Built-in OWNER | Any scoped agent/client |
| --- | --- | --- |
| Missing or explicit v1 | Existing v1 only | Fixed `unsupported_contract` |
| Explicit v2 and implemented consumer | V2 envelope and, for context, v2 packet | Same v2 dispatch under existing grants |
| Unknown, conflicting or unsupported selector | Fixed `unsupported_contract` | Same fixed refusal |

V2 rejects the legacy context `capabilities`, `retain_prefix`, `prior_hash` and
`epoch` keys. Its only optional baseline is typed `priorView`; v2 selection alone
chooses the new packet format. Unknown tool-input keys cannot become a second
version switch. A valid unsupported view/history capability is never silently
handled by a v1 reader. Operation-level grant denial remains independent of
target existence.

Core receives a validated separate contract option plus the selected typed input.
Stdio MCP places `response_contract` alongside the actual tool arguments and
strips it before the selected tool parser. Its advertised output is the exact
implemented discriminated contract. The existing Core **loopback HTTP tool
endpoint**, not an HTTP MCP server, uses a closed v2 wrapper
`{response_contract:"kizuki.envelope/v2", args: V2ToolInput[K]}` on its existing
`/v1/(mcp/)?tool` routes. The `/v1/` route labels the transport, not this new
content codec. Nested or conflicting selectors refuse; they are never dropped by
`body.args` unwrapping. Bare legacy body forms remain OWNER-v1 only.

The actual CLI consumers are `query`, `context` and `tell`; there are no existing
`read` or `propose` CLI verbs. Their proposed `--response-contract` option selects
the corresponding new semantic result, and `--json` v2 emits the separately
versioned closed `{schema:"kizuki.cli-result/v2", command, result}` wrapper,
where `command` is exactly `query|context|tell` and `result` is the corresponding
validated search/context/correct v2 envelope or fixed failure. Query must stop
converting v2 into raw `SearchHit` IDs, context must preserve the selected packet,
and tell must use the shared Core correction operation plus its authorized v2
projector instead of leaking its legacy internal result. Human output renders
that same DTO. Explicit OWNER legacy CLI output remains its old shape.
The current stdio MCP package stays stdio-only; the existing TUI stays audit/undo.
These adapter changes and their concrete stdout/HTTP/MCP conformance tests must
land together before advertising any selector or capability.

Every v2 tool uses the following nested codecs. `SourceRef`, `PageRef`,
`CapturedSubjectRef`, `ClaimRef`, `EventVersionRef` and `ReceiptRef` are distinct
random principal-namespace references. Captured-subject refs resolve retained raw source
subjects; they require no model-produced semantic handle, preserving model-free
raw capture/reads. They are not interchangeable with semantic `ObjectRef`.
No bare internal page path, connector/source binding key, event ID, semantic key,
claim ID or receipt ID may appear in generated structured fields, packet labels,
links, summaries, diffs or errors.

```ts
type SourceRef = Ref<"source">;
type PageRef = Ref<"page">;
type CapturedSubjectRef = Ref<"captured_subject">;
type CanonChunkV2 = {
  page: PageRef; title: string; type: string;
  sensitivity: "public" | "personal" | "private";
  taint: "clean" | "quoted";
  authority: AuthorityTier | null;
  subjects: readonly CapturedSubjectRef[];
  sources: readonly EventVersionRef[];
  excerpt: string; truncated: boolean;
};
type QuotedChunkV2 = {
  eventVersion: EventVersionRef; source: SourceRef; kind: string;
  occurred: KnownTime; sensitivity: "public" | "personal" | "private";
  subjects: readonly CapturedSubjectRef[]; text: string; tainted: true;
};
type ReadGap = "retrieval_unavailable" | "coverage" | "budget";
type GraphAnchorV2 = CapturedSubjectRef | PageRef | EventVersionRef;
type GraphEdgeV2 =
  | { kind: "wikilink"; from: PageRef;
      to: PageRef | { kind: "unresolved"; text: string; quoted: true } }
  | { kind: "subject"; from: PageRef; to: CapturedSubjectRef }
  | { kind: "source"; from: PageRef; to: EventVersionRef };
type GraphDataV2 = {
  anchor: GraphAnchorV2; edges: readonly GraphEdgeV2[]; truncated: boolean;
};
type PacketContentV2 = {
  packetMd: string; tokens: number; budgetTokens: number; tokenizer: string;
  purpose: "session" | "recall" | "correction" | "audit"; coverage: Coverage;
};
type PacketDataV2 = {
  schema: "kizuki.context-packet/v2"; result: ViewResult<PacketContentV2>;
};
type ProposeDataV2 = {
  outcome: "stored" | "duplicate" | "skipped" | "contested";
  claim: ClaimRef; superseded: readonly ClaimRef[];
};
type CorrectDataV2 = {
  receipt: ReceiptRef | null; eventVersion: EventVersionRef | null;
  claim: ClaimRef | null; superseded: readonly ClaimRef[];
  rewritten: readonly { page: PageRef; diff: { status: "unavailable" } }[];
  ambiguous: readonly { candidate: Ref<"claim_group">; claims: readonly ClaimRef[] }[];
  message: "correction_recorded" | "ambiguous" | "dry_run" | "no_change";
};
// Existing scalar types/limits come from these baseline serving argument types.
// These are closed parsed objects, not arbitrary intersections at the boundary.
type V2ToolInput = {
  search: Omit<SearchArgs, "subjects"> & { subjects?: CapturedSubjectRef[] };
  get_page: { page: PageRef };
  query_entities: EntitiesArgs;
  timeline: Omit<TimelineArgs, "subject" | "connector_id"> & {
    subject?: CapturedSubjectRef; source?: SourceRef;
  };
  graph_neighbors: Omit<GraphArgs, "id"> & { anchor: GraphAnchorV2 };
  context_packet: Omit<ContextPacketArgs,
    "subjects" | "capabilities" | "retain_prefix" | "prior_hash" | "epoch"> & {
      subjects?: CapturedSubjectRef[]; priorView?: ViewToken;
    };
  propose: Omit<ProposeArgs, "target" | "subject" | "subjects" | "provenance"> & {
    target?: PageRef | null; subject?: CapturedSubjectRef;
    subjects?: CapturedSubjectRef[]; provenance: EventVersionRef[];
  };
  correct: Omit<CorrectArgs, "target"> & {
    target?: ClaimRef | Ref<"claim_group"> | CapturedSubjectRef;
  };
};
type V2ToolData = {
  search: { gaps: readonly ReadGap[] };
  get_page: null;
  query_entities: null;
  timeline: null;
  graph_neighbors: GraphDataV2;
  context_packet: PacketDataV2;
  propose: ProposeDataV2;
  correct: CorrectDataV2;
};
type EnvelopeV2<K extends keyof V2ToolData> = {
  schema: "kizuki.envelope/v2"; tool: K;
  principal: Ref<"principal">; at: string;
  canon: readonly CanonChunkV2[]; quoted: readonly QuotedChunkV2[];
  data: V2ToolData[K];
};
type ContractRefusal = {
  ok: false;
  error: { code: "unsupported_contract"; message: "requested contract unavailable";
           retryable: false };
};
```

`system_health` remains built-in OWNER-only in this migration; all other callers
receive the fixed contract refusal before collecting health counters/source keys.
A separate scoped operational-health proposal may follow, but v2 does not spread
legacy `HealthData`. This exception is an explicit part of the compatibility
amendment. CLI doctor and the existing internal surface remain owner operations.

Every identifier-bearing argument is closed by `V2ToolInput`, including search
and context subjects, timeline subject/source, graph reverse event roots, propose
target/subject/subjects/provenance, and exact correction targets. V2 timeline's
`source` means one currently permitted source binding rather than the legacy
connector-wide raw-string filter; OWNER-v1 retains that legacy filter. Entity
name/type filters are bounded source text/registry scalars, not identity keys.
Absent optional correction target uses only the existing bounded authorized
target discovery; it never interprets an input string as a raw reference.
Unknown or inaccessible typed targets return fixed not_found without raw-ID
fallback. Propose/correct keep their existing tool and owner-relay grants.
V2 changes serialization, not the rich-writer acceptance gate.

Empty canon/quoted arrays are explicit for tools whose data owns the result.
Get-page/entity/timeline data is exactly null; results are their validated chunks.
Search gaps describe only the caller's available retrieval capability/coverage,
not hidden source counts. Graph truncation considers authorized expansion only.
Canon page prose is served only when its complete rendering support is allowed;
a source path is never needed to render a chunk. Graph source edges retain exact
event-version targets and reverse roots. Wikilinks resolve only against permitted
pages: an absent and an inaccessible target both remain the same bounded quoted
literal from the already permitted source page, with no existence distinction or
raw filesystem link. Unresolved text is never treated as an identity or command.

The first v2 correction result deliberately omits old/new diff bytes and free-form
legacy answer strings. `diff.status="unavailable"` is explicit; the human adapter
renders only the fixed message and validated typed fields. It must not reuse
legacy unifiedDiff or answer formatters, which contain raw paths/IDs and internal
frontmatter. A future structured page-diff codec must explicitly project every
frontmatter/reference field and authorize both sides before it can replace this
unavailable state. Existing fully authorized OWNER-v1 audit/undo remains.
`ReceiptRef` in this slice is attribution, not a bearer capability or advertised
undo handle; no narrow audit/undo command is added by its presence.

Packet Markdown is constructed from v2 chunks/claim references. Generated labels
are `[page-ref:<token>]`, `[event-version-ref:<token>]`, and
`[claim-ref:<token>]`; no raw identifier/header hash is copied from v1. Source
text can literally contain strings resembling identifiers; it remains quoted
untrusted content and is never interpreted as a typed reference or instruction.
The packet's `result` uses the same `ViewResult` state machine as world reads.
Current carries the complete packet content; unchanged carries only the retained
view and validity, with no packet content or newly computed hidden metadata.
Invalid/expired baseline, incomplete coverage and unavailable storage retain their
explicit branches instead of masquerading as a full empty packet. The tokenizer is an exact registered identifier, and
all strings/arrays inherit existing field bounds plus the 256-KiB/2,000-token
response cap. Golden tests parse actual stdout/MCP/HTTP and packet text for
these nested fields; checking TypeScript types alone is insufficient.


## Capture, consolidation, reads and optional analysis

Capture admits source-faithful evidence promptly and resumes from its checkpoint.
It never waits for all-vault reasoning. Existing model extraction and later
#503 consolidation use separate
bounded operations on the existing rails, shared leases and budget accounting.
Normal reads validate and project durable state model-free. Deeper analysis is
an explicit bounded model request labeled analysis, with no action authority.

A consolidation job records exact input event/admission versions, relevant policy,
producer/prompt/schema versions and budget reservation. Coalesce updates by
affected claim/object and use age-aware queues so new evidence cannot starve old
work. Commit output admissions, receipt, invalidations, outbox and progress under
the same final transaction fences. A durable attempted call with unknown usage
keeps the existing unknown-consumption accounting; it cannot be refunded as zero.

Malformed, refused, unavailable, timed-out, partial and truly empty outcomes keep
their distinct existing result meanings. Only a complete accepted batch advances
its successful frontier. A valid processed subset may commit only through an
explicitly partitioned job with its own complete manifest; arbitrary truncated
model output cannot become a successful empty batch.

A read after new evidence but before consolidation may return a verified current
view, an explicitly incomplete view with permitted newer evidence, or unavailable.
Only authoritative typed rules may supply a bounded overlay. No lexical heuristic
may invent a reconciled deadline merely to advertise freshness. Owner correction
and its existing same-pass path never wait behind consolidation.

Initial hard engineering bounds reuse RFC 0003 producer limits; identity limits
remain unchanged. Proposed read limits are 128 admitted candidate claims, 256
traversed raw refs, 1,024 edges, depth 4, 256 KiB complete response bytes and a
caller-selected budget within the existing 50..2,000 packet-token range. A batch
adds at most 128 claims; one read retry and one model attempt per reserved job
are allowed. These are safety bounds to test, not measured latency promises.
Migration/purge/rebuild use bounded keyset pages and durable holds; exceeding a
single response budget does not prevent eventual physical erasure. Benchmark
latency/memory/storage against pinned current Kizuki before selecting release SLOs.

## Worked longitudinal examples and expected observations

The repository-safe [Concept fixture](fixtures/world-concept-design.json) and
[longitudinal extension](fixtures/world-longitudinal-design.json) are concrete
neutral development inputs and isolated expected outcomes. Their status fields
state proposed/unimplemented/not-run; static validation is not product proof.
The extension includes two commitments, exact deadline correction, four separate
outcome-evidence events and post-purge restore. Its base hash binds the sanitized
Concept copy, while the original design snapshots remain preserved separately.

The first fixture's S4 restriction maps to **existing subject scope**, not a new
principal-source ACL. Its captures have a unique source-local raw subject that
g1 grants and g2 does not; both clients may retain private ceilings. No additional
granted subject, alias or identity expansion makes S4 reachable for g2. Source
consent remains global, and all semantic endpoints/support still pass current
principal authorization. Arbitrary per-client source allowlists would require a
separate explicit Grant version/migration. Unknown source occurrence r03 remains
unsupported at frozen ingress rather than receiving a fabricated capture time.

Use a frozen neutral corpus and oracle under #496.
The oracle is written independently of extractor output. Reveal events only at
their recorded availability time. The first Concept fixture exercises its own
implemented subset; later domain examples remain explicit design cases.

| Step | Synthetic evidence or operation | Required result |
| --- | --- | --- |
| 1 | Ada Vale and Ben Reed discuss Concept “Bayesian updating”; another record names “A. Vale” without enough attribution | Distinct source records and explicit ambiguous identity; no name-only merge |
| 2 | An independent note describes the same Concept; a forwarded copy repeats the first note; another “Bayes” is a project codename | Qualified accepted identity may unite genuine Concept mentions; copy adds no independent root; homonym stays separate |
| 3 | Ada can explain a worked example but reports needing assistance to apply it; asks whether dependent observations should count twice | Independent explanation/application-assistance facets and durable open Question; no mastery rank or curiosity from frequency |
| 4 | One project goal has commitment C1 to send a draft and separate C2 to review it; Ada reports Friday for C1 while Ben reports Thursday | Preserve two commitments and conflicting perspectives; never invent agreement or change C2's date |
| 5 | A role changed Monday but its evidence arrives Wednesday | Valid-at Tuesday/known-at Tuesday differs from valid-at Tuesday/known-at Thursday; replay before Wednesday cannot see the role update |
| 6 | Owner corrects the exact tentative C1 date interpretation to Monday; a previously started consolidation later returns Friday | Immediate authoritative correction; stale worker commit refuses; C2 and unrelated Concept evidence remain intact |
| 7 | A restricted source supports an alias and identity merge | Narrow client's labels, groupings, counts, rank, view token comparison and history expose none of that activity |
| 8 | Revoke then physically purge the first source | Immediate denial before erasure completion; full dependency/prose/history/cache/replay closure; complete independent survivor remains attributable |
| 9 | Agent says “done”, provider acknowledges upload, independent observer reports wrong version, later correct artifact arrives | Four attributable events; self-report/acknowledgement do not establish achieved objective; later success does not rewrite the earlier failure |
| 10 | Client B keeps an older view, loses a grant, then server is restored | No stale `unchanged`; inaccessible baseline is not diffed; old token invalid; new authorized view reflects current retained state |

Learning demonstration criteria include actor, assistance, task/context, exact
artifact version, success criterion and separately observed result. These shared
evidence semantics precede #492's external receipt ingestion/feedback loop.
Kizuki does not execute the task or certify an external success from a tool name.

## Migration, recovery and export

Keep RFC 0003's complete B1b–d and A1 merge groups. The storage appendix assigns coordinated next ledger/component/backup versions
against the pinned baseline and lists the streams each version owns. Recheck the
actual integration base before implementation; a collision consumes a fresh
version through review, never different DDL under an already used number. Export includes authority, complete
support, Observation, lineage, handles/bindings, identity/history and purge linkage;
derived indexes rebuild. Opaque live view caches/tokens do not survive export or
restore. A restore installs a fresh view runtime generation before accepting reads;
the durable authorization namespace and valid random target mappings are restored
separately. A service restart also invalidates the runtime cache atomically.

Old v1 rows retain exact bytes, hashes, interpretation and supported replay.
No inferred backfill creates historical evidence independence, learning state,
identity authority or false recorded time. Missing history begins at an explicit
upgrade baseline. Drain/replay pending v1 decisions under their declared codecs;
never call a new model to upgrade a saved result.

Stage restore privately, validate all byte limits, closed codecs, keys, composite
references, retained receipt chains, lineage acyclicity and erasure tombstones,
then publish through the existing recovery boundary. Rebuild against retained
authority is deterministic and model-free; re-extraction is separately versioned.
Crash at every transaction/file/outbox boundary must resume idempotently with
holds intact. Older binaries refuse newer schemas/archives. Rollback opens a
preserved pre-upgrade backup separately; no in-place downgrade or live estate
migration is authorized by this proposal.

## Delivery ownership and acceptance

| Packet | Owned contract and dependency | Exit evidence |
| --- | --- | --- |
| #481 | This RFC and explicit RFC 0002/0003 amendments | Exact-head design/privacy/compatibility review; links and existing verification; approval of open adoption decisions |
| #472 / #482 | Complete shared writer/support/loss unit, Observation/handles and minimal registry | Migrations, retry/CAS, mixed v1/v2 readers, backup/restore, complete purge and required A1 proof |
| #483 | Indexed lineage, history, invalidation fences and scoped view foundation | Correction/revocation/purge races, denied-only changes, as-of replay, restore and bounded dependency closure |
| #484 | Real Concept producer, one Core card/correction and actual CLI/MCP projections | Public-seam success/denial, repeated Concept convergence, homonym preservation, independent model-quality and human-readable usefulness |
| #503 | Bounded consolidation over accepted shared contracts | New contradiction before work runs, stale worker refusal, backlog/resource and erasure proof; first Concept can report pending before this engine lands |
| #502 A | Existing onboarding #458 plus scoped current clients | Two actual supported clients separately from mocks; exact correction/retrieval, least privilege and configuration rollback |
| #489 / #490 | Initial task view from #483/#484/#488, then scoped diffs | Essential constraints under budget, honest partial providers, grants/freshness/retained-view validation; optional domain providers follow |
| #487 / #492 | Shared outcome-evidence contract first, external feedback workflow later | No #487→#492→#489→#487 dependency cycle; completion claims distinct from observed results |
| #496 | Fixture/oracle and baseline work from the first slice | Policy/loss hard gates, semantic parity, held-out quality, measured cost and useful continuity; grows with later packets |

Every implementation slice starts with a public Core regression and the
applicable real adapter. Cover rollback/restart, duplicate admission, late
evidence, perspective conflict, owner correction/undo, denied traversal,
hidden-only mutation, partial coverage, malformed model output, purge and
restore. No new interface is added just for parity; the existing TUI remains
audit/undo. The human card leads with useful understanding and uncertainty,
with evidence/history/correction one step away; agents receive typed fields,
stable errors and no need to scrape prose.

Use pinned Bun 1.3.10 on this baseline. Commands for implementation acceptance:

```bash
bun test packages/core/test/producer packages/core/test/contracts
bun test packages/core/test/claims packages/core/test/serving
bun test packages/mcp/test packages/cli/test
bun run typecheck
bun run verify
git diff --check
```

Verify concrete paths against the eventual implementation head and add the
new slice's named tests; do not claim a nonexistent test command ran. Full CI,
native package smoke/artifact checks and independent two-axis review belong to
the exact integrated head. Mocked providers, synthetic client transports and
test counts do not establish live-client, unfamiliar-user, platform, account,
estate or release acceptance.

## Alternatives, adoption record and open decisions

Rejected: name/content-derived world IDs; global representative IDs in scoped
views; rewriting raw claims on merge; arbitrary EAV or per-noun truth stores;
global epochs as private client revisions; actor inference in Observation;
relabeling retained prose after support loss; compulsory learning ladders;
summary copies as corroboration; model failure as empty success; general agent
execution; and a chain that writes canon from packed context.

This RFC adopts **no third-party implementation or dependency**. Current competitive
references in #497 motivate perspective, temporal tests, scoped context and
separate consolidation. No superiority or license clearance is inferred from
those descriptions. A future adoption record must name exact upstream revision,
license/notices and transitive components, workload and simpler baseline,
measured costs, maintenance owner, custody/egress/purge compatibility and removal
path under [upstream policy](../docs/upstream-policy.md). The default remains
borrowing patterns and tests within the existing stack.

Open acceptance decisions are approval of the explicit envelope/surface security
compatibility break and physical-erasure/undo amendment, review of the complete
shared storage/version allocation, and empirical SLOs from #496. These
must be resolved before the affected implementation becomes public. They are
not permission to continue the incomplete durable-rich schema by implication.
No release, deployment, account grant, inference spend or GitHub merge authority
comes from this design document.
