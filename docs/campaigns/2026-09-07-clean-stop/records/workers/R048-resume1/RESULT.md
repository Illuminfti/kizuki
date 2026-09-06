# Result R048

Outcome: FINDINGS. Scope: read-only map of local-app Google enroll fields to `connect gmail` / `connect google-calendar`, with absent/default cases, consent distinction, and neutral host fixtures. No source edits, OAuth, or P042 implementation.

- Repository/worktree/branch: read-only git archive `/repo`; no Git metadata. Packet owner `grok-R048`. Write scope `/work/out` only.
- Base, input head, final head and tree: `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7` (packet and `FLEET-SOURCE-IDENTITY.json`). Archive SHA256 `187e004334b2aa998dd3ac9d29057e1725d635a00faab24d75bf092eef8b8f36`. Head not moved; remote not fetched (controller-owned).
- Dirty/local-only state and owned files: `/repo` untouched. Outputs only under `/work/out`.
- Applicable instruction/skill paths and effective discovery: `/work/AGENTS.md` controller certificate; `/repo/AGENTS.md`; `/repo/docs/CURRENT.md`; `/repo/docs/decision-log.md` D19; RFC 0002; `/repo/packages/cli/AGENTS.md`; skills `orient-repository`, `issue-pickup-execution`, `api-contract-design`, `test-strategy`, `handoff-work`. `vps-nav` not run (forbidden in this container).
- What changed and why: preparation artifacts mapping UI → `/app/v1/enroll` → CLI argv and grant `allowed_fields`. Feeds P042.
- Ownership/dependencies: P042 consumes this map. P003/P015/P006, Astra, doctor remain reserved. No overlapping write in this lane.

| Check | Exact command, head, runtime, time and evidence | Result |
| --- | --- | --- |
| Focused/public behavior | `bun /work/out/verify-field-map.ts` on replica parsers; Bun 1.3.14; evidence `/work/out/verify-field-map.json`; 17/17 cases; `order_mismatch=true` | PASS (replica only) |
| Source module import | `bun -e` import `packages/cli/src/gmail.ts` | NOT_RUN: `Cannot find module '@kizuki/connector-gmail'` (no workspace node_modules) |
| Package/type/full gate | `bun test` / `bunx tsc` / `scripts/verify.sh` | NOT_RUN: missing workspace install; helpers write temp vaults outside `/work/out` |
| Privacy/diff integrity | no `/repo` writes; fixtures use `synthetic-canonical-calendar` and a non-secret Crockford key | PASS (static) |
| Independent review | not assigned | NOT_RUN |
| Retained package/consumer | none | NOT_RUN |

Findings first, severity ordered:

1. `packages/cli/src/app/host.ts:311` vs `packages/cli/src/commands/connect-gmail.ts:37` and `packages/connector-gmail/src/state.ts:8` — host reauth `JSON.stringify` field compare does not sort; CLI does; CLI parser order ≠ connector stored order. Same Gmail field set can `identity_conflict` on host reauth. Replica confirmed `host_stringify_equal=false`. Affected invariant: reauthorization must preserve selected fields, not field-array order. Smallest fix is owned by P042/implementer: compare sorted sets (as CLI) or persist one canonical order through host.
2. `packages/cli/src/app/host.ts:296` + `google-calendar.ts:39` + `host.ts:50-54` — omitted Calendar `calendar_id` becomes `unavailable` (retryable) rather than `invalid_request`. Empty string is `invalid_request`. Affected: honest client errors. Smallest fix: treat missing/primary calendar as `AppFailure('invalid_request')` before `googleCalendarId`.
3. Invalid `--fields`/`--calendar` values exit 1 (`Error`), not usage 2. Exclusive flags exit 2. Documented, not a product break.

Hypotheses (unexecuted): UI default payloads are inferred from `client.js:238,250` and not asserted by a client test.

Remaining risk: app-host and CLI process enroll unexecuted in this container. Next smallest action: P042 consume `command-argument-mapping.md` and fixtures; do not duplicate Gmail empty-field tests already at `app-service.test.ts:150-157` and `app-client.test.ts:64-70`.
