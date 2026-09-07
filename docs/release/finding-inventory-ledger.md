# Finding inventory ledger

Evidence date: 7 September 2026. Parent: #403. Issue: #538. This documents the
`candidate.current-p0-disposition` obligation only. It does not implement a
producer, change `scripts/go-no-go.ts`, or claim that readiness is met.

Read [release acceptance](../release-acceptance.md) for the full gate inventory.
[D19](../decision-log.md#owner-amendment-to-readiness-2026-09-05) requires zero
live P0 findings on the exact candidate. The checker currently leaves
`candidate.current-p0-disposition` at `UNVERIFIABLE` with reason
`trusted-snapshot-and-freshness-policy-unavailable`.

## Gate obligation

| Field           | Value                                |
| --------------- | ------------------------------------ |
| Gate id         | `candidate.current-p0-disposition`   |
| Scope           | `current-head-findings`              |
| Required        | yes for both `rc` and `1.0` profiles |
| Current adapter | none                                 |

A passing disposition requires a complete current-head findings inventory and an
explicit freshness policy bound to the same candidate SHA recorded in the
evidence index. Handwritten flags, green reruns, or stale snapshots cannot supply
credit.

## Ledger completion checklist

A checkbox means the retained ledger, its freshness policy, and the exact-head
review all agree for the candidate under test.

- [ ] Bind `candidate_source_sha` to the reviewed Git head (lowercase 40-character SHA).
- [ ] Record `captured_at` as an ISO-8601 UTC timestamp for when the inventory snapshot was taken.
- [ ] Record `freshness_policy` with an explicit maximum age and the authoritative source used (for example live issue state at capture time).
- [ ] List every open P0 finding that applies to the candidate, each with a stable `finding_id`, `issue_number` or audit id, `title`, `state`, and `severity:p0` (or equivalent binding label).
- [ ] Record explicit disposition for each listed finding: `open`, `closed`, `not-applicable`, or `deferred-with-authority`, with a one-line reason and evidence pointer when not `open`.
- [ ] Assert `live_p0_count` is zero before release credit; any positive count fails the gate.
- [ ] Retain failed or superseded attempts with the candidate; a later attempt does not erase earlier inventory rows.
- [ ] Keep paths absolute, normalized, and under the local operator's exclusive custody when referenced from an evidence index.
- [ ] Copy no private text, credentials, or machine-specific paths into the ledger; use issue numbers, digests, and bounded references only.

## Freshness policy checklist

- [ ] State the maximum permitted age between inventory capture and acceptance evaluation.
- [ ] State what event invalidates the inventory (new P0 opened, candidate head move, policy change, or reopened issue).
- [ ] Refuse credit when capture predates the candidate SHA or postdates a known head move.
- [ ] Refuse credit when the authoritative source was unavailable at capture time; record the failure instead of an empty pass.

## Done / boundaries

All checklist rows pass for the exact candidate head under review. This ledger
is evidence for one gate only; it does not satisfy independent review, CI
identity, connector qualification, journey, or unfamiliar-user gates. An offline
inventory cannot discover a P0 opened after its capture timestamp. Operational
cutover remains a separate authorized decision.
