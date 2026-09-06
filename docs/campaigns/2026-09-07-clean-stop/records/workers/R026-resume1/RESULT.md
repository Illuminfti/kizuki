# Result R026

Outcome: FINDINGS (preparation complete; no repository edit). Scope: mapped current source-connection swap-journal enrollment/sync/re-auth/degraded fields, persistence sequence, and neutral status serialization fixtures on archive `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7`.

- Repository/worktree/branch: read-only git archive `/repo` (no Git metadata). Packet owner `grok-R026`. Write scope `/work/out` only.
- Base, input head, final head and tree: base_sha `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7`; archive_sha256 `187e004334b2aa998dd3ac9d29057e1725d635a00faab24d75bf092eef8b8f36`. No worker commits.
- Dirty/local-only state and owned files: `/repo` untouched. Worker outputs only under `/work/out`.
- Applicable instruction/skill paths: `/work/AGENTS.md`, `/work/ROLE.md`, `/work/packet.json`, `orient-repository`, `issue-pickup-execution`, `test-strategy`, `handoff-work`; binding `docs/CURRENT.md`, `docs/decision-log.md` D19, RFC 0002, RFC 0000, `packages/core/AGENTS.md`.
- What changed and why: preparation artifacts only. Public contract is current `kizuki.connection-state-swap/v1` plus row/run/CLI status serialization.
- Ownership/dependencies: P003 evidence, P015 source-B, P006 docs, Astra/doctor remain reserved. Feeds P018 and P083 after review/rebase. No source-B migration designed. No crash simulation added.

| Check | Exact command, head, runtime, time and evidence | Result |
| --- | --- | --- |
| Focused/public behavior | `bun /work/out/validate-fixtures.ts` bun 1.3.14 at 2026-09-06T22:00:21.261Z; 31 pass; receipt `/work/out/validation-receipt.json`; base `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7` | PASS |
| Existing core connection tests | `cd /repo && bun test packages/core/test/connections*.ts` — `/repo` has no `node_modules`, is not writable, and suite temps use `os.tmpdir()` outside `/work/out` | NOT_RUN |
| Package/type/full gate | `bun test` / `bunx tsc --noEmit` / `bash scripts/verify.sh` | NOT_RUN |
| Privacy/diff integrity | static: fixtures use `ordinary-session` / `ordinary-session-rotated`; no credentials; no owner-vault paths | PASS (static) |
| Independent review | not assigned this packet | NOT_RUN |
| Retained package/consumer | no package built | NOT_RUN |

Findings first (characterizations, not production defects):

1. `decodeSwapJournal` (`connection-state-journal.ts:30-74`) ignores extra JSON keys and accepts `{final}.rollback` without a ULID infix. Writer (`connection-state.ts:306-315`) always emits eight fields and `{final}.{ulid}.rollback`.
2. After `rewrite`, `connected_at` is “state last written at” (`connection-state.ts:507-509`).
3. `connect status --json` list path always emits envelope `status: "ok"` even when a source is `disconnected` or `needs attention` (`connect-catalog.ts:71-81`). Envelope `degraded` is used on `connect status --source` resume-revocation (`connect-consent.ts:43-45`).
4. `commitConnectionRow` CAS does not update `consent_required` (`connection-state-rows.ts:140-157`).

Remaining: existing repository tests and full gate unexecuted (missing writable installed checkout). No native/account/model/human qualification. Next smallest action: P018/P083 consume `/work/out/connection-state-transitions.md` and fixtures after review; do not treat this as implementation authority.
