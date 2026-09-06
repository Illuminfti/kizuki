# Result R028

Outcome: FINDINGS. Scope: independent truth table of current sensitivity resolution APIs for P022/P097; no source edits.

- Repository/worktree/branch: `/repo` git archive of `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7`; no Git metadata; remote state not verified in this container.
- Base, input head, final head and tree: base `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7`; archive sha256 `187e004334b2aa998dd3ac9d29057e1725d635a00faab24d75bf092eef8b8f36`; no head movement; repository dirty state N/A (read-only archive).
- Dirty/local-only state and owned files: only `/work/out/**`. Repository untouched.
- Applicable instruction/skill paths and effective discovery: `/work/AGENTS.md`, `/work/ROLE.md`, `/work/packet.json`, `orient-repository`, `issue-pickup-execution`, `test-strategy`, `handoff-work`; binding `docs/CURRENT.md`, `docs/decision-log.md` D11/D19, RFC 0002 §8, RFC 0000, `docs/architecture.md`.
- What changed and why: preparation artifacts only. Public contract documented, not modified.
- Ownership/dependencies: feeds P022 and P097. P003/P015/P006/Astra reserved. No native/account/model/human qualification claimed.

| Check | Exact command, head, runtime, time and evidence | Result |
| --- | --- | --- |
| Focused/public behavior | `bun test /work/out/resolve-sensitivity.draft.test.ts` on archive `f57acb3` with Bun 1.3.14 at 2026-09-06T22:01:00Z; 39 pass / 0 fail; `checks.json` | PASS |
| Observer matrix | `bun /work/out/observe-current-api.ts`; 125 core cells match independent expected; 47 connector-hint mismatches | PASS (matrix) / FINDING (connector package) |
| Package/type/full gate | `bash /repo/scripts/verify.sh` | NOT_RUN (no workspace install; not assigned) |
| Existing in-tree sensitivity tests | `bun test packages/core/test/sensitivity/resolution.test.ts` and `packages/connectors/test/sensitivity.test.ts` | NOT_RUN (missing `js-tiktoken` and workspace connector packages) |
| Privacy/diff integrity | read-only `/work/out`; synthetic labels `public`/`personal`/`private`/`not-a-label` only | PASS |
| Independent review | not assigned; self-prep only | NOT_RUN |
| Retained package/consumer | none produced | NOT_RUN |

Findings first, severity ordered:

1. **Connector-package resolver is less conservative than core ingest** (`packages/connectors/src/sensitivity.ts:33-43`). A parseable hint at or above the floor replaces the default even when more public; an absent hint does not clamp default up to the floor; an unknown default can be returned as a non-label. 47/125 observed cells diverge from independent expected. Core `resolve.ts` remains the claim/ingest authority and matched the 125-cell three-axis table. Do not weaken core to match the connector package.
2. **Seed map vs live manifests.** `kizuki.screenpipe` class seed floor is `personal` while the live manifest floor is `private`. Gmail and Google Calendar live floors are `private`, stricter than RFC email/calendar class `personal`. P022 must not lower those live floors.
3. **Unmapped connector ids fail closed to private/private** via `policyForConnector`. That is conservative versus some live manifests (Beeper, X archive) and must not be used to overwrite a more specific enrolled manifest.

Existing named tests already cover model raise/reject, unknown required inputs, health, event-hint, owner_override lowering, and several connector hint samples. Those were cited, not duplicated. In-tree execution of those files is NOT_RUN here.

Remaining risk: full verify and in-tree tests need a workspace install on this exact SHA. Connector `test.failing` rows document desired conservative clamp; they are not a passing current-API contract. Next smallest action: P022 lock the core 27-cell max table and `policyFromManifest` clamp; do not lower live floors; optionally tighten the connector-package resolver to fail closed and honor hints only upward from `max(floor, default)`.
