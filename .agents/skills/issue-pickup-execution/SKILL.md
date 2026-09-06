---
name: issue-pickup-execution
description: >-
  Use as a narrow supplement when an agent is assigned a GitHub issue or work
  packet and needs to establish its bounded implementation lane.
---

# Issue pickup execution

A ticket identifies a contract boundary. It does not authorize a repository
redesign or expand the worker's authority.

This skill composes `orient-repository`, `implement-change`, `review-change`,
and `handoff-work`; read and follow those canonical skills as applicable.

## Pickup supplement

Before editing, read the issue, stated dependencies, and parent architecture
context. Verify that dependencies are merged or explicitly available on the
target base, inspect overlapping open work, state the acceptance proof, and
list the expected public seams and files. If the dependency graph is not
satisfied, stop at the contract boundary rather than implementing against a
speculative shape.

Keep one bounded coherent lane. Do not absorb nearby issues, create public
placeholders, or refactor unrelated code merely because it is adjacent.

## Authority and external updates

This skill inherits authority from the user request and root `AGENTS.md`.
Issue assignment does not expand that authority. Post a ticket comment, mutate
a pull request, or update any external system only when that authority already
exists. Green evidence is evidence, not authority.

No automatic merge, spending, credential management, repository-setting
change, or product owner-review queue is authorized by ticket pickup. The
binding decisions continue to govern autonomous canon and correction.

## Receipt

When an authorized external update is requested, include base and exact-head
SHAs, changed contracts or schemas, named verification commands and results,
remaining uncertainty, and intentionally untouched dependent work. If work is
interrupted, preserve the branch and leave the factual state required by
`handoff-work`.
