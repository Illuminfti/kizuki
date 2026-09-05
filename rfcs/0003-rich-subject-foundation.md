# RFC 0003: Rich subjects, shared claim support, and reversible identity

Status: **Proposed**. Date: 2026-09-05. Owner: Kizuki core.

This draft records the reviewed foundation and its engineering sequence. It
does not make the rich classifier available or amend a binding contract merely
by existing. Required verification, independent review, and merge remain gates.
[RFC 0002](0002-autonomous-canon.md), [RFC 0000](0000-constraints.md), and the
[decision log](../docs/decision-log.md) remain binding.

## Problem and outcome

The current producer can describe only subjects supplied by a connector, with
string objects and limited attribution. It cannot faithfully discover and link
people, companies, informal groups, frameworks, ideas, philosophies, schools,
styles, practices, or context-qualified tastes from ordinary captured text.
Expanding its prompt alone would lose reference identity, evidence, perspective,
and temporal meaning at the current claim storage boundary.

Legacy identity mutation also accepts caller-selected status, score, and evidence
without the durable authority history needed for reversible identity effects.
This proposal first contains that path, then introduces one shared claim/support
foundation used by identity and discovery. The eventual result is source-grounded,
qualified knowledge that can be corrected, undone, purged, and rebuilt.

## Sequence and availability

| Stage | Coherent deliverable | Availability boundary |
| --- | --- | --- |
| A0 | Retire unsafe legacy identity authority and contain restore/erasure | Ordinary raw-ref capture, query, correction, and purge remain usable; aliases report unavailable |
| B1a | Pure v2 contracts/parsers, complete v1/v2 result validation, explicit expected-major binding | Independently reviewable; no new schema, public v2 writer, real v2 producer, or default selection |
| B1b | Shared claim schema, dual readers, temporal consumers, immutable support and source lifecycle | Private migration work, not independently mergeable |
| B1c | Shared prepare/commit writer and support admission | Synthetic private writer tests only; same merge group as B1b |
| B1d | Versioned replay, backup/restore, and public Core composition | B1b–d merge together after complete lifecycle verification; only then expose the v2 Core writer |
| A1 | Receipted identity changes, negative constraints, correction, and undo | Depends on the accepted shared writer; no alternate identity claim store |
| B2 | Real v2 model producer and source-grounded filing | Depends on A1; automatic discovery starts here |
| C | Authorized graph/catalog/search/context projections and public reads | Requires public CLI/MCP/context and rebuild proof |

B1b–d and A1 depend on the accepted event-origin and atomic extraction contracts.
First admission causally binds an event's origin and content identity; future
machine output cannot retroactively classify an earlier external event as self.
All eligible claims, retrieval outbox entries, decision completion, and frontier
advancement commit in one final immediate transaction under source/cursor/binding
fences. B1a neither substitutes another origin shape nor accepts an unreviewed
event implementation.

Nominal migration reservations are ledger 17 / claims component 4 / serve
component 9 / backup v4 for B1b–d, then ledger 18 / identity component 1 /
backup v5 for A1. A0 now reserves backup v3 for bounded opaque legacy identity-row encoding and
older-reader refusal, without a ledger bump or a new purge-proof stream. Its
conservative post-purge verification requires no remaining legacy identity rows;
unrelated retained rows report that absence cannot be proved. No subject hashes
or deleted alias labels are retained as permanent proof. This coordinated amendment
supersedes the earlier draft backup reservations. Reconcile these numbers on
the accepted integration base.

## Invariants

Claims remain the authoritative assertion store; support is part of that store.
Raw subject refs never change when identities merge. Connector events remain
immutable. Catalogs, aliases, graph edges, and search documents are projections.
Models nominate grounded observations; they never select accepted authority,
owner identity, receipts, source origin, merge status, or durable subject IDs.

Sensitivity is resolved automatically by the existing maximum lattice and
defaults to private. Every endpoint, attribution, context, support, and count
must pass source/grant/scope/sensitivity checks. A private speaker cannot be
removed to make the remainder of a claim public. Capture, recall, audit, and
undo remain useful without a model; autonomous canon writing requires one.

## Pure producer and claim contracts

