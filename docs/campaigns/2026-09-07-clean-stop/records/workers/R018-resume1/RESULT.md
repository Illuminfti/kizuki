# Result R018

Outcome: FINDINGS. Scope: read-only map of current source-erasure intent replay transitions, durable fields, caller lines, and a neutral state machine using only current phase names on base `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7`.

- Repository/worktree/branch: read-only git archive at `/repo`; no Git metadata; packet owner `grok-R018`; write scope `/work/out` only
- Base, input head, final head and tree: base_sha `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7` (FLEET-SOURCE-IDENTITY.json). Archive sha256 `187e004334b2aa998dd3ac9d29057e1725d635a00faab24d75bf092eef8b8f36`. No source edits; no new HEAD.
- Dirty/local-only state and owned files: repository untouched. Worker outputs only under `/work/out`.
- Applicable instruction/skill paths and effective discovery: `/work/AGENTS.md`, `/work/ROLE.md`, `/work/packet.json`, `/work/.grok/skills/orient-repository/SKILL.md`, `issue-pickup-execution`, `test-strategy`, `handoff-work`; `/repo/AGENTS.md`, `/repo/packages/core/AGENTS.md`, `docs/CURRENT.md`, `docs/decision-log.md`, `rfcs/0002-autonomous-canon.md`, `rfcs/0000-constraints.md`, `docs/architecture.md`. GitHub issue 48 body not retrieved (no `gh`, no account API). Remote/PR state not verified.
- What changed and why: no product contract change. Preparation artifacts map current intent replay for P015/P018.
- Ownership/dependencies: P015 retains source-B schema/recovery/authority/export implementation; P003 shared evidence; P006 canonical docs. This packet does not replace them.

| Check | Exact command, head, runtime, time and evidence | Result |
| --- | --- | --- |
| Focused/public behavior (pure classifier) | `bun /work/out/source-erasure-intent-state-machine.ts /work/out/classifier-check.json` on archive `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7`, Bun 1.3.14, evidence `/work/out/classifier-check.json` | PASS (exit 0, 10 synthetic name checks) |
| Existing vault test (same-ID temp) | `TMPDIR=/work/out/tmp bun test /repo/packages/core/test/canon/write-page.test.ts --test-name-pattern "source erasure resumes its exact same-ID"` | FAIL (exit 1) `CanonFilesError: canon_files_unsafe` at `packages/core/src/vault/init.ts:790` — untrusted worker tmp, not a contract verdict |
| Package/type/full gate | `bun test` / `bunx tsc --noEmit` / `bash scripts/verify.sh` | NOT_RUN (no test slot; vault init unsafe here; no installs) |
| Privacy/diff integrity | no source diff | PASS (no repository writes) |
| Independent review | not assigned | NOT_RUN |
| Retained package/consumer | none | NOT_RUN |

Findings first, severity ordered:

1. **Observation (not a defect):** `SourceErasureIntent` version 1 has no phase/`write_state` column (`packages/core/src/canon/source-erasure-intent.ts:15-24`, `schema.ts:41-43`). Per-page replay is `receipt.before_hash` vs `receipt.after_hash` in `recoverSourceErasureIntents` (`apply.ts:947-953`). RFC 0004 `staged`/`admitted`/`receipted` are proposed only and were excluded from the draft.
2. **Coverage already exists:** interruption matrix `packages/core/test/source-grants.test.ts:1586-1669`; same-ID temp `write-page.test.ts:332-351`; JSONL retry `receipt-stream.test.ts:68-91`. No duplicate product test drafted.
3. **Environment:** existing vault tests cannot be executed as a contract proof in this worker tmp (`canon_files_unsafe`). Do not treat that FAIL as a source-erasure regression.

Remaining risk, failed/interrupted checks, unavailable accounts/platforms, and next smallest action: GitHub issue 48 unread; remote not fetched; full verify.sh NOT_RUN; no native/account/human qualification. Next: P015 consumes this map for schema/recovery work; independent review of these artifacts; rebase before production use.

Do not infer integrated, released, live-account tested, unfamiliar-user accepted, or elapsed observation from another row.
