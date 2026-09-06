# Result R044

Outcome: FINDINGS. Scope: source-static keyboard/focus map of the bundled local app UI on archive `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7`, plus an unexecuted owner browser-check draft. No repository edits. Not a release, native, account, or unfamiliar-user acceptance.

- Repository/worktree/branch: `/repo` read-only git archive of exact commit `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7` (`FLEET-SOURCE-IDENTITY.json`). No Git metadata. Remote/host navigation not verified here (controller-owned). Lane owner `grok-R044`. Write scope `/work/out` only.
- Base, input head, final head and tree: base_sha `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7`; no checkout mutation; final head unchanged.
- Dirty/local-only state and owned files: repository untouched. Owned outputs under `/work/out/` listed in `result.json`.
- Applicable instruction/skill paths and effective discovery: `/work/AGENTS.md` (container adaptation: no `vps-nav`), `/work/ROLE.md`, `/work/packet.json`, `/repo/AGENTS.md`, `/repo/packages/cli/AGENTS.md`, `docs/CURRENT.md` (D19 readiness), `docs/decision-log.md`, `rfcs/0002-autonomous-canon.md` (binding; not restated), `rfcs/0000-constraints.md`, `docs/architecture.md`, `docs/local-app.md`, `docs/product-context.md` present. Skills: orient-repository, issue-pickup-execution, ux-dx-ax-parity, test-strategy, handoff-work. Issue #458 body not available in this archive (GitHub not queried).
- What changed and why: no public product behavior changed. Prepared an element/action/focus table with exact selectors and a neutral browser-check draft for P045.
- Ownership/dependencies: feeds P045. P006 owns canonical docs. P003 evidence design, P015 source-B, Astra/doctor reserved. No overlapping write paths in this lane.

| Check | Exact command, head, runtime, time and evidence | Result |
| --- | --- | --- |
| Focused/public behavior | `cd /repo && bun test ./packages/cli/test/app-client.test.ts` on archive `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7`; bun 1.3.14 (0d9b296a); 14 pass / 0 fail / 60 expect(); 56.00ms; exit 0. Covers privacy/session/setup/search-field identity, **not** tab/focus. | PASS (existing suite only) |
| Static keyboard inventory | `bun /work/out/static-keyboard-focus-inventory.ts` at 2026-09-06T21:47:38Z; bun 1.3.14; exit 0; wrote `static-keyboard-focus-inventory.json`. Inventory, not an a11y pass. | PASS (inventory) |
| Owner browser-check draft | `bun /work/out/browser-check-keyboard-focus.draft.js`; no `window`; labeled UNEXECUTED. Missing graphical browser / DISPLAY / Playwright. Packet forbids private browsers. | NOT_RUN |
| Package/type/full gate | `bun test` workspace, `bunx tsc --noEmit`, `bash scripts/verify.sh` | NOT_RUN (not assigned; no source change; no test slot claimed) |
| Privacy/diff integrity | No repo diff. Draft uses synthetic selectors only. No vault/credentials printed. | PASS (no product diff) |
| Independent review | Not assigned. Self-review is not C2. | NOT_RUN |
| Retained package/consumer | None. | NOT_RUN |

Findings first, severity ordered:

- **F1** `packages/cli/src/app/ui/client.js:412-413` — Ctrl/Cmd+K is not gated on `dialog.open`; `navigate` re-renders the view behind a modal. Invariant: modal owns keyboard until closed. Fix: return when `dialog.open`.
- **F2** `client.js:126-130,412-413` — shortcut always `render()`s, replacing `#memory-query` / `#setup-path` and dropping live typing. Invariant: shortcut focuses search without destroying input. Fix: focus existing field; skip `navigate` when already on memory.
- **F3** `client.js:221-222` — `showModal()` before fields/actions exist; initial focus is `button[aria-label="Close dialog"]`. Invariant: first focus is the first complete meaningful control. Fix: append then `showModal()`, or focus the first field.
- **F4** `index.html:24` + `app.css:3` `main{outline:none}` — skip-link landing has no visible focus. Invariant: visible keyboard focus. Fix: `#main:focus` outline.
- **F5** search `outline:none!important` with group `:focus-within` — alternative indicator exists; contrast unobserved.
- **F9** Ctrl/Cmd+K `preventDefault`s when `#memory-query` is absent.
- **F6/F11/F12** documented in `keyboard-focus-map.md` (non-form dialogs; render() focus loss; no `data-source-key`).

Confirmed from source. Browser Tab order, native trap/restore, and skip-link fragment focus remain untested concerns.

Remaining risk: no browser observation; issue #458 body unread (no `gh`); full `scripts/verify.sh` not run; no independent model review. Next smallest action: P045 implements F1–F4 against this map, extending `app-client.test.ts` focus recording without duplicating existing cases; owner may run the unexecuted browser draft on a throwaway vault.

Do not infer integrated, released, live-account tested, or unfamiliar-user accepted. No credentials, private records, or owner-vault paths.
