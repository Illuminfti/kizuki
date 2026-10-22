# Core semantic qualification contract draft

This predeclared split evaluates only Concept and Situation extraction. It does not change the ordinary qualification scorer, producer prompt, registry, or approvals.

The automated gate checks transport evidence, the public response parser, zero drops, measured use, exact case coverage, abstention, contracted typed predicates, one coherent typed target, grounded source spans, attribution roles, and explicit time. Open text is not compared by whole-literal equality.

The production prompt also offers the ordinary legacy predicate registry. A positive case may therefore contain additional parser-accepted legacy claims when the source actually supports them; `world.kind` and offered typed predicates are never treated as extras, and `identity.same_as` and `project.owns` are forbidden for this corpus. Every extra remains pending until the independent reviewer separately checks its literal, body, references, anchors, role, time, and source entailment against its exact claim hash. Unsupported ownership, authority, identity merge, or any other addition fails. Negative cases still require exactly zero claims.

Every extracting case remains `pending_manual_review` until an independent reviewer, working from the sealed source and exact response bytes, records whether the claim literal alone entails every required meaning atom. The body is reviewed separately for a faithful rendering and for unsupported additions or forbidden assertions; it cannot repair a lossy literal. A missing, partial, mismatched, or non-independent review cannot pass.

Attribution rules are source-specific:

- A direct record uses asserted mode with null holder, speaker, and addressee.
- A person's statement requires the grounded person as speaker. Its holder may be null or that same grounded person when the statement supports either claim-role rendering; no duplicate role is required. A direct quotation may be `quoted`; a paraphrased report may be `reported`. No unrelated or ungrounded holder is allowed.
- A document report requires the grounded document as holder. A speaker or addressee is present only when separately grounded; these cases provide neither, so both are null and the mode is `reported`.

Classification, label, and each substantive detail are assessed as separate propositions. All extracting cases establish kind and name as asserted structural propositions with null holder, speaker, and addressee. The two person-report cases establish kind and name directly in a record header, while only their substantive details carry speaker attribution. The historical documents explicitly establish bounded kind, name, and details; kind and label remain asserted while carrying that exact interval. No case permits a kind, label, role, or validity interval inferred from a bare name, template, hypothetical, current-day assumption, or observed output.

Historical intervals use RFC3339 instants and an exclusive `valid_to`, matching the producer contract. The historical source records state those exact instants and the exclusive boundary; the oracle does not convert ambiguous date-only prose.

No case supplies a target handle. Every extracting case requires one response mention at the exact predeclared source label span, and all classification, label, and detail claims must use that same mention ref. The reported Situation also supplies no speaker handle and requires a separate exact mention over the unique `Dalen` name span; the distinct `Dalen reported` witness establishes the speaker role. Its target and speaker mentions cannot be conflated. Other person and document handles exist only to ground source attribution. Negative cases receive no target handle and still require zero claims.
