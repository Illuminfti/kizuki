# RFC 0004: A claim-backed world model and scoped views

Status: **Proposed — not binding and not implemented**. Date: 2026-09-05.
Owner: Kizuki core. Design packet: [#481](https://github.com/Illuminfti/kizuki/issues/481).
Implementation baseline: `8f87c7d368227534fbba2f16b7863cc03c1178d6`.

This proposal reconciles the [world-model epic](https://github.com/Illuminfti/kizuki/issues/497)
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
under [#502 Stage A](https://github.com/Illuminfti/kizuki/issues/502). They do not
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
| RFC 0002 §6.5 and §10.6, binding legacy packet | Existing packet marker protects against recaptured machine output; ordinary context/recall stay usable | Replace the global epoch in **scoped** client freshness with the protocol below; explicitly reconcile old clients instead of treating the existing counter as private |
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
that saved map. Unique raw-ref binding plus full collision checks make retries
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

External object references are keyed pseudonyms of a handle and its authorization
namespace, not the internal handle or a source/name hash. Core resolves them
under the authenticated principal; the token itself confers no authority. The
namespace binds principal, normalized permitted scope/purpose/ceiling and schema,
remains stable through ordinary visible evidence additions, and rotates when
that authorization namespace changes. Losing all authorized support makes a
previous object indistinguishable from an unavailable/unknown reference.

## Exact proposed semantic contracts

The following are design types, not exported runtime symbols. IDs in persisted
records are internal; adapters receive authorized references. Every wire codec
is a closed discriminated shape with byte/array/depth limits before parsing.

```ts
type KnownTime =
  | { kind: "known"; from: string; until: string | null }
  | { kind: "unknown" };
type EvidenceRef = {
  supportId: string; eventId: string; eventHashVersion: number;
  eventHash: string; startUtf16: number; endUtf16: number;
};
type Observation = {
  schema: "kizuki.observation/v1"; id: string; supportId: string;
  evidence: readonly EvidenceRef[];
  attribution: readonly {
    role: "sender" | "recipient" | "quoted_author" | "thread" | "place";
    ref: { kind: "occurrence" | "supplied"; id: string };
    basis: "source_field"; field: string;
  }[];
  fidelity: "verbatim_text" | "source_metadata" | "lossy_transcript";
  occurred: KnownTime; observedAt: string;
};
type EpistemicKind = "observed" | "reported" | "owner_assertion"
  | "model_inference" | "hypothesis" | "recommendation" | "scenario";
type KnowledgeNode = {
  ref: string; kind: "concept"; classificationClaims: readonly string[];
  labels: readonly { text: string; claim: string }[];
  resolution: "distinct" | "resolved" | "ambiguous";
};
type Relation = {
  claim: string; subject: string; predicate: string;
  object: { kind: "node"; ref: string } | { kind: "literal"; value: string };
  perspective: unknown; // exactly ClaimV2Perspective, projected through policy
  valid: KnownTime; epistemicKind: EpistemicKind;
  support: readonly EvidenceRef[];
};
type StateTransition = {
  claim: string; causeReceipt: string; recordedAt: string;
  before: "absent" | "active" | "retracted" | "superseded";
  after: "active" | "retracted" | "superseded";
  valid: KnownTime;
};
```

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
mutable truth table. A derived relation carries the source claim's polarity,
perspective, context, validity and uncertainty; the abbreviated type above does
not license an adapter to omit those fields from a final versioned contract.

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
| `concept.example` / `concept.counterexample` | Concept → literal or supported artifact ref; many | Exact evidence/version required |
| `concept.distinguished_from` | Concept → Concept; many | A semantic distinction, not automatically an owner identity-separation control |
| `learning.exposure`, `learning.explanation`, `learning.application`, `learning.demonstration` | Person raw ref → Concept; many context/time-scoped claims | Independent evidence facets, never ordinal transitions |

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
The following SQL is the proposed relational shape; it extends the final B1b
migration rather than installing an independent `wm_*` store. Shared child
names are reconciled with that migration before code is accepted.

```sql
-- Existing shared claims remain assertion authority.
CREATE TABLE claim_meanings (
  claim_id TEXT PRIMARY KEY REFERENCES claims(claim_id),
  codec TEXT NOT NULL CHECK(codec = 'kizuki.claim-meaning/v1'),
  semantic_key TEXT NOT NULL UNIQUE,
  payload TEXT NOT NULL
) STRICT;
CREATE TABLE claim_admissions (
  admission_id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL REFERENCES claims(claim_id),
  admission_key TEXT NOT NULL UNIQUE,
  payload TEXT NOT NULL,
  rendering TEXT NOT NULL
) STRICT;
CREATE INDEX admissions_by_claim ON claim_admissions(claim_id, admission_id);
CREATE TABLE claim_admission_events (
  admission_id TEXT NOT NULL REFERENCES claim_admissions(admission_id),
  event_id TEXT NOT NULL REFERENCES events(event_id),
  PRIMARY KEY(admission_id, event_id)
) STRICT;
CREATE INDEX admissions_by_event ON claim_admission_events(event_id, admission_id);
CREATE TABLE claim_dependencies (
  admission_id TEXT NOT NULL REFERENCES claim_admissions(admission_id),
  prerequisite_claim_id TEXT NOT NULL REFERENCES claims(claim_id),
  prerequisite_admission_id TEXT NOT NULL REFERENCES claim_admissions(admission_id),
  PRIMARY KEY(admission_id, prerequisite_claim_id, prerequisite_admission_id)
) STRICT;
CREATE INDEX dependents_by_admission
  ON claim_dependencies(prerequisite_admission_id, admission_id);
CREATE TABLE semantic_handles (
  handle_id TEXT PRIMARY KEY -- random, no source/name hash or semantic payload
) STRICT;
CREATE TABLE semantic_bindings (
  raw_kind TEXT NOT NULL CHECK(raw_kind IN ('occurrence','supplied')),
  raw_id TEXT NOT NULL,
  handle_id TEXT NOT NULL REFERENCES semantic_handles(handle_id),
  allocation_receipt_id TEXT NOT NULL,
  PRIMARY KEY(raw_kind, raw_id),
  UNIQUE(handle_id)
) STRICT;
```

The shared migration must enforce composite ownership of a prerequisite admission
by its named claim (unique parent key plus composite FK), and bind every raw ref
and allocation receipt to the corresponding occurrence/supplied-ref and receipt
tables. SQL sketches without those final FKs are not migration acceptance.
Use explicit staged erasure order rather than accidental `CASCADE` as the
purge policy. Observation, endpoint-support and source-binding children belong
to each immutable admission; their normalized reverse indexes are rebuilt and
checked against the closed admission payload on restore.

The meaning codec excludes source anchors and rendering, retains raw endpoints,
perspective excluding its anchors, context, original validity and record
discriminator, and declares its own version. It cannot be parsed as the existing
anchored DTO. Semantic equality still compares raw meaning, never resolved
handles; independent source-distinct assertions converge only in the authorized
identity projection. Support/admission keys include complete checked anchors,
source/event versions and derivation lineage. Full identities are compared on
collision; a digest match alone never accepts differing payload.

**Rendering decision:** retain independently attributable, bounded rendering per
complete admission. Common `claims.body/frontmatter` for v2 are a disposable
current materialization with explicit admission dependencies, never the only
copy of authority. Dual readers cannot expose v2 through an unconverted v1 body
path. Changing/loss of any contributing admission clears affected common prose
and old hashes immediately and holds its canon/retrieval projections. Rebuild
uses only remaining eligible complete admissions; it never relabels old prose
as supported by a survivor. Canon uses its existing writer and child receipts.

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

Store original half-open valid intervals separately from Core-recorded admission
and transition order. Core's internal monotone transaction sequence determines
same-instant ordering and is committed with the effects; wall-clock equality
does not identify a revision. Unknown validity stays unknown under RFC 0003.

A read with `validAt=T, knownAt=K` asks for evidence effective at T that had been
admitted by K, with lifecycle changes known by K. Late evidence cannot enter an
earlier known-at view. Current correction of a historical belief creates a new
transaction-time fact and, when explicitly supported, a valid-time amendment;
it does not rewrite what a person originally reported. Conflicting speakers and
perspectives remain separate unless the owner explicitly corrects a specified
assertion. Authority, confidence, independence, usefulness and freshness remain
different fields and policies.

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

Purge follows the existing receipt tombstone/journal protocol. Do not invent a
second receipt chain or retain old content hashes to make history look complete.
The proposed A1 tombstone keeps only its specified opaque receipt/purge IDs,
time, private sensitivity and new tombstone integrity, with verified journal
linkage; it has no inverse or identity authority.

If raw occurrence A allocated handle H-A and was later merged with independent
B/H-B, purging A removes its raw binding, allocation attribution and unsupported
identity decisions; B/H-B and its complete assertions survive. H-A is removed
when no admissible raw binding remains. No source-derived ID/hash is kept as
proof. A client must not expect a reference whose entire authority was erased
to survive. If A and B are independent admissions about one retained supplied
raw ref, its handle can survive via B; erased allocation provenance becomes
explicitly unavailable, never falsely reassigned to B. Receipt scrubbing and
remaining binding validity must be checked together. This is intentional loss,
not silent reassignment or a permanent orphan registry.

## Scoped revisions, views and differences

An internal world revision is one SQLite authority snapshot plus exact retained
dependency versions and explicit pending materializations. It describes Kizuki's
model, not the real world. It is neither a public sequence nor an external-action
lock. External clients retain their own execution checks.

```ts
type ViewToken = string; // random opaque wire value, no readable metadata
type ViewResult<T> =
  | { status: "current"; view: ViewToken; data: T; validUntil: string }
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
cache, indexed for purge and partitioned by principal quotas.

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

### Existing packet compatibility is a real amendment

At the baseline, `serving/epoch.ts` adds global source-policy epoch, owner
correction count and supersession count. `serving/packet.ts` puts that number in
the returned body and `claims_epoch` even for otherwise filtered packets. That
is the specified legacy behavior, not a safe new world-revision protocol. A
correction outside a narrow client's scope can change its epoch without changing
its permitted data. Preserving that exact signal and claiming non-disclosure
are incompatible requirements.

The proposed adoption therefore versions the scoped packet contract explicitly:
new negotiated scoped clients use opaque view tokens and the same machine-origin
marker discipline. Legacy v1's documented global epoch remains available only
to the existing fully authorized owner context. Narrow clients that cannot
negotiate the safe contract receive a stable unsupported-contract result and
can still use the existing authorized recall/context reads without that counter.
Do not encode a fake zero epoch, silently redefine the number, silently widen a
grant, or call this a backwards-compatible wire change. RFC acceptance must
approve this limited security compatibility break and its client migration;
implementation and exact old/new adapter tests precede any public claim.

## Capture, consolidation, reads and optional analysis

Capture admits source-faithful evidence promptly and resumes from its checkpoint.
It never waits for all-vault reasoning. Existing model extraction and later
[#503](https://github.com/Illuminfti/kizuki/issues/503) consolidation use separate
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

Use a frozen neutral corpus and oracle under [#496](https://github.com/Illuminfti/kizuki/issues/496).
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

Keep RFC 0003's complete B1b–d and A1 merge groups. Their nominal ledger/component/
backup reservations remain subject to the actual integration base; this document
does not silently consume or renumber a schema. Inventory every required stream
before assigning the final next versions. Export includes authority, complete
support, Observation, lineage, handles/bindings, identity/history and purge linkage;
derived indexes rebuild. Opaque live view caches/tokens do not survive export or
restore. A restore installs a fresh view namespace before accepting reads.

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

Open acceptance decisions are the limited legacy scoped-packet compatibility
break, exact private meaning/receipt/schema codec names and version allocation,
the reviewed final normalized FK/index DDL, and empirical SLOs from #496. These
must be resolved before the affected implementation becomes public. They are
not permission to continue the incomplete durable-rich schema by implication.
No release, deployment, account grant, inference spend or GitHub merge authority
comes from this design document.
