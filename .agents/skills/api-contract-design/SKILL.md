---
name: api-contract-design
description: Design or evolve a Kizuki public TypeScript, CLI, connector, MCP, or storage-facing contract with explicit semantics, compatibility, validation, errors, idempotency, authorization, and tests. Use whenever callers will depend on a new or changed interface.
---

# API and contract design

## Contract first

1. Run `orient-repository` and locate every current caller and implementation.
2. Define the caller-visible outcome before choosing types or names.
3. Specify inputs, outputs, invariants, defaults, ordering, limits, and failure semantics.
4. Define validation at the trust boundary. Reject ambiguous or partially valid state.
5. Make identity, authorization, sensitivity, provenance, and secret handling explicit where relevant.

## Compatibility

Classify the change as additive, behavior-changing, deprecating, or breaking.
For existing contracts, preserve source and behavioral compatibility unless the
task explicitly authorizes a break. Search all call sites, fixtures, docs, and
serialized forms before changing a public type.

Design retries and duplicate requests deliberately. Name idempotency keys,
stable identifiers, cursor semantics, and whether operations are atomic.

Errors should be stable enough for callers to act on without exposing private
content. Do not encode policy only in prose when a type or validation rule can
make invalid states unrepresentable.

## Proof

Add contract tests at the public seam. Cover valid input, invalid input,
boundary values, compatibility with existing callers, duplicate calls,
authorization denial, malformed serialized data, and deterministic ordering.
For CLI or MCP surfaces, test machine-readable output and error behavior end to
end.
