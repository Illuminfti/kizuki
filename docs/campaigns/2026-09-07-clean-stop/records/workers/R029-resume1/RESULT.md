# Result R029

Outcome: FINDINGS (preparation complete). Scope: static parameter-to-check map of source-grant projection through ordinary serving, plus neutral permitted/missing-configuration fixtures. No product source edits.

- Repository/worktree/branch: `/repo` git archive of `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7`; no Git metadata; live branch not refreshed.
- Base, input head, final head and tree: base `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7`; no head movement; tree unchanged.
- Dirty/local-only state and owned files: product tree untouched; outputs only under `/work/out`.
- Applicable instruction/skill paths: `/repo/docs/CURRENT.md`, `/repo/docs/decision-log.md`, `/repo/rfcs/0002-autonomous-canon.md`, `/repo/AGENTS.md`, `/repo/packages/core/AGENTS.md`, orient-repository, issue-pickup-execution, test-strategy, handoff-work.
- What changed and why: preparation artifacts only. Public serving contract unchanged.
- Ownership/dependencies: feeds P029 and P037. P003/P015/P006/Astra/doctor reserved.

| Check | Exact command, head, runtime, time and evidence | Result |
| --- | --- | --- |
| Focused/public behavior | `bun /work/out/static-line-check.ts` on archive `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7`, Bun 1.3.14, exit 0, `/work/out/checks.json` | PASS |
| Existing serving source-grant tests | `bun test packages/core/test/source-grants.test.ts -t "native serving denies legacy agent access"` | NOT_RUN (no node_modules; install forbidden) |
| Package/type/full gate | `bash scripts/verify.sh` / `bunx tsc --noEmit` | NOT_RUN |
| Privacy/diff integrity | static source read; no vault or credentials | PASS (static) |
| Independent review | not assigned | NOT_RUN |
| Retained package/consumer | none | NOT_RUN |

Findings first, severity ordered:

1. Coverage gap, `packages/core/test/serving/helpers.ts` + serving `*.test.ts`: `serveFixture` never grants, so epoch 0. Ordinary search/get_page/entities/graph/health/propose lack enforced-epoch tests. Existing exact timeline/packet/correct cases live in `packages/core/test/source-grants.test.ts:341-397,192-198,879-965` — do not duplicate.
2. Untested seam, `packages/core/src/serving/retrieval.ts:19`: `retrieval-source-egress-denied` has no test (`retrieval-consumer.test.ts` covers other degraded tokens).
3. Schema mismatch, `packages/mcp/src/schemas.ts:47-56`: MCP `ENVELOPE_SHAPE` omits `source_policy` that `gate.ts:328` emits when epoch > 0. `scripts/artifact-engine.ts:54` already allows it as optional extra. Not confirmed broken at runtime (Zod 4 object parse may strip rather than fail).
4. Error mapping, `packages/core/src/serving/gate.ts:275-300` + `source-grants.ts:797-803`: `requireSourceEvents` throws `SourceGrantError`; if it reaches `failed()` it becomes generic `error`/`serving failed`. `correct` and `propose` convert earlier on the ordinary path.

These are static observations, not executed failures.

Remaining risk: existing tests not run on this archive. Next smallest action: P029 add the gap cases to `source-grants.test.ts` using the current setup helper; P037 consider declaring `source_policy` on the MCP envelope shape. No native/account/model/human qualification claimed.
