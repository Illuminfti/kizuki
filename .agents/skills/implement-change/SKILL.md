---
name: implement-change
description: Implement or repair a bounded Kizuki change with test-first public-seam proof, minimal diffs, exact-head verification, and multi-agent isolation. Use for features, fixes, migrations, refactors, or documentation changes that alter repository behavior or claims.
---

# Implement a bounded change

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

## Inputs

Establish the requested outcome, authority, intended base, public seam,
acceptance evidence, and paths owned by this lane.

## Workflow

1. Run `orient-repository`.
2. Translate the request into observable success and failure behavior.
3. Find the narrowest existing public seam and neighboring tests.
4. Reproduce a defect or add a failing acceptance/regression test first when
   practical.
5. Implement the smallest coherent change. Preserve frozen contracts and
   invariant boundaries.
6. Test narrowly, then at package level, then typecheck and run the full
   repository gate.
7. Review the diff for retries, idempotency, partial failure, recovery,
   malformed input, authorization, privacy, egress, and resource bounds.
8. Fetch the base again. If upstream changed owned paths or contracts, integrate
   only your branch and rerun all gates.
9. Run `review-change` on the exact head or obtain an independent exact-head
   review when the task requires one.
10. Run `handoff-work`.

Load `.agents/skills/elegance-review/SKILL.md` and apply its standing bar before treating the change as done.

## Change discipline

- Do not weaken tests, suppress errors broadly, or add sleeps to hide races.
- Do not add dependencies for convenience.
- Do not mix unrelated cleanup with behavior changes.
- Do not create placeholder commands, registry entries, schemas, or claims.
- Do not touch another lane's uncommitted work or branch.
- Keep fixtures synthetic and deterministic.
- For durable state, test rollback and restart.
- For public APIs, test current callers and compatibility.
- For docs, prove every shipped claim against code on the same head.

## Evidence

Completion requires the exact commit SHA, base SHA, focused and full command
receipts, changed public contracts, security/privacy impact, unresolved risk,
and confirmation that no overlapping lane was overwritten.
