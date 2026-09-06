# P003 release-contract owner review

Review date: 6 September 2026. This is a static contract decision. It does not
implement a validator or grant release credit.

## Inputs

- P003 output: `PRIVATE_FLEET/workers/P003-attempt2/workspace/out`
- P003 validator SHA-256: `0bdf8001a07f77d8f029871b0fb168c04ee67385e12b205f7406286b6330b904`
- P003 validation-report SHA-256: `0397fcc55d339a5a44445d9d31f7be69664314bd61aa33f40aa946a8d7251476`
- Current source: clean `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7`; the P003-relevant release files are unchanged from its inspected `32713ad98899a8d1e8ac21a2ebbe3170f6af51a0` base.
- Live issue 403: open, updated `2026-09-06T20:19:00Z`; D19 requires stranger installation/use, executable product proof, zero live P0s on the exact candidate, and an honest install path. It removes only the mandatory calendar/cutover gates.

## Decision

Do not freeze all twelve proposed family contracts. Freeze only the shared v3
reference envelope after the corrections below, then let P004 implement that
reader and one tree-local proving family, `surface.capabilities-and-docs`.
Every other new gate must retain its current `NOT_IMPLEMENTED` or
`UNVERIFIABLE` state until its trusted producer, enrollment/snapshot source,
and family-specific binding are separately frozen.

The 43/43 fixture result proves the supplied synthetic cases agree with the
book validator. It does not exercise filesystem custody, reference binding,
producer identity, actor enrollment, snapshot freshness, or receipt graphs.

## Required corrections for P004

1. Freeze a total mapping from producer schema to exact gate id and target.
   Native and lifecycle refs use `native.<target>` and `lifecycle.<target>` and
   must match the receipt target. Singleton families use their one exact gate
   and `target: null`. Journey and connector gate suffixes must equal the
   receipt's `journey_id` or `connector_gate_id`. The current fixture validator
   accepts any allowlisted producer with any unique gate string.
2. Validate raw files through the existing custody boundary: canonical
   absolute path, safe regular-file read, no symlink component, byte cap,
   supplied SHA-256 equality, exact JSON/depth/duplicate-key validation, and a
   final unchanged check. Use 32,768 bytes for v3; 65,536 for ordinary family
   receipts; 262,144 only for journey/connector. A parsed `unknown` value alone
   cannot enforce these invariants.
3. A receipt may not choose the files that authenticate its producer. Each
   implemented producer has a fixed, evaluator-owned sorted file list. Require
   `identity.producer_files` to equal that list and recompute
   `producer_revision` as SHA-256 of canonical
   `{files:[{path,sha256}]}`. The surface list includes the new producer and
   shared-validator implementation files. Observed product/docs files belong
   in the family payload, not in the producer identity.
4. Surface PASS is recomputation, not `disagreements: []`. Bind the exact
   candidate, supported Bun version, CLI group sequence, retired verbs, MCP
   tools, complete registered connector inventory, frozen C3 obligations, and
   the exact `README.md`, `SECURITY.md`, `docs/CURRENT.md`, and `docs/cli.md`
   hashes. Require closed, sorted, unique, bounded lists. Any difference is
   FAIL and remains listed in the receipt.
5. Validate real RFC3339 instants rather than only their character shape.
   Resolve the generated schema's printable-ASCII rule versus the validator's
   Unicode-without-controls rule. Apply exact list bounds consistently.
6. Add the shared validator and surface producer to `VERIFIER_FILES` in the
   same change that consumes them. Preserve v1/v2 behavior and keep the report
   `NO-GO` after P004.

## P004 status rules

- An absent reference leaves the gate's existing default state.
- An unknown/duplicate/malformed index reference makes `evidence.index` FAIL;
  no new family reference is consumed.
- A listed receipt that is missing, unreadable, changed, oversized, digest
  mismatched, schema mismatched, candidate mismatched, producer-revision
  mismatched, or gate/target mismatched makes that named gate FAIL with no
  evidence digest credited.
- A fully bound `outcome: fail` makes the gate FAIL. A fully bound
  `outcome: unresolved` makes it UNVERIFIABLE. Only a fully bound
  `outcome: pass` may make an implemented family PASS.
- Synthetic/local-operator fixtures never upgrade native, actor, account,
  human, CI, review, or live-finding gates.

## Families not frozen by this review

The P0 schema cannot satisfy D19 yet: its receipt-selected `max_age_ms` is not
compared to anything, and `complete: true` plus an empty inline array can
self-declare PASS. A retained findings-snapshot publisher, fixed freshness
rule, completeness boundary, and post-snapshot residual semantics must be
designed first. The required-checks schema similarly names a snapshot digest
without a snapshot path the validator can read. Review, native, lifecycle,
journey, connector, human, and optional authority receipts also depend on
missing producer or enrollment sources that JSON labels cannot replace.
