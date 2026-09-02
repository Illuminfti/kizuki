---
name: review-change
description: Review a Kizuki branch or pull request at an exact head for specification, security, correctness, regressions, and integration risk. Use before readiness or merge, after a head changes, or when asked for an independent code review.
---

# Review a change

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

Fail any change that reintroduces one of those policies, in code, tests,
documentation, specs, skills or pull-request text.

## Pin the target

1. Run `orient-repository`.
2. Record base SHA, head SHA, merge base, draft state, changed files, commits,
   open review threads, and CI attached to that exact head.
3. Refuse to reuse an earlier review after the head changes.

## Axis 1: specification and security

Check the task, binding RFCs, architecture, authority boundaries, privacy,
provenance, purge, zero-phone-home, secret custody, fail-closed behavior,
untrusted input separation, and honest product claims.

Trace every changed public path from entrypoint to storage or output. Verify
denial paths, not only success paths.

## Axis 2: implementation and regression

Inspect correctness under duplicate delivery, retries, concurrency, partial
failure, rollback, restart, stale handles, migration, malformed input, large
input, compatibility, and existing callers. Look for unreachable code,
retained capability use, weak identity checks, lossy normalization, unbounded
work, and tests that assert implementation details instead of the public seam.

## Verification

Run focused tests, package tests, typecheck, full repository verification, and
`git diff --check` on the exact head. Inspect CI logs rather than relying only
on a green badge.

## Findings format

List findings first, highest severity first. Each finding must include:

- severity and concise title;
- file and line or symbol;
- concrete failure and affected invariant;
- minimal reproduction or reasoning trace;
- required correction.

Then list questions, test receipts, and residual risks. If there are no
findings, say so explicitly and still state the areas examined and tests run.
A clean review is not merge authority.
