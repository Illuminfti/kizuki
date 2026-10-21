# Situation cards v2

Implementation evidence date: 2026-10-21. Situation v2 is additive. Existing
`world_view` callers receive `kizuki.situation-card/v1` unless they explicitly
supply `card: "kizuki.situation-card/v2"` to the `situation` operation. Core,
HTTP, MCP, CLI and App dispatch to the same reader. The CLI selector is
`kizuki world --operation situation --situation TOKEN --card kizuki.situation-card/v2`.

## Commitments, decisions and dependencies

V2 returns primitive Commitment and Decision object references. Commitment
entries retain their own label, debtor, creditor, due relations, deliverable
relations, status, status basis and overdue result. Debtors and creditors must
resolve to structured Person identities. Dates are exact RFC 3339 instants or
real calendar dates; vague time phrases are refused. Different holders keep
separate due relations, and correcting one commitment cannot rewrite another.
Legacy literal `situation.commitment` assertions remain in `statedCommitments`.

An asserted decision status is `open`, `decided` or `reversed`. A correction to
`suggested` or another non-asserted mode moves the statement into uncertainty;
receipt undo restores the prior decision. `requires`, `enables`, `blocks` and
`invalidated_by` retain their supporting relations. Dependency cycle checks use
only currently eligible evidence within the same perspective, context and
overlapping valid interval. Hidden intermediate nodes cannot affect a scoped
writer's cycle decision. Traversal is bounded and incomplete reads report a gap.

`overdue` is unknown for missing or conflicting dates, incomplete source
coverage or incomplete traversal. A single exact instant can be compared with
the selected evaluation instant; a date alone becomes overdue only on a later
UTC calendar date. Optional outer summary work does not make an otherwise
fully supported deadline unknown. Source extraction backlog still does.

## Completion and attribution

An ordinary asserted, reported or quoted `commitment/done` is `claimed_done`.
A retained native owner assertion can establish done. Independent completion
uses the existing [Outcome reader](outcomes.md), with the exact commitment
subject binding and every stated literal deliverable criterion. Each criterion
requires matching independent observation and review under the Outcome rules;
self-reports and provider acknowledgements alone cannot establish completion.
A later native owner correction reopening or dropping the commitment wins over
earlier outcome evidence. Receipts and outcome evidence remain publication
dependencies, including when completed commitments are omitted from a packet.

Outcome evidence is currently recorded as legacy claims without retained
recorded-time history. Historical `knownAt` and arbitrary valid-time reads
therefore never borrow present outcome evidence: they retain claimed completion
and expose a coverage gap. Session evaluation captures its actual current
instant internally and uses the same collector as current cards. Callers cannot
supply an old session time to borrow current completion.

For node deliverables, each node must first project as a currently readable
[ArtifactVersion](artifacts.md). Outcomes must have been filed with that exact
artifact's caller-scoped ObjectRef; Core stores the namespace-qualified binding.
Matching digests or legacy strings are not authenticated bindings. Every linked
artifact requires independently met evidence for every explicit literal
criterion. A node without a stated criterion remains incomplete. Equal bytes
from different sources and different versions of one source are distinct.
Artifact authority is retained in the same final publication closure; revocation
or purge prevents the old bound outcome from establishing completion.

## Privacy, history and summaries

All nested records pass the existing current source, principal, sensitivity,
hold and provenance checks. Known-at reads use retained claim lifecycle and
support positions while still enforcing current authority. Purge invalidates
retained views and cannot be reversed by rebuilding derived projections.
Every evidence closure used by a card, including completion evidence omitted
from its text, is checked at final publication.

The outer Situation summary uses only the assertions in its exact consolidation
basis. Linked commitments and decisions are separate deterministic projections;
their dates and statuses are not silently added to the summary prompt. Their
ordinary card dependencies still invalidate stale output. Primitive entries do
not require their own model summary.

## Verification and remaining qualification

The Situation test files exercise independent dates and attribution, strict
endpoints, owner correction and undo, overlapping cycles, scoped hidden paths,
current and retained-time reads, purge/rebuild/revocation, completion evidence,
packet publication races and actual Core/CLI/MCP/HTTP/App parity. The v1 read
remains the default and its contract is unchanged.

Commitment and Decision producer flags remain disabled until the separate
held-out kind qualification gate passes. Synthetic acceptance and type/policy
checks do not establish real model extraction quality or deployment status.
