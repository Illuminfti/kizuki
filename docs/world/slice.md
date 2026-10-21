# Bounded task views

The `slice` operation collects authorized Concept, Situation, Question, Person, Skill, Framework and Procedure
cards through the existing projection pipeline. Each kind's assembler declares
which whole relations are constraints. Negative, conflicting, attributed or
inferred statements retain their qualifications. Constraints precede optional
detail in deterministic kind, object-reference and claim-reference order.

```sh
kizuki world --operation slice --task 'Resume the launch' --kinds concept,situation --budget-tokens 2000 --json
```

The same operation is available through `world_view`, loopback HTTP and the
App's **Prepare task view** form. Evidence remains opaque references; expanding
a source passage uses the existing evidence operation. This read performs no
model calls and writes no canon.

Requested providers appear explicitly, including `not_landed` and
`extraction_off`. Existing readable claims from a dark kind can still be shown,
with partial coverage. Visible unfinished extraction or consolidation remains
partial. Each request shares the existing 2 MiB projection budget and examines
at most four discovered objects per requested kind. A further discovery page
or object is reported as incomplete traversal, never as complete absence.

The budget is 50–2,000 tokens under the bundled packet tokenizer. `tokens` counts
the exact serialized `WorldSlice` body, including its own count. Packing also
reserves 200 tokens for the closed WorldView wrapper, capability and expiry;
public tests count the complete serialized WorldView result. Transport-specific
envelope metadata is outside this contract. Qualifiers and references are never
shortened to fit. If mandatory context cannot fit, the response is incomplete
with `required_context_overflow` and no view capability. When even that body
cannot fit, the response is `unavailable(budget)`. Optional detail can be omitted
with `truncated: true` while constraints remain complete.

A complete result can issue a view capability. Re-reading the identical request
with that capability reports unchanged only while its evidence and permissions
remain current. A wrong-principal, revoked, expired or erased capability requires
a new view. Historical slices are explicitly unavailable in this checkpoint.

## Session compilation and integration

This implementation covers SLICE-1 through SLICE-5 for the registered kinds
listed above. The context-packet v2 session sections use the same mandatory-first compiler and
card-to-relation providers. The existing source-bound owner identity selector
chooses a Person; it never substitutes every visible Person. Legacy owner facts
remain the model-free fallback. Current Situation cards supply now, commitments
and uncertainty, including all examined dependencies for final publication even
when completed commitments are omitted. Required context that cannot fit makes
the packet incomplete; optional detail yields first. The v1 packet retains its
existing compatibility renderer. Additional kind assemblers must declare their
constraint provider during composition.

The original design fixture's positive 80-token example is incompatible with
the full Relation and EvidenceRef codec. The public 80-token case therefore
proves honest budget refusal. A feasible-budget case proves retention of the
complete decisive constraint while optional prose is dropped. Meeting the
literal positive 80-token example would require an accepted compact wire codec;
discarding qualifiers or counting only prose would not meet it.

## Verification

`packages/core/test/world/slice.test.ts` exercises the public budget, mandatory
overflow, pending extraction, retained view, foreign principal, revocation and
history boundaries. The central verification matrix checks seven hidden-source
mutations and purge. `packages/cli/test/world-verification-parity.test.ts`
exercises Core, CLI text and JSON, actual stdio MCP, HTTP and the App host.
The App client test exercises the task form, retained refresh and privacy clear.
`packages/core/test/world/slice-session.test.ts` compares the exact qualified
constraint and evidence in the public slice and session packet, and verifies
pending extraction, mandatory overflow and source revocation. Existing Person
and Situation outcome tests exercise final-publication revocation races.
