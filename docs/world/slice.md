# Bounded task views

The `slice` operation collects authorized Concept, Situation, Question, Person, Skill, Framework and Procedure
cards through the existing projection pipeline. Each kind's assembler declares
which whole relations are constraints. Negative, conflicting, attributed or
inferred statements retain their qualifications. Constraints precede optional
detail in deterministic kind, task-relevance and claim-reference order.

The task is a lexical selection hint. Before the four-card limit and token
packing, the reader scores each authorized discovery candidate by the number of
distinct task words in its permitted labels. Matching ignores case, Unicode
compatibility forms, punctuation and common connecting words; it does not infer
synonyms, applicability, identity or relationships. Repeated task words and
duplicate labels do not boost a score. Matching candidates precede packing;
ties use object-reference order. If no label in a requested kind matches, or the
task is empty, that kind keeps the bounded reference-order fallback. This is
deterministic label relevance, not the conditional collaboration compiler on the
v2 roadmap.

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
partial. Each request shares the existing 2 MiB projection budget. Relevance
examines one authorized discovery page per kind, at most 32 candidates within
the existing 4,096-handle scan ceiling, then reads at most four selected cards.
A further discovery page or more than four selected matches is reported as
incomplete traversal, never as complete absence. Nonmatching labels are excluded
only when a matching candidate exists. Every examined authorized label and
classification remains a dependency of the retained view, including candidates
not selected. Hidden or redacted label text cannot influence selection.

Discovery, cards and composed reads share a request allowance of 128 candidate
verifications plus one overflow sentinel. If it is exhausted, the unfinished
card is withheld whole and coverage reports incomplete traversal. Qualifiers
are never shortened.

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
remain the model-free fallback. Current Situation relations supply now,
commitments and uncertainty, including all examined dependencies for final
publication even when completed commitments are omitted. This internal session
projection does not request card summaries; unfinished summary consolidation
therefore does not block recorded relations. Visible extraction backlog still
makes the session incomplete, and full public cards retain their consolidation
coverage.

Required context that cannot fit makes the packet incomplete; optional detail
yields first. A session may keep a prefix of whole qualified relations that fit,
with an in-budget warning that missing context must not be treated as absent.
Card-level uncertainty remains required even when an individual relation is
asserted. Within required context, the session query ranks whole authorized,
redacted relation values with deterministic ties. Residual space may hold whole
optional detail after the required prefix is fixed.
The public task slice still withholds every mandatory relation on overflow.
If typed projection fails, independently authorized capture and canon can still
be served, with session sections marked unavailable. The v1 packet retains its
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
history boundaries. `packages/core/test/world/slice-relevance.test.ts` proves
selection of a relevant fifth card, different task selections under the same
grant, bounded fallback, incomplete discovery, unselected-support invalidation,
redacted-label exclusion, and unchanged bytes, work counters and retained baselines for seven hidden-source
mutations. The central verification matrix checks seven hidden-source
mutations and purge. `packages/cli/test/world-verification-parity.test.ts`
exercises Core, CLI text and JSON, actual stdio MCP, HTTP and the App host.
The App client test exercises the task form, retained refresh and privacy clear.
`packages/core/test/world/slice-session.test.ts` compares the exact qualified
constraint and evidence in the public slice and session packet, and verifies
pending extraction, mandatory overflow and source revocation. Existing Person
and Situation outcome tests exercise final-publication revocation races.

## Recall compilation

Default `context_packet` recall now consumes the same whole Concept and Situation
relations before canon excerpts and source capture. It projects recorded meaning
valid at the current instant without requiring a generated summary. Label words
select matching cards before the four-card limit; a nonmatching nonempty query
adds no typed cards. Request subjects narrow discovery before its scan and card
limits. Existing principal, source-purpose, sensitivity and evidence checks still
apply; scoped clients also need `world_view`. An explicit `include` keeps exactly
its requested legacy sections. An explicit `since` or `until` also keeps the
existing windowed canon/capture behavior; current typed relations are added only
for the implicit current recall window.

Each served atom retains its perspective, polarity, valid time, context and full
evidence references. Required atoms precede optional detail. When all required
atoms cannot fit, recall keeps a whole prefix and reports
`required_context_overflow`; it never clips qualifications to make a fact fit.
The existing 2 MiB, 129-verification and 2,000-token ceilings remain. Complete
publication dependencies include authorized discovery candidates and omitted
relations. Revocation between projection and publication refuses the response.

This fixes current meaning being lost beyond a 600-character canon excerpt.
It does not restore withdrawn source labels or make a source-only query discover
an independently worded native correction. Captured history keeps its own time
window and quoted status.

Verification:

```sh
bun test packages/core/test/world/slice-recall.test.ts scripts/eval/fresh-agent/baselines.test.ts scripts/eval/fresh-agent/read-state.test.ts
```
