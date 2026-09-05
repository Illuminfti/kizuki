---
name: Epistemic integrity
description: >-
  Use when code turns evidence into claims, confidence, perspectives, concepts,
  knowledge state, relationships, hypotheses, forecasts, summaries, or agent context.
---
# Epistemic integrity

Kizuki's hardest correctness problem is not syntax. It is preventing the system from becoming confidently wrong about the owner's world.

## The ladder

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

Higher rungs may depend on lower ones. They never silently inherit the authority of lower ones.

## Mandatory questions

For every knowledge-producing path ask:

- What exactly was observed?
- What was interpreted?
- Who asserted it?
- Which perspective does it belong to?
- What evidence supports it?
- Is that evidence independent?
- When was the assertion valid?
- How fresh is the source?
- What would invalidate it?
- What uncertainty remains?

## Confidence discipline

Do not manufacture precision. A decimal is not automatically more rigorous than a categorical state.

Confidence must not increase merely because:

- the same content was copied across channels;
- an LLM paraphrased it repeatedly;
- a generated dashboard cited another generated artifact;
- the owner discussed a topic many times;
- the parser produced more rows.

Prefer evidence classes, corroboration lineage, authority tiers, and explicit uncertainty over decorative scores.

## Perspective safety

Distinguish at minimum:

- directly observed event;
- owner-authored belief;
- another person's explicit statement;
- Kizuki inference;
- Kizuki inference about another person's belief.

Never emit “Alice believes X” when the evidence only supports “Kizuki infers Alice may believe X.”

## Absence safety

“No reply was observed” and “no reply exists” are different claims.

Before deriving absence, inspect source coverage, connector freshness, backfill limits, deletion semantics, and known gaps. If coverage is insufficient, preserve the unknown.

## Learning safety

Knowledge-state transitions require evidence appropriate to the transition:

- encountered: exposure evidence;
- understood: demonstrated explanation or equivalent evidence;
- applied: use in a real task;
- demonstrated: outcome-backed execution;

Reading, searching, or mentioning a concept must never leap directly to mastery.

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

For each generated statement, try to produce a counterexample where the same inputs would make the statement misleading. If you can, strengthen the type, evidence rule, or output language before shipping.