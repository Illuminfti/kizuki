# Core semantic qualification with quote-anchor custody

`core-semantic-v3` evaluates the actual production `prepareWorldDrafts` output
after the model-only quote-anchor wire has been resolved by the trusted host and
accepted by the unchanged public v2 response parser. It is a prospective method.
Prior splits, scripted answers, and every v2 campaign remain historical controls;
they cannot be rescored or approved as v3 evidence. A fresh sealed split and a
separate review of its actual responses are required. The corpus, contract,
method, prompt, adapter, parser, and runner files are frozen before any call.

## Complete authored representations (prospective, 2026-10-22)

Fresh `kizuki.core-semantic-contract/v2` positive cases contain one to three
complete `branches`, each with a unique bounded `id`, exact target,
classification, `label_rule`, required typed details and semantic atoms, source
witnesses, perspective, time and forbidden assertions. Each branch must preserve
the whole source-supported meaning being tested. Alternatives cannot offer
different convenient subsets of required domain facts. A combined objective and
blocker response needs its own complete authored branch; uncontracted typed
extras still fail. The unchanged legacy-extra policy and negative controls apply.

The existing closed scorer evaluates every branch independently. The first
wholly passing prepared branch in authored order is selected; no facts or gates
are joined across branches. If none passes, the case fails with no selection.
The raw diagnostic evaluates that same selected prepared branch, even when
another branch would make its raw citations look better. Branch diagnostics
retain the independent role, time, polarity and structure failures.

An explicit label has an exact source naming witness, including an unambiguous
heading where applicable. A descriptive Situation label uses the exact source
condition phrase and an explicit dated document-report label rule, matching the
details' report source and interval. It describes what the source reports; it
does not assert that the source formally named the condition. Every branch's
target, predicate and label still need independent source justification.
An objective expresses a stated requested action and enabling condition; a
blocker expresses a stated obstruction and its work relation. One predicate
cannot stand in for the other merely because its wording is convenient.

Case results, pending manual-review records and independent review cases bind
`selected_branch_id`, `selected_branch_sha256` and the entire `selected_branch`.
The hash covers canonical JSON of the complete authored branch, including its
id. The result and review identify `complete-authored-branches/v1`. The verifier
recomputes selection, branch contracts, all existing pipeline and custody gates,
and measured budgets. A failed or unselected positive case cannot generate a
passing review template.

Semantic atoms remain an independent review of each actual literal object,
including supported paraphrases. There is no exact-string whitelist, automatic
entailment grader, or repair from a body or neighboring claim. Missing literal
facts, unsupported naming, wrong source roles or time, and unsupported additions
fail that review. Prior v1-shaped rules remain historical scripted controls;
the failed Core14 report and frozen source remain unchanged and cannot be
rescored or accepted by this prospective method. A separately authored fresh
12-case split and new independent review are required before any real run.

## Input budget repair (2026-10-22)

The prospective runner now binds an explicit `input_policy` with total input and
output caps and a trusted `input_token_overhead` reservation. For an endpoint
that needs 24,000 tokens of framing, the prospective profile is total input
32,000, overhead 24,000 and output 8,192. This leaves at most 8,000 estimated
message tokens. It changes no global default and cannot repair an earlier run.

```bash
bun --no-env-file --config=/dev/null scripts/world-qualification/run.ts \
  --protocol core-semantic-v3 --kinds concept,situation \
  --max-input-tokens 32000 --input-token-overhead 24000 \
  --max-output-tokens 8192 --out /absolute/new-report.json
```

The runner configures the actual LLM port with that reserve, checks the factory's
trusted producer metadata, and checks each actual outgoing message estimate and
output cap before transport. Each case binds the actual production planner's
scrubbed outbound hash, estimated message tokens, overhead, reserved total and
caps into a canonical planning hash. The random fence nonce is excluded; its
fixed-length messages still contribute to the measured planning estimate. The
trace, wire evidence, prepared result and independent review all bind that same
commitment. Wire evidence also records the overhead read from the actual live
factory identity, including inherited wrappers; fabricated port properties and
different wrapper metadata cannot attest the run policy. The verifier
reconstructs the case budget and invokes the actual
planner with the report-bound reserve. Missing policy, stale runner hashes,
changed reserves or caps, altered commitments and planning overflow fail closed.

