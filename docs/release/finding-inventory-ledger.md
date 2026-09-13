# Finding inventory ledger

Evidence date: 7 September 2026. Parent: #403. Issue: #538. This documents the
`candidate.current-p0-disposition` obligation only. It does not implement a
producer, change `scripts/go-no-go.ts`, or claim that readiness is met.

Read [release acceptance](../release-acceptance.md) for the full gate inventory.
[D19](../decision-log.md#owner-amendment-to-readiness-2026-09-05) requires zero
live P0 findings on the exact candidate. The checker currently leaves
`candidate.current-p0-disposition` at `UNVERIFIABLE` with reason
`trusted-snapshot-and-freshness-policy-unavailable`. Offline evaluation cannot
credit a saved GitHub observation or a `kizuki.p0-disposition/v1` receipt.

## Gate obligation

| Field           | Value                                |
| --------------- | ------------------------------------ |
| Gate id         | `candidate.current-p0-disposition`   |
| Scope           | `current-head-findings`              |
| Required        | yes for both `rc` and `1.0` profiles |
| Current adapter | online GitHub overlay only; offline default remains `UNVERIFIABLE` |

## Online collector

`evaluateReleaseOnline` in `scripts/github-release-evidence.ts` overlays this
gate from a live GitHub inventory. That overlay is not an offline producer.

- Exact open-issue label: `severity:p0`. Titles, bodies, authors and comments
  are not fetched for retention; kept rows are `{ id, number, updated_at, labels }`.
- Local `candidate_source_sha` must have GitHub `main` as a stable ancestor.
  The candidate may be an unmerged descendant pull-request head.
- Two complete array-paginated inventories must match, including `updated_at`
  and labels. Pagination is `per_page=25` with a hard page cap.
- Freshness is code-owned: 60 seconds maximum observation window and 5 seconds
  future-completion skew. An evidence index or receipt cannot supply a duration
  or timestamp.
- Empty valid inventory: `PASS` / `github-current-p0-inventory-clear`.
- One or more valid open rows: `FAIL` / `github-current-p0-findings-open`.
- Transport, schema, pagination, ref, freshness, custody or race failure:
  `UNVERIFIABLE` with a `github-p0-*` reason and no evidence digest.

This ledger remains reader guidance. It is not an input to `evaluateRelease`.

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
- [ ] List every open P0 finding that applies to the candidate, each with a stable `finding_id`, `issue_number` or audit id, `title`, GitHub `issue_state`, and `severity:p0` (or equivalent binding label).
- [ ] Record GitHub issue state separately from candidate verification. `issue_state` is `open` or `closed`. Candidate `disposition` is `open`, `unresolved`, `verified-fixed`, `not-applicable`, or `deferred-with-authority`.
- [ ] A closed GitHub issue without candidate-bound fix proof remains `unresolved`. It is never `verified-fixed`.
- [ ] `verified-fixed` requires the fixing commit SHA, the candidate SHA, the regression command, and that command's result on that candidate.
- [ ] Assert `live_p0_count` is zero before release credit; any positive count fails the gate. An online collector reporting no currently open P0s does not verify historical closed findings.
- [ ] Retain failed or superseded attempts with the candidate; a later attempt does not erase earlier inventory rows.
- [ ] Keep paths absolute, normalized, and under the local operator's exclusive custody when referenced from an evidence index.
- [ ] Copy no private text, credentials, or machine-specific paths into the ledger; use issue numbers, digests, and bounded references only.

## Synthetic examples (not evidence)

These rows are labelled examples for the documentation contract. They are not
inputs to `evaluateRelease` and cannot grant release credit.

### Closed GitHub issue, unverified on the candidate

```json
{
  "finding_id": "KZ-EXAMPLE-CLOSED-UNVERIFIED",
  "issue_number": 48,
  "issue_state": "closed",
  "disposition": "unresolved",
  "reason": "GitHub closed the original finding; no candidate-bound regression was recorded"
}
```

`issue_state` is `closed`. `disposition` stays `unresolved` because the row has
no fixing commit, no candidate SHA, and no regression command result.

### Verified-fixed on the exact candidate

```json
{
  "finding_id": "KZ-EXAMPLE-VERIFIED-FIXED",
  "issue_number": 49,
  "issue_state": "closed",
  "disposition": "verified-fixed",
  "candidate_source_sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "fix_commit_sha": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "regression_command": "bun test packages/core/test/example.test.ts",
  "regression_result": "pass"
}
```

`verified-fixed` names the candidate, the fix, the regression command, and the
result on that candidate. The online collector's empty open-P0 inventory is not
this proof.

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
