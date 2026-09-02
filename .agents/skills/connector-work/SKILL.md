---
name: connector-work
description: Research, design, implement, or review a Kizuki connector or importer with sanctioned authentication, honest provider limits, secret custody, normalization, conformance, deletion, and purge behavior. Use for any provider-facing source integration.
---

# Connector work

## Binding context (read first)

Read `docs/CURRENT.md`, `docs/decision-log.md` and
`rfcs/0002-autonomous-canon.md` before anything else in this playbook. They
are binding and override every other document in the tree, including this
one. Never write, restate or re-derive a superseded policy as current:
owner-invoked promotion as the canon write path, or any owner review queue
or approval step (D9, D10; corrections go through MCP `correct` and
`kizuki tell`, D14); owner labeling of sensitivity (D11; auto-labeled,
private by default); a zero-model floor that writes canon (D12; capture,
ledger, search, timeline, context, audit and undo stay model-free); a
SQLite-only rule for derived retrieval (D13; retrieval sits behind a
versioned port with its own rebuildable store under the vault); an
owner-started daemon (D15; `kizuki init` installs it); or the review gate as
the product's moat (C8).

## Research packet

Use current official provider sources. Record the check date and:

- sanctioned auth flow and scopes;
- one-time operator or project setup;
- end-user steps;
- token and client-secret custody;
- history and backfill limits;
- incremental cursor or webhook behavior;
- edits and deletions available to the API;
- approval, verification, admin, review, and billing gates;
- export or manual fallback when live access cannot meet Kizuki's promises.

Do not substitute unofficial APIs, scraping, session theft, or wishful OAuth
assumptions.

## Implementation packet

1. Run `orient-repository`.
2. Identify whether the source is live sync, local loopback, folder watch, or
   export import. Name it honestly.
3. Reuse the frozen connector and event contracts.
4. Build stable source identity, deterministic normalization, bounded
   pagination, timeout and retry behavior, checkpoint durability, tombstones,
   revoke, purge planning, and synthetic fixtures.
5. Keep credentials behind supported secret references. Persist only safe,
   opaque state whose representation cannot contain credentials.
6. Make network access explicit and absent from fixture/conformance execution.
7. Add the registry entry last, after implementation and conformance pass.

## Required proof

Run shared conformance and provider tests. Prove missing-credential refusal,
double-backfill idempotency, resume after interruption, stable hashes,
tombstones or documented absence, revoke, purge plan, malformed input,
redaction, and no unexpected egress. Finish with typecheck and full repository
verification.

State every provider limitation in public documentation without overstating
coverage.
