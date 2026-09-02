# Core package instructions

These rules apply under `packages/core` in addition to the root `AGENTS.md`.

## Responsibility

Core owns the durable contracts and policy boundaries: event acceptance,
ledger and connection state, claims, the receipted canon writer, undo, vault writes,
query policy, agent identities and grants, audit, purge, and rebuildable
derived projections. Changes here can invalidate every other package.

Read the relevant contract under `src/contracts`, its public export from
`src/index.ts`, storage code, callers, migrations, and tests before editing.

## Rules

- Do not change `kizuki.event/v1`, `kizuki.proposal/v1` / `kizuki.claim/v1`,
  connector contracts, vault frontmatter, or exported types casually. A
  contract change needs an explicit task, compatibility analysis, and any
  required RFC. RFC 0002 is the binding change for claims and the receipted
  writer; do not invent a third write path.
- Keep the ledger append-only. Do not update an accepted event to simulate
  correction or deletion.
- Canon mutation remains reachable only through the receipted writer.
  Agents propose claims and relay corrections; no client writes a page.
  Tests must scan the public write seam, not just one call site.
- Enforce identity, grant, sensitivity, scope, rate, and audit policy below
  adapters and prompts.
- Preserve total provenance for every proposal, claim, edge, search record, and
  purge consequence.
- Derived tables must be disposable. A clean rebuild must reproduce observable
  results and authorization behavior.
- Multi-step SQLite changes require an explicit transaction. Test rollback
  after each meaningful failure boundary.
- Multi-file state changes require complete writes, safe permissions, atomic
  replacement, directory durability where supported, rollback, and interrupted
  recovery.
- Capability objects and one-shot writers must become unusable at the intended
  terminal boundary. Test retained references.
- Validate persisted identities and ownership instead of trusting caller-built
  domain objects.
- Keep errors typed or structurally stable. Do not put captured text, secrets,
  tokens, or unrestricted arguments into errors or audit records.

## Test expectations

Start with the closest test and then run all core tests, typecheck, and the full
repository gate. Add regression cases for:

- first enrollment and replacement failure;
- duplicate and replayed ingestion;
- stale checkpoints and interrupted recovery;
- retained writers or capabilities;
- fabricated or mismatched identities;
- transaction and filesystem rollback;
- tombstone and subject purge cascades;
- migration from every supported schema;
- derived rebuild equivalence;
- denied access and audit redaction.

Use temporary directories and synthetic records only.
