# Skills, frameworks and procedures

Implementation evidence date: 2026-10-21. These are read-only knowledge cards on
the existing world registry and claim pipeline. The three kinds remain
`offeredToProducer: false` pending the separate held-out model acceptance run.

## Read contract

`world_view` exposes `find_procedures`, `procedure`, `skill` and `framework`.
Discovery accepts an optional `label`, object `about`, and opaque `cursor`.
`about` requires a positive asserted `procedure.applies_to` relation before
paging. Discovery is a list of candidates; read a procedure's applicability and
counterexamples before using its steps. Object reads take the corresponding
opaque object reference and the standard `valid` and `knownAt` selectors.
CLI, MCP, HTTP and the App route use the same Core operations and contracts.

`kizuki.procedure-card/v1` keeps four dimensions separate:

- `evidenceStrength.assertions` retains attributed assertions and assessments.
- `taskUsefulness` is unknown without independent, matched outcome evidence;
  observed success and failure include their task, attempt, criterion, artifact,
  environment and assistance conditions. See [outcomes](outcomes.md).
- `applicability` preserves prerequisites, required capabilities, applies-to
  relations and counterexamples, including negative or contested assertions.
- `freshness` reports recorded validation claims; it does not turn a date into
  a freshness score or establish that the procedure remains applicable.

Steps are explicitly quoted data. The card has `executionAuthority: "none"`.
Neither reads nor retrieval counts change confidence, schedule work, execute a
step or confer permission to act. Standards, exemplars, strategies, success
checks and failure modes remain attributable relations.

`kizuki.skill-card/v1` keeps self-report, exposure, explanation, application and
observed-outcome assertions in distinct lists. An observed-outcome assertion stays
in self-report until an independent, matched outcome observation shares its
provenance; revocation removes that qualification. Demonstrations, about relations,
outcomes and validation dates retain their provenance. `mastery` remains
`unknown`: neither assisted performance nor one unassisted task establishes
general independent mastery.

`kizuki.framework-card/v1` retains references to nested components, purpose,
assumptions, applicability, failure modes and lifecycle evidence. Positive
asserted containment cycles are refused by the writer before claim insertion.
`framework.includes` is the canonical containment predicate; `framework.component`
is an additional explicit component relation with the same cycle rules.
The bounded read traversal independently refuses legacy or restored cycles.

## Privacy and history

Every card uses the existing authorization, source support, redaction, coverage,
known-time, share/resume and dependency machinery. Removing an outcome source
invalidates retained procedure views as well as current usefulness. Historical
procedure claims remain readable; historical usefulness explicitly returns
`unknown` with reason `history` because legacy outcome claims have no retained
valid-time history. No current outcome is substituted into a historical card.

## Verification

The executable acceptance cases are in `packages/core/test/world/skills.test.ts`,
`skills-security.test.ts` and `skills-recovery.test.ts`. They exercise independent
observed usefulness, failures, copies, exact replay, confounding, hostile steps,
cycles, correction, known-time, hidden evidence, denial audit, purge, rebuild and
export/restore. CLI/App and MCP/HTTP parity are exercised in the corresponding
`packages/cli/test/skills.test.ts` and `packages/mcp/test/skills.test.ts` files.
These are synthetic fixtures, not model-quality or production evidence.

## Contract refinement

The implementation uses a separate card for each registered kind, retaining the
existing CARD assembler and adapter pattern. The four procedure dimensions use
`evidenceStrength`, `taskUsefulness`, `applicability` and `freshness`. Outcome
usefulness retains matched evaluations and their conditions instead of reducing
them to a direction score. This refines the illustrative union-shaped card in
RFC 0004 Appendix B while preserving its evidence and authority rules. Steps
sort by their numeric ordinal (1 through 999), then stable reference; unnumbered
steps follow. Validation date assertions require an exact RFC 3339 instant.