The exact v2 DTOs and closed parsers live in
[producer-v2.ts](../packages/core/src/contracts/producer-v2.ts) and
[claim-v2.ts](../packages/core/src/contracts/claim-v2.ts). Their presence supplies
pure validation, not a stored ClaimV2 record or a mutation API.

`kizuki.producer-response/v2` has exactly `schema`, `mentions`, and `claims`.
A mention has one local ID, a bounded untrusted label, exactly one UTF-16 text
anchor, and up to four candidate refs. A draft ref is either an exact supplied
handle or an exact response-local mention ID. Vocabulary refs come from the
trusted catalog and are a separate object alternative.

A rich claim has a local ID, subject, registered predicate, typed object
(`literal`, `subject`, or `vocabulary`), perspective, context, polarity, body,
valid interval, temporal basis, confidence, sensitivity, and anchors. Perspective
records nullable holder/speaker/addressee, asserted/quoted/reported/hypothetical/
suggested/questioned/uncertain mode, and explicit/inferred interpretation.
Unknown identity stays null and never defaults to the owner.

Every supplied or discovered subject/object/context endpoint requires its own
source anchor among the claim's cited evidence. Named perspective endpoints
require supporting attribution anchors. Participant metadata alone does not
prove endorsement or speaker identity. Anchors provide traceability; they do not
prove that a model interpreted the text correctly.

Initial bounds are eight events and 24,000 quoted UTF-16 code units per call,
64 mentions, 128 claims, 256 aggregate anchors, 1,024 aggregate references,
eight anchors per item, four
candidate refs per mention, eight context refs per claim, 512 UTF-8 bytes per
label, 400 UTF-16 code units per literal, 1,200 per body, and 256 KiB of response
JSON before parsing. Input catalogs and aggregate refs are separately bounded.
Offsets select exact supplied text without Unicode or newline normalization;
surrogate-pair splits, absent events, unknown handles, duplicate IDs, extra keys,
and malformed intervals reject the response before any durable effect.

Unknown predicates remain counted per-draft abstentions after reference and
authority checks. Predicate specs declare permitted object kinds; B2 adds the
small reviewed directional vocabulary for classification, membership,
authorship, parts, influence, contrast, employment, preference, and taste.
Trusted category words need not appear literally in the source, but the
classified subject and supporting assertion must be grounded. Vocabulary terms
cannot become people, speakers, owners, or arbitrary context subjects.

One mention denotes one occurrence. Cyclic candidate nominations are bounded
data, never recursive identity expansion. Repeated labels do not merge refs.
Orphan mentions gain no durable identity simply by appearing in a response.

## Complete result validation and version binding

[The shared result boundary](../packages/core/src/producer/result.ts) validates
every returned status before metrics, run receipts, durable decisions, audit, or
error construction. It snapshots exact bounded data, then checks the closed
status union, rejection enums, diagnostics, usage, drafts, and dropped items.
Usage fields are finite nonnegative safe integers capped at 1,000,000,000; the
result envelope is capped at 2 MiB. V1's existing response parser remains exact,
including its 64-claim per-response limit. A bounded v1 port may aggregate up to
eight responses, so result validation applies that parser to each chunk rather
than changing the old parser or its hashes.

V1 retains its declared string unavailability field on the wire. Consumers
receive the fixed reason `unavailable` and only validated fixed diagnostics.
V2 unavailability is the closed vocabulary `unavailable`, `timeout`, `network`,
`credentials`, or `http`. Both majors retain the existing declared rejection
reasons and diagnostic vocabulary. Unknown reasons, statuses, extra diagnostic
text, non-finite usage, and malformed success metadata produce a fixed
`schema_invalid` / `bad_response` projection.

A thrown exception or rejected promise produces fixed `unavailable` transport
diagnostics. No exception message is forwarded. Validation separately returns
trusted local `usage_known` metadata, which producers cannot supply on the wire.
The observer records attempt intent before calling the port. Unknown consumption
keeps that original durable `usage_unknown` record and at least one attempted
call; it cannot replace a spent reservation with a zero-token refund. Revalidating
the observer's fixed result at the extraction consumer makes no second provider
call and cannot overwrite the observer's accounting.

