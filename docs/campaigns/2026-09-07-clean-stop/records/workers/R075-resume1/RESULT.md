# Result R075

Outcome: FINDINGS. Scope: WhatsApp export-import locale/date-order is selected by optional `date_order` plus evidence detection; public CLI enrollment cannot express that configuration.

- Repository/worktree/branch: read-only `/repo` git archive, no Git metadata
- Base, input head, final head and tree: `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7` (FLEET-SOURCE-IDENTITY.json); no source edits
- Dirty/local-only state and owned files: `/work/out` only
- Applicable instruction/skill paths: orient-repository, issue-pickup-execution, connector-work, test-strategy, handoff-work; binding CURRENT.md / D19 / RFC 0002
- What changed and why: preparation artifacts mapping config → parser and CLI gap; no repository behavior change
- Ownership/dependencies: feeds P074; P073 message fidelity out of scope; P006 docs not rewritten here

| Check | Exact command, head, runtime, time and evidence | Result |
| --- | --- | --- |
| Focused parser fixtures | `bun /work/out/run-diagnostics.ts` bun 1.3.14 exit 0; 19/19; `evidence/diagnostic-runner.json` | PASS (remapped parser copies; see provenance) |
| Existing whatsapp-dates tests | `bun test /work/out/local-parser/whatsapp-dates.test.ts` exit 0; 18 pass / 0 fail / 242 expect; source SHA `d0ba4cf8…` | PASS (import remaps only) |
| CLI option seam | `bun /work/out/run-cli-probes.ts` exit 0; 10/10; `--date-order` etc. are `unknown option` | PASS |
| Full CLI process / in-tree workspace test | `bun packages/cli/src/main.ts …` and `bun test ./packages/connectors/test/whatsapp-dates.test.ts` from `/repo` | NOT_RUN — `/repo` has no `node_modules`; install forbidden |
| Package/type/full gate | `bun test` / `bunx tsc` / `scripts/verify.sh` | NOT_RUN — no workspace install; not an implementation packet |
| Independent review | not assigned | NOT_RUN |
| Live WhatsApp account | — | NOT_RUN by policy |

Findings first:

1. Public enrollment cannot pass or persist `date_order` or `timezone`. `HostConnectionState` is `{ path }` only. `parseArguments` refuses `--date-order` as `unknown option` (CLI would map that to exit 2). Catalog has no locale fields.
2. Parser selection is already implemented and covered: detect from evidence, refuse ambiguity, honor configured order. Do not redesign it.
3. Official Help Center (2026-09-06, FAQ 1180414079177245) has no date-order or timezone grammar.

Remaining risk: P074 must run the same tests on a full checkout. Next smallest action: P074 adds CLI+host-state pins or keeps the documented CLI limitation.

No credentials, private records, or owner-vault paths.
