# Core semantic qualification with quote-anchor custody

`core-semantic-v3` evaluates the actual production `prepareWorldDrafts` output
after the model-only quote-anchor wire has been resolved by the trusted host and
accepted by the unchanged public v2 response parser. It is a prospective method.
Prior splits, scripted answers, and every v2 campaign remain historical controls;
they cannot be rescored or approved as v3 evidence. A fresh sealed split and a
separate review of its actual responses are required. The corpus, contract,
method, prompt, adapter, parser, and runner files are frozen before any call.

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
