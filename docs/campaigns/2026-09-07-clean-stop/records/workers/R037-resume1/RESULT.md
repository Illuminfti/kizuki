# Result R037

Outcome: PREPARED (with confirmed current-behavior findings). Scope: map ordinary extraction batch counters versus admitted outputs; draft a two-event accounting fixture. No repository edits.

- Repository/worktree/branch: `/repo` git archive of `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7`; no Git metadata. Remote/CI/worktrees not verified.
- Base, input head, final head and tree: base_sha `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7`; no source HEAD movement (read-only).
- Dirty/local-only state and owned files: source unchanged; outputs only under `/work/out`.
- Applicable instruction/skill paths: `/work/AGENTS.md`, `/work/ROLE.md`, `/work/packet.json`, `orient-repository`, `issue-pickup-execution`, `test-strategy`, `handoff-work`; binding `docs/CURRENT.md`, `docs/decision-log.md`, RFC 0002.
- What changed and why: preparation artifacts only. Public behavior of extract/write-pass/rails is documented, not modified.
- Ownership/dependencies: P015 legacy recovery, P003 evidence, P006 docs untouched. Feeds P033, P036.

| Check | Exact command, head, runtime, time and evidence | Result |
| --- | --- | --- |
| Focused/public behavior | `TMPDIR=/work/out/tmp bun /work/out/two-event-accounting-fixture.ts` on archive `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7`, Bun 1.3.14, 2026-09-06T22:02:41Z–22:02:47Z, 59/59 checks, `/work/out/two-event-accounting-observed.json` | PASS (exit 0) |
| First fixture attempt | same command while `/work/out` was 0775; `CanonFilesError: canon_files_unsafe`; `/work/out/logs/fixture-unsafe-first-run.txt` | FAIL then remediated by chmod 0755 (not an extraction-accounting miss) |
| Existing repo tests | not executed: they use `os.tmpdir()` outside `/work/out`; exact two-event joint case statically absent (`/work/out/existing-coverage.json`) | NOT_RUN |
| Package/type/full gate | `bun test packages/core/test`, `bun run typecheck`, `bun run verify` | NOT_RUN (prep packet; no source change; full gate not assigned) |
| Privacy/diff integrity | stub producer, synthetic texts, no credentials, no live providers | PASS (static) |
| Independent review | not assigned | NOT_RUN |
| Retained package/consumer | none | NOT_RUN |

Findings first, severity ordered:

1. **Contract trap (confirmed, executed).** `RunReceipt.claims_extracted` is not filed-output. After a two-draft journal and a failed second insert, the failed rail receipt reports `claims_extracted=2` and `model.calls=1` while live model claims=0, extract cursor is null, and `extract_batches=1`. Overlay: `packages/core/src/serve/rails.ts:355-359` over `extract_usage` written at `write-pass.ts:277` as `ok ? claims.length : 0`. Replay then files both drafts with `WritePassResult.claims_extracted=0` (not another extraction).
2. **Call ≠ event ≠ draft (confirmed).** Ordinary two-event success: 1 produce() / `model.calls=1`, `claims_extracted=2`, cursor advances once to event 2. One drop: calls=1, extracted=1, cursor still advances. Empty-ok: calls=1, extracted=0, cursor advances. Rejected/unavailable: calls=1, extracted=0, cursor stays.
3. **`claims_rejected` is mixed (static + executed).** Whole-call `schema_invalid` and per-draft `unknown_predicate` share the same map; doctor treats only the whole-call reasons as model failure (`doctor.ts:184-191`).

Remaining risk: full core/type/verify gates NOT_RUN; archive has no Git/CI association; no native/account/model qualification. Next smallest action: P033/P036 consume the dictionary and choose the seam they mean; if they add a repo test, port this fixture without duplicating write-pass durability or extract-legacy.

No merge, deploy, release, or settings changes. No credentials or owner-vault paths.
