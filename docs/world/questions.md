# Questions and the knowledge frontier

Questions are typed claims, with attributed candidate answers, status statements,
motivations and gaps. Read a question with `world_view` operation `question` and
an issued object reference. `find_questions` accepts an optional label, `about`
object reference and cursor. The `about` relation is checked under the reader's
current grant before the discovery page limit is applied.

```bash
kizuki world --operation find_questions --about OBJECT_TOKEN --json
kizuki world --operation question --ref QUESTION_TOKEN
kizuki world --operation frontier --about OBJECT_TOKEN --json
```

The same operations are available through MCP, loopback HTTP and the App host.
Question cards support valid-time and retained known-at reads, conditional views,
and portable share/resume handles. A portable handle conveys no authority.

## Lifecycle and evidence

Lifecycle is derived at read time from admitted claims. An owner can replace a
`question.status` object through the existing `correct` operation with one of
`question/open`, `question/partial`, `question/resolved`, `question/reopened` or
`question/abandoned`. A live contradictory answer reopens a resolved question;
an abandoned question stays abandoned while that owner statement remains active.
Candidate answers and status grounds retain their claim and evidence references.

Copied answers do not add independent support roots. A resolved question does
not establish that the owner understands the answer: `understanding` remains
`unknown`. Mention frequency supplies no importance or curiosity score.

`frontier` groups current questions by gap kind, including unresolved questions
and contradictions. It reports source coverage and traversal gaps. Its coverage
stays partial while question extraction is disabled. Explicit gap assertions
remain attributable claims; resolution or abandonment alone does not retract an
independent gap assertion.

## Population and verification

This implementation registers the Question vocabulary with extraction disabled.
The held-out extraction gate must qualify the kind before it is offered to the
model. Seeded consumer proofs do not establish production extraction quality.
Concept and Situation card schemas remain unchanged.

The executable acceptance cases are in `packages/core/test/world/questions*`,
`packages/mcp/test/questions.test.ts` and `packages/cli/test/questions.test.ts`.
They use the real claim writer, owner correction and consumer routes to check
copy lineage, reopening, historical snapshots, closed payloads, current consent,
purge, scoped noninterference, evidence expansion and portable handles. Tests
run on synthetic data and do not change production grants.
