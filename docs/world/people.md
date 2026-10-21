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
