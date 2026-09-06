# Result P050

Outcome: FINDINGS. Scope: shared Google-auth owner map and Gmail preflight on immutable base `32713ad98899a8d1e8ac21a2ebbe3170f6af51a0`; Calendar-specific work consumes this contract; no source edits; no live sign-in.

- Repository/worktree/branch: `/repo` git archive of exact base; no Git metadata; this lane writes `/work/out` only.
- Base, input head, final head and tree: base `32713ad98899a8d1e8ac21a2ebbe3170f6af51a0`; archive SHA-256 `939850c9ca71fae8242a8e7783e8bab3afdd35e1c30410ece36cb03fbecad052`; no HEAD movement.
- Dirty/local-only state and owned files: archive clean; deliverables listed in `result.json`.
- Applicable instruction/skill paths and effective discovery: `docs/CURRENT.md`, `docs/decision-log.md`, RFC 0002, RFC 0000, architecture, connectors/core/cli `AGENTS.md`; skills orient-repository, issue-pickup-execution, connector-work, api-contract-design, security-privacy-review, handoff-work, elegance-review (read-only). Live GitHub issue/PR state **not verified**.
- What changed and why: book-only reports. Public behavior unchanged.
- Ownership/dependencies: P050 owns the shared Google OAuth contract. Calendar lane consumes it. Core OAuth, lockfiles, and registries stay with their owners.

| Check | Exact command, head, runtime, time and evidence | Result |
| --- | --- | --- |
| Focused/public behavior | No connector/CLI tests run (read-only packet) | NOT_RUN |
| Package/type/full gate | `scripts/verify.sh` not run | NOT_RUN |
| Privacy/diff integrity | Static review of assigned paths; no tree diff | FINDINGS (see `security-privacy-review.md`) |
| Independent review | Not assigned; elegance-review loaded read-only | NOT_RUN |
| Retained package/consumer | None built | NOT_RUN |
| Primary docs | Bun 1.3.14 `fetch` of Google developer URLs on 2026-09-06; `research/fetch-index.json` | PASS (public GET only) |
| Live Google account | Forbidden by packet | NOT_RUN |
| Auth/model probe | Controller already passed; not retested | NOT_RUN |

Findings first, severity ordered:

1. `docs/architecture.md` + C4 vs `docs/CURRENT.md` — compiled-in project credentials are binding product intent; this revision implements operator runtime `KIZUKI_GMAIL_CLIENT_ID` / `KIZUKI_GOOGLE_CALENDAR_CLIENT_ID`. Stranger sign-in without Cloud Console work is refused. Required: keep CURRENT.md honesty; compiled-in door is a later named owner, not Calendar.
2. `gmail.readonly` is Restricted (Gmail scopes page 2026-09-06). Public production needs restricted-scope verification; CASA if storing/transmitting on servers. Personal-use/testing exceptions still have a user cap and limited refresh tokens. No registered app on this revision.
3. Incremental authorization is not supported for installed apps. Combined Gmail+Calendar scopes (Wave 1 `connector-google.md`) are out of contract. Calendar must keep a separate authorization, token envelope, source key, and grant.
4. `calendar.events.readonly` is all-calendars at Google; Kizuki narrows locally. Residual least-privilege; Calendar-owned scope choice (`calendar.events.owned.readonly`) must not change shared auth.
5. Stale Gmail `startHistoryId` → HTTP 404 → full resync with `gap`; never infer deletions. Snapshot fingerprint mismatch refuses without advancing history. Implementation already matches; Calendar 410 is the analog.
6. Local revoke/close does not revoke Google permission. Completed Google consent plus refused local enroll cannot be undone by Kizuki.
7. Mail/event content is not account authority. Account id is OIDC `sub` only.

Remaining risk: no live-account, no verification letter, no Windows launcher, no exact Help Center user-cap integer, no GitHub #545 live view, full repository gate NOT_RUN. Next smallest action: Calendar lane implement/review against `shared-google-auth-owner-map.md` and `shared-oauth-contract.fixture.json` without forking OAuth; operator app registration remains outside code.

Do not infer integrated, released, live-account tested, or unfamiliar-user accepted. No credentials or vault paths.