Measured input and output usage must each be within the declared cap, including
when the product rejects a response. Counts are retained exactly as reported;
the reservation is never subtracted from observed usage. Core12's earlier report
and review are preserved as **INVALID historical evidence**: all 12 measured
inputs exceeded their declared 8,192-token budget. Its active approval is
withdrawn. Core13 stopped after three over-budget calls and has no accepted
receipt. Neither campaign may be rescored, waived or assigned a larger cap.
A fresh sealed split, frozen runner, all 12 calls once and a new independent
review are required. Scripted controls remain pending manual review.
The runner stops after the first observed automated case failure, preserves the
attempt and reports `automated_failure`. An incomplete failed run never qualifies
and cannot be resumed or resampled as a successful campaign.

## Two distinct results

The translated model result keeps the existing typed, identity, role, time,
usage, and exact-anchor checks. The private wire changes only how model-authored
anchors cross the untrusted response boundary. The model supplies an event id,
an exact contextual quote, and an optional exact selection. The adapter resolves
that descriptor over the exact scrubbed outbound event text. Missing or
ambiguous text fails closed. It performs no normalization, fuzzy matching,
semantic repair, retry, or partial salvage. Supplied anchors remain host values.
The resulting `kizuki.producer-response/v2` passes through the original parser
and guards without weakening them.

Raw citation precision remains failed when a claim omits the reporting words
from its own citations. Host context never becomes model-authored evidence and
never relabels this diagnostic as passed.

The prepared result calls the production function with an immutable synthetic
fixture derived only from the exact case input. The host-attested window is the
full input event sent to the model. The runner also calls the same function
without windows to record the original guard outcome. Each case uses a fresh
in-memory ledger and the journal's actual registry check and in-order pending
classification callback; that initial empty context is bound in the fixture
manifest. The ledger is query-only after initialization and closed afterward.
Both calls must produce one admission per claim with zero drops. A guard
downgrade or any changed literal, role, time, body, confidence, authority, or
original anchor fails qualification. Only ordinary reference resolution and
appending the exact sent window to perspective anchors are permitted. Per-item
and aggregate caps remain enforced. The evaluator does not normalize context.

Reporting-role coverage uses the actual prepared admission's anchors. Coverage
is not a semantic entailment proof: independent review still checks that the
particular actor, role, proposition, and time are supported together. An
unrelated reporting verb elsewhere in the window cannot justify a claim.
Unsupported additions, wrong actor or role, literal/body conflicts, and
forbidden interpretations fail that review.

## Exact evidence binding

The v3 report keeps the canonical transport-response hash and separately hashes
the exact assistant text returned by the same accepted ChatCompletion decoder
used by the LLM port. For every case it also records a canonical
`kizuki.model-extraction-anchor-resolution/v1` receipt containing the private
wire schema, exact raw model-text hash, scrubbed outbound-input hash and event
text hashes, each descriptor-to-UTF-16 resolution in traversal order, and the
canonical translated-response hash. The case record binds that receipt hash to
the same transport trace and the exact adapter source hash. The receipt's raw
model-text hash must equal the trace's decoder-derived assistant-text hash. The
verifier independently recomputes the outbound, event, descriptor resolution,
receipt, adapter, and translated-response hashes. A missing, duplicate,
malformed, or mismatched link fails automated qualification.

The optional private raw-response archive retains the provider response body
before parsing. It is diagnostic evidence, not scorer input. Its transport hash
and the receipt's raw model-text hash let an authorized reviewer audit the exact
wire without placing raw response bytes in the public qualification report.

Each prepared case retains the input fixture manifest, sent-window manifest,
canonical actual admissions, and claim correspondence. The separate review uses
`kizuki.core-semantic-review/v3` at `prepared_admission` and binds the exact
report and Core source commit, corpus and contract, transport response, raw model
text and its independently captured trace hash, adapter and wire schemas, scrubbed outbound input, resolution receipt,
translated public response, fixture, sent windows, and admissions. It reviews
every required fact, role/time relationship, legacy extra, and forbidden
interpretation. The report remains `pending_manual_review`; only the v3 receipt
verifier with this exact independent artifact may accept it.

The runner fingerprint includes the adapter, prompt, public parser, production
preparation, guard, occurrence, semantic-contract, and extraction/window files.
Any change invalidates prior method evidence. No vocabulary, corpus answer, or
production grant change is part of this method.
