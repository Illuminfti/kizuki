# Result P047

Outcome: **FINDINGS**. Scope: read-only Telegram sanctioned-flow and fixture preflight on base `32713ad98899a8d1e8ac21a2ebbe3170f6af51a0`. No source edits, no account/API calls, no auth retest.

- Repository/worktree/branch: `/repo` git archive of exact base (no Git metadata). Fleet identity `archive_sha256=939850c9ca71fae8242a8e7783e8bab3afdd35e1c30410ece36cb03fbecad052`. Assigned write scope `/work/out/` only.
- Base, input head, final head and tree: base `32713ad98899a8d1e8ac21a2ebbe3170f6af51a0`; no checkout mutation; remote refs **not** refreshed in this container.
- Dirty/local-only state and owned files: product tree unread-only; deliverables under `/work/out/`.
- Applicable instruction/skill paths: `/work/AGENTS.md`, `/work/ROLE.md`, `/repo/AGENTS.md`, `/repo/packages/connectors/AGENTS.md`, `/repo/docs/CURRENT.md`, `/repo/docs/decision-log.md`, `/repo/rfcs/0002-autonomous-canon.md`, skills `orient-repository`, `issue-pickup-execution`, `connector-work`, `documentation-accuracy`, `handoff-work`. GitHub issue #544 live body **not** fetched.
- What changed and why: book-only primary-source packet, implemented-vs-missing inventory, synthetic fixture plan.
- Ownership/dependencies: connector-telegram + CLI command are in-tree; shared release script, lockfile, `api_id` custody, live account, and API ToS/AI interpretation are **not** this lane.

| Check | Exact command, head, runtime, time and evidence | Result |
| --- | --- | --- |
| Focused/public behavior | No package tests executed (read-only packet) | NOT_RUN |
| Package/type/full gate | `scripts/verify.sh` not run | NOT_RUN |
| Privacy/diff integrity | No product diff. Fetches were public HTML. No credentials printed | PASS (static) |
| Independent review | Not assigned | NOT_RUN |
| Retained package/consumer | None built | NOT_RUN |
| Primary-source fetch | `bun /work/out/research/fetch-telegram-docs.ts` and `fetch-more.ts` on 2026-09-06; evidence `/work/out/research/` | PASS |

Findings first, severity ordered:

1. **Auth distribution:** official docs (https://core.telegram.org/api/auth, 2026-09-06) restrict SMS/call codes to mobile official apps in some conditions. Third-party desktop sign-in is not guaranteed. Affects `packages/connector-telegram/src/client.ts` / `src/sign-in.ts` and missing `docs/connect.md` Telegram section.
2. **Release credentials:** `scripts/build-release.ts` does not compile `KIZUKI_TELEGRAM_*`. Default catalog is unavailable. Affects native package vs `packages/connector-telegram/README.md` compile recipe.
3. **Docs hole:** `docs/connect.md` has no Telegram section; `docs/cli.md` usage fence omits `connect telegram` while the command exists in `packages/cli/src/commands/connect.ts`.
4. **Coverage honesty already in code, missing from public connect docs:** `tombstones: false`, secret chats unread, edit window 200, dialog cap 5000, no live qualification (`packages/connector-telegram/README.md`, `docs/CURRENT.md`).
5. **Unhandled provider login types / RPC names** collapse to generic `parse_error` in `packages/connector-telegram/src/guard.ts` (published API id, banned/flooded phone, UPDATE_APP_TO_LOGIN, email/Fragment/Firebase/payment-required).
6. **API Terms 1.5** (https://core.telegram.org/api/terms) prohibit aggregating Telegram data for AI/ML. Unresolved vs model-backed canon. Legal/product, not a test gap.
7. **Live account qualification unrun.** Beeper is not Telegram credit. Smoke test skipped.

Remaining risk: live DC migrate, GramJS read/online side effects, `getHistory` limit 500 vs documented ~100, unofficial-client observation/ban, foldered dialogs, secret-chat listing behavior. Next smallest action: public-doc Telegram section plus synthetic F2–F12 fail-closed cases; keep live `api_id`/account/ToS work with their owners.

No merge, deploy, release, or external message was authorized or performed.
