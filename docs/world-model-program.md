# Kizuki world model implementation program

Status: planning guide. Public capability and acceptance claims require implementation and exact-head evidence.

GitHub issue #497 is the single authority for live packet dependencies, ownership and progress. This guide connects that program to the repository; it is not a second completion tracker. Architecture direction is #480; Situation and UX/DX/AX direction is #476.

## Purpose and governing contracts

Help a person resume real work with another authorized client using current, evidence-backed context, without reconstructing the project's history.

[RFC 0002](../rfcs/0002-autonomous-canon.md), [RFC 0000](../rfcs/0000-constraints.md), the [current direction](CURRENT.md) and [decision log](decision-log.md) govern until an accepted amendment explicitly changes a named contract. [RFC 0003](../rfcs/0003-rich-subject-foundation.md) proposes the rich-subject/shared-support foundation; [RFC 0004](../rfcs/0004-living-epistemic-world-model.md) proposes the broader claim-backed world model and scoped views. Both remain proposals. Merging a planning document does not itself bind its schema or implement its surfaces.

## Invariants and shared product law

- Preserve frozen `kizuki.event/v1`, the append-only event ledger except receipted purge, authoritative SQLite claims and readable Markdown canon. Derived stores remain rebuildable behind their existing ports.
- Eligible claims reach canon only through the existing receipted writer. World Slices independently project permitted evidence, claims, canon and derived views; they confer neither canon-writing nor external-action authority. Kizuki hosts no agent loop.
- Preserve source support, perspective, valid and recorded time, correction authority, supersession, purge, recovery and reversibility. Copies and generated summaries do not become independent witnesses.
- Enforce source consent, grants and sensitivity before candidate discovery and through traversal, ranking, dependency closure, counts, compression and model use. Externally visible IDs, revisions, hashes and change signals belong to the principal's permitted view; changed grants require a new view.
- Captured text stays untrusted data. Network access stays limited to explicitly configured connectors and model endpoints. Capture and permitted recall remain useful without a model; autonomous canon requires one.
- Record learning and skill as independently evidenced, contextual facets. Exposure, assisted work, independent application and unknown competence retain their distinct meanings.

Every capability has one canonical Core implementation and one versioned semantic contract. Human, developer and agent surfaces project that contract within each principal's current grant. UX, DX and AX must agree on meaning, provenance, uncertainty, freshness, errors and correction; different grants can legitimately produce different data.

## Delivery map

Follow issue #497 for the current dependency graph. The groups below explain the sequence without maintaining another exhaustive task list.

| Work | Dependency and delivery boundary |
| --- | --- |
| Foundation and first Concept | #481 reconciles RFC 0003/0004; #482 supplies typed observations and shared outcome-evidence contracts; #483 supplies temporal support, revision and invalidation contracts; #484 proves a small Concept with useful human and agent views. |
| Bounded consolidation | #503 builds on #482/#483. The first Concept may honestly report pending or unavailable richer processing while consolidation develops; stale understanding cannot silently appear current. |
| Present-day continuity | #502 Stage A uses existing verified capture, context, correction and MCP seams with #458 onboarding. It can proceed without the full ontology, Atlas, forecasts or a new World Slice API. |
| Domain expansion | Questions and learning (#485), perspectives (#486), skills/frameworks/procedures (#487), situations and independent commitments (#488), and exact-version artifacts/exemplars (#494) reuse merged shared contracts. Skills use the early outcome-evidence contract rather than waiting for the entire later feedback loop. |
| Semantic continuity and human views | #489 starts from Concept/Situation views and adds providers as they land. #490 follows the implemented scoped view/revision contracts; #502 Stage B consumes those views and diffs. #495 composes Atlas views incrementally; small Concept/Situation cards accompany #484/#488. |
| Outcomes and prospective analysis | #491 adds goal-aware attention after situation/freshness support. The full #492 feedback loop follows skills, situations and slices. #493 follows dependable state, freshness and outcome resolution; it does not block early continuity. |

#496 fixtures and resource, privacy, purge, recovery and UX/DX/AX checks start with the first slice and grow with each packet. There is no final-only verification phase. Shared schema changes are serialized; independent domain work starts only on accepted shared contracts.

## Definition of done for each packet

- One explicit versioned contract, lifecycle, authority boundary and storage/rebuild rationale, shared by its applicable UX/DX/AX surfaces.
- Provenance, temporal correctness, owner correction, source deletion, purge, revocation and recovery demonstrated through public seams.
- Permission checks below prompts, deterministic errors, retry/idempotency semantics, migration and rollback safety, and measured resource bounds.
- Focused synthetic fixtures, relevant denial/recovery cases and public-surface conformance; exact-head `bun run verify` and independent review.
- Honest documentation of implemented coverage, unsupported cases and evidence limits. Fixtures, a transport demo or a planning document do not establish human, live-client, account or release qualification.

Preserve existing worktree and packet ownership. Public adapters consume accepted Core contracts instead of local substitutes. A needed invariant change goes through the accepted RFC process before incompatible implementation; no packet gains merge or deployment authority from this guide.

## Staged acceptance journey

**Stage A:** select one source with explicit consent, enroll two independently scoped clients, retrieve useful project context, have the owner correct one precise assertion through the existing authorized path, and have both clients retrieve the corrected context. Record the actual clients/versions and distinguish synthetic transport checks from unfamiliar-user and live-client trials.

**Stage B:** once the semantic contracts are implemented, each client obtains its permitted Concept/Situation context and relevant scoped diff. Narrow or revoke a grant and verify subsequent calls and retained-view validation against current policy. Keep Stage A and Stage B receipts separate; independently retained external text cannot be erased by revoking access.

Both stages preserve evidence, important constraints and correction history. Measure re-explanation burden, obsolete-assumption reuse, interventions and failures; do not infer success from a screenshot or a test count.

## Readiness

The owner's 5 September 2026 amendment at the top of issue #403 defines readiness as stranger installation/use, executable stranger proof, zero live P0s on the exact candidate and an honest install path. Seven-/fourteen-day observation is optional after readiness. Operational cutover requires separate authorization. Remaining product, connector, security, recovery, platform, review and verification requirements remain; historical timestamps and failed receipts receive no new credit.
