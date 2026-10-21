# Outcome evidence

Implementation evidence date: 2026-10-21. Outcomes use the existing `propose`
claim arm and the existing claim writer. There is no execution receipt tool,
parallel outcome store, new migration or additional write path.

## Filing and reading

Use `kind: "claim"`, an authorized subject, readable provenance events and one
of these registered predicates:

| Predicate | Card stage | Allowed result |
| --- | --- | --- |
| `outcome.self_report` | `agent_reported` | `met`, `not_met`, `inconclusive` |
| `outcome.provider_ack` | `provider_acknowledged` | `acknowledged` |
| `outcome.observation` | `observed` | `met`, `not_met`, `inconclusive` |
| `outcome.review` | `reviewed` | `accepted`, `rejected`, `pending` |

The claim `object` is a JSON string with exactly these fields:

```json
{
  "subjectRef": "CURRENT_CALLER_OBJECT_TOKEN_OR_none",
  "task": "inspect",
  "attempt": "attempt-1",
  "criterion": "all required fields present",
  "artifactVersion": "artifact-1",
  "environment": "inspection-v1",
  "result": "met",
  "assistance": "assisted",
  "confounded": false
}
```

`subjectRef` must be the caller's current opaque object token for the claim's
subject, or the literal `none` when no knowledge object is being evaluated.
A retained token is lookup identity only: the referenced object must still have
currently readable evidence. This check repeats inside the claim transaction
after asynchronous preparation; source or principal revocation cannot authorize
a new bound report. Scoped proposals bind the complete source-qualified identity,
including when `subject` defaults to the first `subjects` entry; an equal raw ID
from another source is a different subject. For an exactly bound outcome,
independent provenance need not itself mention the evaluated object. Each event
must still pass the caller's current grants, consent and any preexisting evidence
selection. Unbound outcomes and ordinary proposals retain subject occurrence
selection. All checks repeat at the mutation boundary.
Other identifier fields are nonempty and at most 128 characters; the entire
JSON string is at most 1,024 characters. `assistance` is `assisted`, `unassisted`
or `unknown`. Invalid inputs, missing provenance, missing propose grants and
out-of-scope subjects are refused before claim insertion and audited.
The stored subject binding is stable across callers; the reader exposes only
`bound` or `none`, never its internal binding digest or another caller's token.

Read `world_view` with `operation: "outcome"`, the legacy `subject`,
`valid: {"kind":"all"}` and `knownAt: {"kind":"current"}`.
CLI uses `kizuki world --operation outcome --subject SUBJECT`; all adapters dispatch to Core.
`kizuki.outcome-card/v1` keeps stages and their quoted evidence separate from
derived evaluations. Legacy `outcome.reached` and `outcome.missed` are readable
as self-reports with unknown evaluations.

## Evaluation rules

A report and its observation/review must agree on subject binding, task,
attempt, criterion, artifact version, environment and assistance conditions.
Independent support requires different producer principals and different
provenance sources from every reporter in that evaluation. Self-originated,
forwarded, copied or unrooted evidence is not independent. Identical evidence
text from another source also cannot manufacture independence.

The latest independent observed `met` and latest accepted independent review establish that evaluation's
goal only without negative or confounded evidence. A `not_met` observation and
rejected review establish failure. Other combinations remain unknown. Reports
and acknowledgements alone never establish success. Matching report claims
form one logical evaluation, and exact propose replay is idempotent. A later
artifact version cannot rewrite an earlier failed inspection. Overall
`goalAchieved` requires every included evaluation to be met.

Matched outcomes can change procedure task usefulness; they never increase
truth confidence, override owner corrections or infer general mastery.
Confounded evaluations remain visible with unknown results. The reader is
bounded to 128 authorized claims and reports partial coverage if truncated;
truncation cannot establish goal achievement. No read grants execution authority.

## Recovery and verification

Outcome projections are computed from existing claims and event lineage.
Source revocation and purge remove their contribution on the next read and
invalidate retained procedure baselines. Full purge uses the existing erased
claim tombstone shape so export/restore cannot resurrect removed evidence.
Rebuilding world projections reproduces the same attributable outcome state.

The `skills` test files under Core, CLI and MCP cover the public write seam,
independence, matching, counterexamples, assisted mastery, idempotence, denial
before mutation, audit, source revocation, full purge/export/restore, rebuilding
and consumer parity. Tool-list tests retain ten tools and only the existing
`propose` and `correct` write tools. These are synthetic acceptance checks;
held-out producer evaluation and deployment remain separate gates.

## Contract refinement

This reader uses bounded structured JSON in the existing string-valued claim
object so task, attempt, criterion, artifact and environment pins cannot be
conflated. The card returns stages as individually typed rows and explicit
matched evaluations, addressed by an authorized subject. This refines Appendix
B's illustrative stage buckets and claim-reference addressing. Malformed new
inputs are rejected instead of being silently treated as successful evidence;
legacy reached/missed strings remain self-reports. There is no retained outcome
history, so historical requests are explicitly unavailable.

## ArtifactVersion bindings

`artifactVersion` may be a legacy bounded string or an explicit current caller
ObjectRef (`{"kind":"object","token":"..."}`). Only the ObjectRef form can
bind a linked ArtifactVersion. Core validates the current classified artifact
under the caller's source policy, and repeats that check in the claim insertion
transaction after asynchronous preparation. It stores a private tagged digest of
the complete source-qualified identity, never the caller token. The submission
parser refuses internal binding tags. Equal bytes from a different source and
a different version of the same source do not match.

A consumer evaluating a node deliverable must project that exact ArtifactVersion
through its shared read frame and supply `outcomeArtifactBinding(rawSubject)` to
`readOutcomes`. That retains the artifact's full publication dependencies. The
ordinary standalone Outcome view quotes a bound report as `artifactVersion:
"bound"` and leaves its completion unknown without that qualified context. Legacy
strings remain useful quoted conditions but never authenticate a linked artifact.
