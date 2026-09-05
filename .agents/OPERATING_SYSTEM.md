# Kizuki Agent Operating System

This file defines how high-calibre agents should work in Kizuki. It complements `AGENTS.md`; it never overrides binding product law in `docs/CURRENT.md`, `docs/decision-log.md`, or merged RFCs.

## Mission

Every agent should leave Kizuki more correct, simpler, safer, easier to understand, easier to extend, and easier for the next agent to pick up.

Kizuki is not a playground for clever code. It is a local-first personal world-model substrate whose value depends on trust, provenance, reversibility, composability, and continuity across humans and agents.

The standard is not “the tests pass.” The standard is:

> The behavior is correct at the public seam, the architecture is coherent, the evidence is strong, the failure modes are bounded, the user experience is clearer, the developer experience is cleaner, the agent experience is more structured, and the next agent has less ambiguity than this one started with.

## The seven operating laws

### 1. Evidence before edits

Do not code from the issue title. Reconstruct the live state first: governing RFCs, current branch, open PRs, affected contracts, callers, tests, recent commits, and the exact failure or acceptance seam.

Never infer a missing fact when the repository can answer it.

### 2. One semantic truth

A concept must not mean one thing in core, another in CLI, and a third in MCP. UX, DX, and AX are projections of the same core capability.

For every public capability ask:

- What is the canonical semantic object or operation?
- Where is authorization enforced?
- What is the machine-readable contract?
- What is the human rendering?
- What does an agent receive?
- What receipt or provenance explains it?

If those answers diverge, fix the architecture before polishing a surface.

### 3. Make uncertainty explicit

Kizuki models reality; therefore unavailable, unknown, stale, inferred, contradicted, and empty are different states.

Never collapse:

- unavailable into empty;
- inferred into observed;
- repeated copies into independent corroboration;
- consumed content into learned knowledge;
- agent “done” into real-world success;
- correlation into causation;
- current state into historical truth.

When the system cannot know, make that state queryable and test it.

### 4. Prefer narrow, composable primitives

Do not build feature islands. Extend existing contracts and seams before inventing new ones. New abstractions earn their existence by removing duplication, enforcing a boundary, or supporting multiple real implementations.

The ideal change has a small public surface and a strong internal invariant.

### 5. Design failure first

Before implementing the happy path, write down the dangerous failures:

- duplicate delivery;
- stale state;
- partial commit;
- process death;
- retry after unknown outcome;
- missing provenance;
- permission narrowing mid-session;
- purge/correction after derivation;
- malformed or adversarial captured content;
- concurrent writers;
- degraded dependencies;
- old clients against new schema.

Then make those cases observable, recoverable, and testable.

### 6. Every change must improve UX + DX + AX

Not every task needs a new UI, SDK, or MCP tool. But every task must evaluate all three:

**UX**: Is the behavior understandable, low-ceremony, honest, and recoverable for a person?

**DX**: Are types, APIs, errors, migrations, tests, and contracts simple enough for another developer to use correctly?

**AX**: Can an authorized agent consume the capability without prose scraping, ambiguous state, or policy duplication?

If one dimension would regress, redesign before shipping.

### 7. Leave proof, not confidence

Completion requires exact-head evidence. Record the head SHA, exact commands, relevant outputs, changed contracts, residual uncertainty, and intentionally untouched work.

“Looks good” is not a receipt.

## Work cycle

### A. Orient

Read in this order:

1. `docs/CURRENT.md`
2. `docs/decision-log.md`
3. binding RFCs
4. `docs/architecture.md`
5. root and nearest `AGENTS.md`
6. the target GitHub issue / PR and its dependencies
7. relevant skills in `.agents/skills/`
8. affected public exports, tests, migrations, and call sites

For world-model work also read #480 and epic #497, then the exact child ticket.

### B. State the contract before coding

Write a small internal contract:

- input;
- output;
- authority boundary;
- persistence boundary;
- idempotency identity;
- failure semantics;
- compatibility requirement;
- acceptance proof.

If you cannot state the contract cleanly, you are not ready to edit code.

### C. Build from the public seam inward

Prefer this order:

1. acceptance fixture or characterization test;
2. contract/type/validator;
3. storage or core implementation;
4. policy enforcement;
5. derived projections;
6. adapters / CLI / MCP;
7. docs and examples;
8. broad verification.

Do not start at the adapter and tunnel inward with special cases.

### D. Run the adversarial pass

Before PR handoff, ask:

- Can stale clients do the wrong thing?
- Can retries duplicate state?
- Can one unauthorized graph edge leak a hidden subject?
- Can a model failure masquerade as “no result”?
- Can a correction or purge leave derived state alive?
- Can captured text become instruction?
- Can a crash leave an unreceipted mutation?
- Can a migration silently reinterpret old data?
- Can this be made simpler without losing a real requirement?

### E. Prove the exact head

Focused tests first, then package tests, typecheck, full repository verification, documentation/claim checks, and any domain-specific security/performance gates.

Re-run after rebases or final edits. Old green checks are not evidence for a moved head.

## Agent pickup protocol

When taking a ticket:

1. Confirm its dependencies are merged or explicitly available on the target base.
2. Claim only the bounded packet. Do not absorb neighboring issues for convenience.
3. State which files/contracts you expect to touch before editing.
4. If a required contract is speculative or unmerged, stop at the contract boundary rather than implementing around it.
5. Keep one PR per packet unless the issue explicitly says otherwise.
6. Update the ticket with exact-head receipts and newly discovered blockers.

## Communication standard

Be concise and concrete. Report findings before summaries. Separate:

- proven fact;
- interpretation;
- recommendation;
- future direction.

Never pad a handoff with generic “best practices.” Name the exact invariant, path, failure, or proof.

## Quality bar

A high-calibre Kizuki change should feel inevitable in hindsight: fewer moving parts, clearer names, stronger invariants, better evidence, and no new place for truth or policy to fork.