# Core package instructions

These rules apply under `packages/core` in addition to the root `AGENTS.md`.

## Binding context

`docs/CURRENT.md`, `docs/decision-log.md` and `rfcs/0002-autonomous-canon.md`
override this file and the root `AGENTS.md` wherever they conflict. Read them
before editing anything here. No change in this package may restate or
reintroduce a superseded policy: owner-invoked promotion or an owner review
queue or approval step (D9, D10), owner labeling of sensitivity (D11), a
zero-model floor that writes canon (D12), a SQLite-only rule for derived
retrieval (D13), or an owner-started daemon (D15).

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
- Canon mutation remains reachable only through the receipted writer
  (docs/decision-log.md D9, RFC 0002 §4.5). Agents propose claims and relay
  corrections; no client writes a page. There is no owner review queue and no
  owner approval step, and no test may assert one back into existence
  (docs/decision-log.md D10). Tests must scan the public write seam, not just
  one call site.
- Serving exposes two write tools, `propose` and `correct`
  (docs/decision-log.md D14, RFC 0002 §6). A correction supersedes the
  contradicted claim and rewrites affected canon in the same pass; it is
  never a competing record.
- Enforce identity, grant, sensitivity, scope, rate, and audit policy below
  adapters and prompts.
- Preserve total provenance for every proposal, claim, edge, search record, and
  purge consequence.
- Derived tables must be disposable. A clean rebuild must reproduce observable
  results and authorization behavior.
- Derived retrieval sits behind a versioned port, not inside core
  (docs/decision-log.md D13, D16; RFC 0002 §3, §9). An implementation may own
  a non-SQLite store under `<vault>/.kizuki/retrieval/` provided it is
  rebuildable from ledger plus canon with one command. The ledger, claims,
  receipts and canon stay SQLite plus Markdown. Do not name a concrete engine
  in core.
- The model-free floor covers capture, the ledger, search, timeline, context,
  audit and undo. Canon writing requires a configured model and `doctor` says
  so when one is missing (docs/decision-log.md D12).
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
