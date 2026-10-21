# People and attributed perspectives

`person` and `find_people` read admitted Person claims through Core, CLI, MCP,
loopback HTTP and the App host. A Person requires a structured subject supplied
by its source. A name found in prose cannot establish that identity, and matching
labels never merge two people.

```bash
kizuki world --operation find_people --label Ada --json
kizuki world --operation person --ref PERSON_TOKEN
```

## Attribution and time

Person cards retain roles, relationships and statements grouped by holder,
speaker and mode. If Ada reports Friday and Ben reports Thursday, the statements
remain separate and `agreedDeadline` is null. Context links and every attributed
endpoint must be visible under the current reader grant before selection or
rendering. Restricted connected people do not change visible results or charged
read work.

Relationships retain valid-time bounds. Recorded knowledge is independently
selected by `knownAt`; retained snapshots cannot bypass current consent, holds,
erasure or missing historical coverage. Conditional views and share/resume use
the common card pipeline. A portable reference conveys no authority.

An owner can correct their unattributed belief through the existing correction
operation. This does not rewrite another speaker's quotation or erase the old
statement from an authorized historical snapshot.

## Interest hypotheses

The typed `person.interest` relation links a structured Person to a Concept.
It is served in the existing perspective groups with its source evidence,
context, polarity and valid-time qualifiers. An unknown valid time stays
unknown; the captured event's time is not invented as the start of a lasting
interest. The relation establishes neither competence nor a personality trait.

Source-derived interest is always an inferred, uncertain hypothesis, including
when a model proposes a confident reading of a question, visit or selection.
The draft adapter applies this qualification and the shared writer enforces it.
Reads exclude older source admissions that lack it. Replayed evidence creates
no new support; copied evidence retains the existing dependence assessment and
does not increase authority or promote an interest into a fact.

The owner can retract an interpretation through the existing world-claim
correction. The successor preserves the domain link and records explicit owner
evidence; it supersedes the old hypothesis. Receipted undo restores the previous
qualifications. Current consent, purge and grants over both person and domain
apply to the relation and its evidence. No interest enables sources, network
access, model spending or another learning loop.

This is the evidence and consumer path for interest hypotheses. It does not
enable Person extraction, aggregate an interest-depth score, infer a preference,
or implement the per-domain taste and conditional collaboration checklist.

## Session use and population

The session owner section prefers a Person card only when an existing readable
owner identity fact carries source evidence binding its exact supplied subject
and namespace. Ambiguous or missing bindings retain the existing identity-fact
fallback. Person text remains quoted data. Selected card dependencies are checked
again in the existing packet publication transaction, so retirement or revocation
between collection and publication cannot release stale text.

Person vocabulary is registered with `offeredToProducer: false`. VERIFY V6 must
qualify held-out extraction before model population is enabled. These synthetic
consumer checks do not establish extraction quality on private production data.

## Verification

The public acceptance cases are `packages/core/test/world/people*.test.ts`,
`packages/core/test/serving/people-session.test.ts`,
`packages/cli/test/people.test.ts` and `packages/mcp/test/people.test.ts`. They
exercise actual claim admission, correction, source revocation, purge, recorded
snapshots, packet publication races and all consumer routes. No production grants
are changed by these tests.

`packages/core/test/world/person-interest.test.ts` exercises synthetic extraction
through the shared admission writer into the public Person and evidence reads,
replay/copy dependence, writer refusal, correction/undo, source loss and hidden
domain noninterference. These are synthetic model-adapter checks, not live model
qualification or production interest-detection accuracy.
