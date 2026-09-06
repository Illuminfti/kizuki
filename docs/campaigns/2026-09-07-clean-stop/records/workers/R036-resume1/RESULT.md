# Result R036

Outcome: FINDINGS. Scope: read-only preparation of a result-state golden table
and a bounded neutral `validateProduceResult` test draft for successful-empty,
abstaining, unsupported, and ordinary validation-failure shapes.

- Repository/worktree/branch: read-only `/repo` archive; no Git metadata; worker `/work`
- Base, input head, final head and tree: base `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7`; no source HEAD movement; no repository diff
- Dirty/local-only state and owned files: `/work/out` only; repository unchanged
- Applicable instruction/skill paths and effective discovery: `/work/AGENTS.md`, `/work/ROLE.md`, `/work/packet.json`, `/repo/AGENTS.md`, `/repo/docs/CURRENT.md`, `/repo/docs/decision-log.md`, `/repo/rfcs/0002-autonomous-canon.md`, `/repo/packages/core/AGENTS.md`, skills `orient-repository`, `issue-pickup-execution`, `test-strategy`, `handoff-work`; GitHub issue 472 not fetched
- What changed and why: no product behavior change. Artifacts record current distinctions so P033/P036 do not collapse them. P034 corpus not revised.
- Ownership/dependencies: R036 → P033, P036. P034 corpus owner unchanged.

| Check | Exact command, head, runtime, time and evidence | Result |
| --- | --- | --- |
| Focused/public behavior | `cd /repo && bun test ./packages/core/test/producer/result.test.ts ./packages/core/test/producer/schema.test.ts ./packages/core/test/producer/diagnostics.test.ts ./packages/core/test/producer/model.test.ts ./packages/core/test/loop/tri-state.test.ts ./packages/core/test/serve/producer-result-boundary.test.ts` on archive `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7`, Bun 1.3.14, 60 pass / 0 fail, 901 ms | PASS |
| Write-pass dropped vs rejected | `cd /repo && bun test ./packages/core/test/serve/write-pass.test.ts`, 13 pass / 0 fail, 902 ms | PASS |
| Draft validator matrix | `bun test /work/out/bounded-neutral-parser.test.ts` at 2026-09-06T21:59:48Z, 9 pass / 0 fail, 17 ms | PASS |
| Scorer abstention suite | `bun test ./scripts/evaluate-extraction.test.ts` | NOT_RUN (missing `js-tiktoken/lite`; no install) |
| LLM unsupported_metadata suite | `bun test ./packages/llm/test/response-compat.test.ts` | NOT_RUN (missing `@kizuki/core` / `node_modules`) |
| Package/type/full gate | `bun run typecheck` / `bun run verify` | NOT_RUN (read-only prep; no full-suite slot) |
| Privacy/diff integrity | no repository writes; fixtures synthetic; no credentials | PASS (static) |
| Independent review | not assigned | NOT_RUN |
| Retained package/consumer | none | NOT_RUN |

Findings first, severity ordered:

1. Coverage gap, low: `validateProduceResult` had no explicit success assertion for `{ status: "ok", claims: [], usage }`. Behavior matches schema/produce tests. Draft fills the seam without redesigning the contract.
2. Dual wire meaning, preserve: `unknown_predicate` is both a `DroppedDraft` on `ok` (`model.ts:524-532`) and a `PRODUCER_REJECT_REASONS` whole-call reason (`producer.ts:68-75`). Current producer emits only the drop. Doctor does not treat the drop as a model failure (`doctor.ts:184-192`).
3. Layer split, preserve: `ExtractMine` maps every ok empty-claim result to `empty` and advances the cursor (`extract.ts:892-900`), including drop-only results counted in `claims_rejected` (`write-pass.ts:88-93`). Scorer abstention requires dropped count 0 (`evaluate-extraction.ts:272-274`). Rail empty is not scorer abstention.
4. Diagnostic split, preserve: `unsupported_metadata` and ordinary envelope failure both use `reason: "schema_invalid"` but different `usage_known` / `diagnostic.rule` values. Do not collapse.

No confirmed product defect requiring a source change. No native, account, model, or unfamiliar-user claim.

Remaining risk: scorer and LLM package tests were not executed in this container. Issue #472 body was not retrieved. Next smallest action: P033/P036 consume the golden table, copy the validator-seam cases into `packages/core/test/producer/result.test.ts` if they land a patch, and keep P034's corpus unchanged.
