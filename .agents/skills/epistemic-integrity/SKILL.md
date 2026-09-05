---
name: epistemic-integrity
description: >-
  Use when code turns evidence into claims, confidence, perspectives, concepts,
  hypotheses, forecasts, summaries, or agent context.
---

# Epistemic integrity

Kizuki's hardest correctness problem is preventing the system from becoming
confidently wrong about the owner's world.

## Evidence taxonomy

Keep these types distinct in code, storage, output, and tests:

```text
source evidence
→ observation
→ claim
→ inference
→ hypothesis
→ prediction/recommendation
→ decision/outcome
```

Later statements may depend on earlier evidence, but never silently inherit
its authority.

## Mandatory questions

For every knowledge-producing path ask:

- What exactly was observed and what was interpreted?
- Who asserted it, from which perspective, and when was it valid?
- Which evidence supports it, and is that evidence independent?
- How fresh is the source, what would invalidate it, and what uncertainty
  remains?

## Confidence, perspective, and absence

Do not manufacture precision. Confidence does not increase because the same
content is copied, paraphrased by a model, cited by another generated artifact,
or represented by more parser rows. Prefer evidence classes, corroboration
lineage, authority tiers, and explicit uncertainty.

Distinguish directly observed events, owner-authored beliefs, another person's
explicit statement, Kizuki inference, and Kizuki inference about another
person's belief. Never state a person's belief as fact when the evidence only
supports an inference.

"No reply was observed" and "no reply exists" are different claims. Before
deriving absence, inspect source coverage, freshness, backfill limits, deletion
semantics, and known gaps. Preserve unknown when coverage is insufficient.

## Personal learning evidence

Reading, searching, or mentioning a concept is exposure; it is not mastery.
Do not model personal learning as a compulsory ordinal progression. Record the
independent, contextual evidence that exists, such as familiarity or exposure,
an explanation, a connection to another idea, application, a demonstrated
outcome, recency, source, context, and uncertainty. One facet does not imply
another or establish a global rank.

## Outcome safety

Separate:

```text
agent intended action
agent attempted action
provider acknowledged action
result observed
success condition satisfied
```

Never let an execution claim self-certify the desired outcome.

## Review test

For each generated statement, construct a counterexample where the same inputs
would make it misleading. Strengthen the type, evidence rule, or output
language when one exists.
