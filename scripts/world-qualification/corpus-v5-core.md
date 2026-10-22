# Fresh core qualification integration

This unpublished branch selects the independently authored 12-case core split for
measurement. The Concept and Situation producer vocabulary is unchanged. The
sealed author files are copied byte-for-byte; v1, v2 and v3 corpora and earlier
reports remain historical evidence. No observed answer may change the cases,
finite literal alternatives, witness spans or forbidden interpretations.

`run.ts` includes both the unchanged strict tuple scorer and the supplemental
witness, substance, attribution, time and usage checks in each saved report.
Exactly one measured successful response with zero parser or admission drops is
required per case. Diagnostic subsets remain visibly incomplete. Only all 12
cases, both kinds, no extension and no resumed response can qualify this split.
The actual run command after independent source and endpoint review is:

```bash
bun scripts/world-qualification/run.ts --kinds concept,situation \
  --base-url REVIEWED_ENDPOINT --model REVIEWED_MODEL \
  --token-file PRIVATE_TOKEN_REFERENCE --out NEW_PRIVATE_REPORT \
  --raw-responses NEW_PRIVATE_RAW_RESPONSES
```

The runner never declares free-text bodies semantically reviewed. Its
`supplemental.body_review` remains `pending`, including when all deterministic
checks pass. An independent reviewer must examine the exact response bodies
against the sealed forbidden-interpretation rubric. A contradictory body can
pass tuple and anchor checks; the tests retain this limitation explicitly.

Before any active approval, retain a separately reviewed JSON artifact with
schema `kizuki.fresh-core-body-review/v1`, `independent: true`, `status: "passed"`,
the exact `report_sha256` and `oracle_sha256`, and all 12 ordered `cases`.
Each case contains its `case_id`, `status: "passed"`, and the exact
`response_sha256` and `forbidden_interpretations` from that report's supplemental
case. The verifier compares the complete artifact, rejects extra or missing
fields, and pins its bytes through approval `body_review: { file, sha256 }`.
The file lives beside reviewed reports under `scripts/fixtures/world-qualification`.
A reviewed hash records independent review; deterministic tests do not supply it.

Current approvals are deliberately empty, with the previous Concept report and
endpoint pins retained in `HISTORICAL_QUALIFICATIONS`. The public qualification
gate refuses missing current core coverage even though these kinds were already
in the baseline. CI approval therefore remains pending actual passing transport,
both scoring gates, independent body and endpoint review, and an authorized
atomic report/approval update. No model recall, native behavior or production
activation is established by this preparation.