Keep `PORT_CONTRACTS.producer` at v1 and the registry key at `(kind, id)`.
`assertPortContract`, `bindFromConfig`, and `bindManyFromConfig` accept an explicit
expected contract, defaulting to the current compiled contract. Only producer
v1/v2 and the existing majors of other families are supported. A caller-supplied
future major is not supported merely because a descriptor repeats it. Check all
selected descriptors before any factory I/O.

Keep `kizuki.producer.model` as the existing v1 implementation. B2 alone registers
the real v2 factory under `kizuki.producer.model.v2`, selects v2 explicitly, and
records its descriptor in source capabilities and durable decisions. B1a has only
synthetic v2 registration tests. A v1 capability is never silently inherited by
the new descriptor. Extraction keeps one logical rail checkpoint across producer
selection; historical re-extraction is a separate versioned operation.

## Shared claim storage and immutable support

B1b–d retain common claim fields and add a versioned semantic portion and support
children. The following illustrates the owned relationships; final SQL belongs
to the B1b migration review, not B1a:

```sql
-- Proposed additions; not installed by the B1a contract change.
CREATE TABLE claim_v2_semantics (
  claim_id TEXT PRIMARY KEY REFERENCES claims(claim_id),
  semantic_key TEXT NOT NULL UNIQUE,
  payload TEXT NOT NULL
) STRICT;
CREATE TABLE claim_v2_support (
  support_key TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL REFERENCES claims(claim_id),
  admission TEXT NOT NULL
) STRICT;
CREATE TABLE claim_v2_support_events (
  support_key TEXT NOT NULL REFERENCES claim_v2_support(support_key),
  event_id TEXT NOT NULL REFERENCES events(event_id),
  PRIMARY KEY (support_key, event_id)
) STRICT;
```

Bounded, closed validators check payloads and indexed references; SQL `TEXT`
alone supplies no validation. Occurrence/support records preserve exact checked
event identity, source bindings, anchors, producer/model identity, and original
admission authority/confidence after Core clamps. Aggregate corroboration cannot
rewrite those snapshots. Rebuild derives the provenance union and support index.

Three domain-separated identities remain distinct:

1. The semantic assertion key includes schema and record discriminator, raw
   endpoints, predicate, typed object, polarity, perspective, sorted context,
   original valid interval, and temporal basis. Identity controls instead include
   the complete canonical action/partition payload, component digest, and policy.
   Body, display alias, model score, and caller-supplied authority are excluded.
2. The support key adds sorted exact anchors and verified event/source identities.
   Duplicate support adds neither a row nor another confidence observation.
3. The durable-decision digest includes declared producer/draft/integrity versions
   and its exact normalized output, checked input manifest, and Core-owned local
   handle/occurrence mapping.

Occurrence refs use a canonical length-delimited, domain-separated SHA-256 tuple
of connector, resolved source identity, source record ID, event ID/hash version/
revision hash, text hash, and UTF-16 offsets. Read long source record IDs from the
immutable event rather than copying them into each occurrence. A changed label
does not change identity; a new source revision supplies new evidence. Resolve
and compare the whole mint tuple on collision. Raw refs use ingress byte bounds.

One shared writer performs pure/asynchronous preparation, then synchronous
`commitPreparedClaim` inside the caller's final immediate transaction. V1/v2
admission, identity, correction, and undo use it. It rechecks accepted event
bindings, source epochs, authority, semantic/support identity, and duplicates at
commit. Retrieval and file work stay in the post-commit outbox. No second insert
function, direct identity claim SQL, temporary v1 dedup column, or separate model
entity store is introduced.

## Time and reader compatibility

Expose a discriminated `ClaimRecord = ClaimV1 | ClaimV2` only when the complete
B1b–d group is ready. Existing v1 parsing, non-null start dates, hashes, and replay
remain exact. A v1-only reader gets explicit unsupported-schema behavior for v2.

Known validity is a half-open interval with a real start; unknown validity has
no asserted start or end. Producer `observed` dates use Core's observation-time
rule at admission. Unknown time is never invented from claim creation time.
Unknown-time assertions conservatively overlap matching conflict scopes and
cannot win recency against dated evidence. Preserve uncertainty unless a higher
authority rule resolves it. A correction can retract at transaction time without
manufacturing a historical truncation from an unknown bound.

