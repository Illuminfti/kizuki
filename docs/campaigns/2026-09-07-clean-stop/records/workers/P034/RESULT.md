# Result P034

Outcome: FINDINGS. Scope: freeze a neutral held-out rich-subject semantic oracle with independent gold, support anchors, allowed abstention, and per-axis metrics; no product edit, no model call, no quality claim.

- Repository/worktree/branch: `/repo` read-only git archive of `32713ad98899a8d1e8ac21a2ebbe3170f6af51a0` (archive sha256 `939850c9ca71fae8242a8e7783e8bab3afdd35e1c30410ece36cb03fbecad052`). No Git metadata. No assigned product worktree.
- Base, input head, final head and tree: base = input = `32713ad98899a8d1e8ac21a2ebbe3170f6af51a0`. Product tree unchanged. Deliverables only under `/work/out/`.
- Dirty/local-only state and owned files: book-only outputs listed below. Astra PR 500 and repository sources were not modified.
- Applicable instruction/skill paths and effective discovery: `/work/AGENTS.md`, `/work/ROLE.md`, `/work/packet.json`, `/repo/docs/CURRENT.md`, `/repo/docs/decision-log.md`, RFC 0002/0000, RFC 0003/0004 (Proposed), `claim-v2.ts`, `producer-v2.ts`, `docs/extraction-quality.md`, skills `orient-repository`, `issue-pickup-execution`, `test-strategy`, `epistemic-integrity`, `longitudinal-evaluation`, `handoff-work`. Remote/GitHub state was not freshly verified.
- What changed and why: authored `kizuki.rich-subject-holdout-oracle/v1` (`synthetic-holdout-20-v1`) covering discovery, homonyms, attribution, temporal perspectives, abstention, and copied support, with independent metrics and no composite score.
- Ownership/dependencies: grok-P034 owns this oracle. Astra retains PR 500 / RFC 0003 B1b–d. Issue 472 B2 producer and the reviewed directional catalog remain unbuilt.

| Check | Exact command, head, runtime, time and evidence | Result |
| --- | --- | --- |
| Focused/public behavior | `bun /work/out/validate-rich-subject-holdout.ts /work/out/rich-subject-holdout-oracle-v1.json` on archive `32713ad98899a8d1e8ac21a2ebbe3170f6af51a0`, Bun 1.3.14, 2026-09-06. Receipt `/work/out/validation-receipt.json`. Digest `3dc4675cb77fee464481b3a14b0d573de6c7b54ed52b9da954dc1316bb662246`. Fixture integrity only; no producer run. | PASS |
| Package/type/full gate | `bun run typecheck` / `bun run verify` | NOT_RUN (no product change; no test slot; archive has no Git metadata) |
| Privacy/diff integrity | Static review: synthetic names only; no owner vault, credentials, or private records. Isolation clause forbids feeding gold into prompts. | PASS |
| Independent review | Not assigned. Self-review of authored gold is not C2. | NOT_RUN |
| Retained package/consumer | No artifact built. | NOT_RUN |

Findings first, severity ordered:

1. **Held-out oracle frozen (info).** 20 synthetic cases, 26 records, 39 required subjects, 38 required claims, 27 forbidden patterns, 32 must-not-merge pairs, 3 required-abstention cases, 1 identity-only abstention case, 1 copied-support case. Support anchors are UTF-16 spans with `quoted_text`. Allowed abstention is explicit on non-required rows.
2. **Metrics are independent (info).** Axes: discovery, false merges, class precision/recall, relation direction, speaker/quote attribution, copied-support independence, abstention, temporal interval. Composite/`semantic_quality_score` is forbidden and null.
3. **B2 catalog is fixture-proposed (limitation).** RFC 0003 B2 directional vocabulary is not reviewed or installed. `schedule.meets_on` is fixture-only. A v1 string producer cannot satisfy this oracle.
4. **No model evaluation (limitation).** `evaluation_state: not_run`. Gold is authored, not independent unfamiliar-human judgment required by RFC 0003 for full discovery acceptance.
5. **PR 500 non-interference (info).** Copied-support gold does not specify or amend Core A1 independent-root implementation.

Remaining risk, failed/interrupted checks, unavailable accounts/platforms, and next smallest action: keep this corpus held-out; do not tune on it. Next smallest dependency is the reviewed B2 predicate catalog and real v2 producer after Astra’s shared-writer lane. No merge, deploy, release, or qualification follows from this packet.

Do not infer integrated, released, live-account tested, unfamiliar-user accepted, or elapsed observation from another row. No credentials, private records, raw provider payloads, or owner-vault paths.
