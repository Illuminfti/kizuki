# Result R007

Outcome: FINDINGS. Scope: current acceptance consumption cannot represent review SHA, reviewer identity, different-model lens, or review supersession; candidate SHA is the only source-revision slot.

- Repository/worktree/branch: `/repo` git archive of `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7`; no Git metadata; no live remote verification
- Base, input head, final head and tree: base = archive SHA `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7`; no source edits
- Dirty/local-only state and owned files: write scope `/work/out` only
- Applicable instruction/skill paths and effective discovery: `/work/AGENTS.md`, `/work/ROLE.md`, `/work/packet.json`, `orient-repository`, `issue-pickup-execution`, `test-strategy`, `handoff-work`; binding `docs/CURRENT.md`, `docs/decision-log.md`, `rfcs/0002-autonomous-canon.md`
- What changed and why: no repository change. Prepared a line-referenced gap map and accepted-versus-missing fixtures for `candidate.independent-review`
- Ownership/dependencies: P003 owns evidence-contract design; P006 owns canonical docs; this packet feeds P005 and P096. No native/account/model/human/release claim

| Check | Exact command, head, runtime, time and evidence | Result |
| --- | --- | --- |
| Focused/public behavior | `bun /work/out/run-review-attribution-fixtures.ts` on base `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7`, Bun 1.3.14, 2026-09-06T21:43:11Z, `/work/out/checks/consumption-check.json` | PASS |
| CLI NO-GO reports | `bun /repo/scripts/go-no-go.ts --profile rc\|1.0 --evidence … --out …`; exits 1; `/work/out/checks/cli-report-review-rows.json` | PASS |
| Extra CLI reviewer flag | `--reviewer synthetic-reviewer` exit 2; no output file; `/work/out/checks/cli-reviewer-flag.stderr` | PASS |
| Package/type/full gate | `bun test scripts/go-no-go.test.ts` and `bun run verify` | NOT_RUN (missing `node_modules`/`js-tiktoken/lite`; archive has no Git) |
| Privacy/diff integrity | Probe strings `synthetic-reviewer`, `synthetic-different-model`, `synthetic.review-attribution/v0` absent from reports | PASS |
| Independent review | C2 independent-model lens is not representable on this consumer | documented gap, not a release claim |
| Retained package/consumer | n/a (preparation packet; synthetic indexes only) | NOT_RUN |

Findings first, severity ordered:

1. **Review SHA / exact reviewed head is missing.** `scripts/go-no-go.ts:158,171-203`. `candidate.independent-review.evidence_sha256` stays null. Affected invariant: exact-head review (`AGENTS.md:298,315`).
2. **Reviewer identity is missing.** Gate type `scripts/go-no-go.ts:13`; docs `docs/release-acceptance.md:41,184-186`. Extra `reviewer_identity` key is `invalid-schema` and is not copied into the report.
3. **Different-model lens is missing.** C2 (`docs/decision-log.md:97`) requires three lenses; the gate (`docs/release-acceptance.md:134`) and review playbooks name two. No model-id field.
4. **Review supersession is missing.** Only calendar/cutover rows use `superseded-readiness-gate` (`scripts/go-no-go.ts:164-166`). Independent-review stays required `NOT_IMPLEMENTED`.
5. **Candidate source revision is present.** `candidate_source_sha` on a valid index. It is the candidate, not a review pin.

Existing extra-key / unknown-producer / no-waiver tests in `scripts/go-no-go.test.ts` already cover fail-closed index behavior but never name `candidate.independent-review`. Fixtures here are integration drafts, not duplicate repository tests.

Remaining risk: existing tests and `bun run verify` were not executed (missing install and Git). P003 unpublished output was not read. No live review/CI. Next smallest action: P003 designs a review-evidence producer that can carry exact head, reviewer identity, independent-model lens, and supersession without weakening fail-closed index parsing.

Do not infer integrated, released, live-account tested, or unfamiliar-user accepted from this packet.