Explicit valid-time queries exclude unknown intervals from dated results and
report only authorized uncertainty. Current/unfiltered context may include them
with unknown validity stated. Gap detection uses known intervals; transaction
history uses real assertion/retraction receipts. Update conflict, gap, store
supersession, correction scope, serving, and serialization consumers before any
v2 writer is public. Supersession projects effective validity; it never rewrites
the original semantic payload or key.

## Identity authority, receipts, and lifecycle

A0 makes unsafe mutation and unavailable alias reads explicit typed refusals;
packet and doctor report a fixed identity limitation. Ordinary purge uses raw
refs; alias expansion refuses until complete authority can be checked. Bounded
legacy parsing must cover restoration, event/source erasure, and verification.
An incident endpoint is erased even if its old evidence list is forged.

A1 uses ordinary positive `identity.same_as` claims as observations and a closed
`identity_control` semantic variant for Core-issued merge, separation, and undo.
The producer and generic `propose` cannot construct control claims. Accepted
identity changes require a validated receipt; `identity_links` is only a
projection. Legacy rows acquire neither retroactive receipts nor owner authority.

Autonomous identity requires eligible independent external support and no active
owner separation constraint. Score independent roots from immutable admission
snapshots, grouping same source, source revisions, exact cross-connector copies,
and otherwise dependent evidence conservatively. Two separate single-root
admissions remain capped at 0.5 even if mutable aggregate confidence later reaches
0.95. A genuinely joint, source-grounded two-independent-root admission can retain
0.95 model-inference confidence for both roots. The second-highest eligible root
score supplies the threshold; model confidence alone never merges identities.

An identity receipt is a new discriminated Core receipt, separate from exact
existing canon receipts. It records decision claim, policy, before/after component
digests, canonical plan, checked support, authority/sensitivity, time, inverse
receipt link, and integrity. Indexed support refs and pending canon/retrieval
steps participate in purge and rebuild. Database-only identity undo never calls
the page writer.

Decision claim, receipt, projection, epoch, holds, and pending effect steps commit
atomically. Exact owner correction also accepts its immutable native event and
bound owner proof in that same transaction. Pre-commit failure, dry-run, ambiguous
scope, or capacity refusal leaves no event, claim, receipt, epoch, or file effect.
Recheck source epochs and the whole component digest immediately before commit.
Concurrent stale transitions refuse without mutation. Retries compare complete
identities and return the existing receipt without new confidence or owner events.

Bound components to 256 members, 1,024 relevant edges, and 256 affected pages.
Overflow never returns a partial accepted component. Separation has 2..16
disjoint non-empty partitions containing exactly the component's raw members.
Remove crossing accepted edges and retain the owner's negative constraint;
bridging through another subject cannot bypass it. Undo verifies the after digest,
retained authorized evidence, and dependent receipt chain before applying the
stored inverse as a new receipt. It requires no model.

Materialize child canon/retrieval effects after commit, with affected artifacts
held until complete. Existing batches of at most 25 pages and child receipts make
restart idempotent. Pending materialization must be reported as pending.

Raw-ref purge remains raw-ref purge. Explicit alias purge freezes the complete
validated merged component, exact event selection, and source/component fences
before deletion. Candidate, rejected, legacy, or unsupported edges confer no
deletion authority. Revocation removes present eligibility; physical erasure also
removes dependent support/payload/projection residue. Purging an occurrence erases
its complete immutable source event, with record/source counts made visible.

Physical purge converts affected identity receipts to the exact
`kizuki.identity-receipt-purged/v1` tombstone. It clears all prior plan, support,
authority, component, inverse, and old-integrity payload, retaining only opaque
receipt/purge IDs, purge time, private sensitivity, and the new tombstone digest:

```text
sha256(UTF8("kizuki.identity-receipt-purged/v1") || 0x00 ||
       UTF8(canonical({receipt_id, purge_receipt_id, at, sensitivity:"private"})))
```

Delete support indexes and completed child steps; transfer unfinished erasure
work to purge operations first. Scrub dependent preimages transitively. Do not
retain raw aliases or guessable old hashes in permanent completed receipts.
Tombstones need matching purge-journal linkage, supply no identity authority,
and cannot undo. Partially scrubbed rows are invalid.

## Migration, replay, restore, and retirement

