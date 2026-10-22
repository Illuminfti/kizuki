# Fresh core extraction qualification split

Authored independently on 2026-10-22 from synthetic text, before observing any model response. No producer prompt implementation, old qualification case content, private source, runtime vault, credential, or provider response was inspected. Governing repository instructions, public producer types, current Concept/Situation vocabulary declarations, and `scripts/world-qualification/score.ts` supplied only the contract. The author received the `PROMPT_FROZEN` signal before sealing these files. This is qualification input, not a passing qualification result.

## Coverage and rationale

There are exactly 12 cases: six Concept and six Situation. Each kind has one explanatory/operational positive, one named-source reported positive, one bounded historical positive, and three abstentions (bare names, blank template, hypothetical-only). Two positive cases mix useful evidence with instructions that attempt to invent owner activity or completion. The domains are ecology, ceramics, music rehearsal, library catalogues, tram operations and museum digitisation. Source formats vary among a guide excerpt, workshop minutes, an archive note, an operations worksheet, a meeting summary and a historical log.

Every positive requires a classification, its exact source-grounded label, and all declared substantive details on one consistent raw subject representation. Situation cases require both substantive predicates, not just one convenient detail. Reported cases require holder and speaker attribution; historical details require exact supported validity endpoints. The source identities are not the vault owner. Every negative requires zero claims; no owner/current/completed interpretation is supported. A rejection, unavailable result, parser drop or post-parse drop never passes as abstention.

`corpus.json` is an existing `QualificationCorpus` v2 shape, with finite independently authored literal alternatives. It does not modify historical corpora. `semantic-oracle.json` supplements it with exact UTF-16 witnesses, substance atoms, attribution witnesses, temporal witnesses and forbidden interpretations. The supplemental rules are cumulative with the existing scorer. They never turn a failed semantic tuple into a pass.

## Existing scorer gaps

1. `responseMeanings` reduces support and perspective anchors to record IDs. It therefore cannot distinguish a real explanatory witness from a same-record heading, instruction, placeholder or unrelated sentence. Parser validation checks span shape, not semantic support. Fixed witness coverage must be checked separately.
2. Literal equality is not semantic equivalence. The frozen finite alternatives protect against post-output oracle fitting, but valid unlisted paraphrases will fail. Keep that failure visible as an exact-oracle limitation; do not append observed wording to make a run pass. A future paraphrase-aware checker needs an independently approved contract and a new evaluation, not output-driven oracle repair.
3. `Meaning` omits `body`, confidence and sensitivity. A response could pass the tuple scorer while its body invents owner activity, current relevance or completion. Human body review remains a declared independent gate here. Parser-valid bodies alone are insufficient. No automatic passing report should claim this gate was checked unless its evidence is retained.
4. `validateCorpus` does not validate every oracle predicate/object/perspective against the full registry, nor prove every oracle mention/reference is the intended substring. The supplied author validation checks source-span round trips and totals. Before running a model, validate all prepared inputs and any exact expected-response exemplars through the public parser.
5. The scorer validates usage, response shape, exact claims, unsupported claims, duplicate meanings and zero drops well; preserve those checks. Its reference alternatives already reject classification/detail identity splits. Neither empty negatives nor label-only positives should be substituted for these stronger requirements.

## Precise integration proposal

Prepare a new isolated `scripts/world-qualification/corpus-fresh-core-20261022.json`, matching module and freeze manifest from these sealed bytes, and a matching semantic oracle. Keep v1/v2/v3 bytes and historical qualification reports unchanged. Keep the wider nine-kind corpus and its activation decision separate. Do not select the new split in production now.

Before any provider call, independently review and freeze a small deterministic supplemental checker with these operations:

1. Verify the file byte hashes and the canonical corpus hash against the freeze manifest; validate `QualificationCorpus`; check all 12 inputs use only the currently offered Concept/Situation vocabulary. No corpus expectations are included in model input.
2. Run the ordinary `scoreCase` against each observation, without changing its required/optional semantics. Require all cases and both kinds to pass, zero drops, exactly one measured call, and the existing usage budget limits.
3. Resolve every raw response subject through the declared bounded reference alternatives. Require one raw representation per target. Match each required detail to its predicate, exact frozen literal alternative, perspective tuple and validity interval. Assert all predeclared substance atom groups in that detail literal.
4. Map response anchors back to source records. Require an anchor to cover the exact frozen label/detail witness and, for reported details, a perspective anchor to cover the attribution witness. Require historical details to cover both substantive witness and time-interval witness, possibly using two anchors. A label span alone cannot support a detail.
5. Enforce zero claims for each abstention. Retain the original source and response bytes plus hashes. Produce separate tuple, anchor, substance, attribution, time, body-review and usage results; a gate not run is not a pass.
6. Have an independent reviewer apply the frozen forbidden-interpretation/body rubric to the exact run, without inspecting or editing the producer prompt or changing oracle strings. A supported equivalent paraphrase outside the finite corpus alternatives must be reported as a scorer limitation, not silently waived.
7. Only after an approved report passes every declared gate should a separate authorized change atomically point `corpus.ts` and the current qualification reference at this split/report. That selection change is distinct from publication or installed-service cutover. Preserve the sealed fresh split if the prompt later changes; never tune it to an observed response.

No checker implementation, repository source edit, model call, external submission, publication, activation or service action was performed in this lane.

## Verification

See `validation.json` for local preflight. Hashes in `freeze.json` cover both the exact JSON bytes and sorted-key compact JSON representations. SHA-256 proves byte integrity, not model quality, useful card rendering, production behavior or leakage absence. The split becomes seen material after its first model run; retain that fact in the run receipt.
