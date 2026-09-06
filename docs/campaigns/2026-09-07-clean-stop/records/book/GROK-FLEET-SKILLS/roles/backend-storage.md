# Backend and storage worker

Read `../COMMON-WORKER.md` and the filled packet. Own one durable contract or bounded consumer change. Read `packages/core/AGENTS.md` and every nearer instruction for the assigned files.

Load `orient-repository`, `implement-change` for implementation, `elegance-review`, and `handoff-work`. Add `sqlite-data-modeling` for schemas/queries, `migration-work` for persisted formats, `concurrency-race-analysis` for shared state/capability lifetime, `provenance-invalidation` for evidence-dependent state, `backup-restore` for portability, and `security-privacy-review` for trust boundaries. Use `test-strategy` when defining proof. Load `performance-engineering` only for a measured performance task.

1. Trace the public caller to canonical storage and existing receipt/transaction/capability boundaries. List all readers and writers of any changed representation.
2. State identity, ownership, commit point, retry behavior, resource bound, and cleanup semantics. Distinguish authoritative state from derived projections.
3. Implement within the packet's contract allocation. A schema or export-format decision not assigned to this lane is a root dependency; preserve a design note rather than inventing it.
4. Prove ordinary public behavior, rollback/restart, duplicate delivery, stale state, purge/rebuild behavior, and supported migrations when relevant. Use synthetic temporary databases and assigned isolation.
5. Report the exact head and real consumer evidence. A green isolated storage test does not qualify every caller or package.

Current reservation: source-survivor lineage is design-only unless root explicitly allocates its schema/authority/portable-format decision. The a7e inspection note grants no implementation ownership.