Backfill historical extraction rows explicitly as producer/v1, draft/v1, and
integrity/v1 without altering their draft bytes, digests, claim IDs, or manifests.
Dispatch declared version combinations; never try parsers until one succeeds.
Drain pending v1 decisions through their original semantics before selecting v2.
Historically partial v1 filings retain exact old identities. New batch row inserts,
outbox, frontier, and completion all roll back together or all commit together.
Replay uses the saved occurrence map and never calls the provider to upgrade it.

B1 backup v4 requires claim semantic/support/occurrence/decision streams even when
empty. A1 backup v5 additionally requires identity receipt/effect/legacy streams.
Restore validates semantic identities, source bindings, history, declared versions,
and purge tombstones before publishing staging, then rebuilds projections. Re-signed
outer checksums cannot excuse malformed semantics. Unkeyed hashes prove consistency,
not authenticity against an operator coherently rewriting the whole archive.

Legacy identity rows migrate in bounded keyset pages to private unverified history;
they are never active aliases or fabricated negative constraints. Malformed rows
abort atomically; unresolved support stays inert. Migration uses at most 32 rows per
page and bounds before JSON parsing. No in-place downgrade is supported: preserve
a pre-upgrade backup and open it separately for rollback. Older binaries refuse
newer ledgers and archives. Old v1 readers and the real v1 producer remain supported
for at least one release and until all supported v1 pending decisions/backups have
an explicit retained reader or migration path. Retirement requires its own reviewed
change; B1a never silently retires them.

## Projections and semantic acceptance

Stage C derives typed graph/catalog/search records from accepted claims, support,
and identity receipts. Relations carry direction, polarity, perspective/mode,
context, validity, evidence, authority, and sensitivity. Qualified claims never
become unconditional graph facts. Filter both endpoints, labels, aliases, counts,
and context fragments under current authorization. A private endpoint must not
leak through an otherwise public relation count.

Rebuild from durable accepted decisions is deterministic and model-free.
Re-extraction with a new model is separately versioned and cannot promise the same
semantic decisions. Neither path may resurrect revoked or purged data.

Scripted tests prove boundaries, not interpretation quality. Full discovery
acceptance requires a frozen synthetic development/held-out corpus, fixed model,
prompt/parser versions and budgets, negative controls, and independent unfamiliar
human judgment. Report discovery/classification precision and recall by subject
class, false merges, relation direction, attribution, context/time, support,
abstention, and authorized public retrieval. Empty output and indiscriminate
overclassification both fail. Issue completion and semantic qualification remain
open beyond the engineering stages.

## Verification

B1a must prove valid v1/v2 parsing, exact v1 compatibility, all status branches,
malformed usage and diagnostics, thrown errors, canaries at mine/write/rail
boundaries, durable unknown-consumption accounting, explicit major mismatch before
factory I/O, and no real v2 factory or writer exposure. All fixtures are synthetic.

```bash
bun test packages/core/test/producer packages/core/test/contracts \
  packages/core/test/serve/producer-result-boundary.test.ts \
  packages/core/test/serve/extraction-budget.test.ts
bun run typecheck
```

Use the pinned Bun 1.3.10. Later stages additionally require mixed-version and
unknown-time behavior, immutable support dedup/corroboration, source/CAS races,
every correction failure boundary, partition bridge rejection, undo/cascade,
event and source purge totality, migration rollback, tampered restore, complete
rebuild equivalence, and CLI/MCP/context results. Run affected package tests and
`bun run verify` on the final composed head, then obtain separate specification/
security and implementation/regression reviews. A draft RFC, isolated parser
suite, or unaccepted event base does not satisfy those later gates.

## Alternatives and open dependencies

Rejected alternatives are prompt-only discovery, provider-chosen durable refs,
same-name merging, aggregate mutable confidence as admission history, direct
identity SQL, a temporary identity support journal, unversioned JSON payloads,
backup format guessing, silent empty alias success, and partial schema rollout.
They each bypass a lifecycle or authority boundary above.

Open dependencies are the accepted causal event binding and atomic extraction
interface, final B1b schema/reader composition, final identity receipt DDL, the
reviewed B2 predicate catalog, authorized retrieval capabilities, and held-out
semantic quality. This RFC does not authorize runtime, account, or model activity.
