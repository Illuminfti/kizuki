# Result R025

Outcome: FINDINGS. Scope: read-only preparation of canon vs agent audit pagination/ordering and empty-versus-unavailable shapes; no repository edits.

- Repository/worktree/branch: `/repo` git archive of `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7` (no Git metadata; remote not verified in this container).
- Base, input head, final head and tree: base = input = `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7`; archive sha256 `187e004334b2aa998dd3ac9d29057e1725d635a00faab24d75bf092eef8b8f36`. No source HEAD movement.
- Dirty/local-only state and owned files: repository untouched. Owned outputs only under `/work/out`.
- Applicable instruction/skill paths and effective discovery: `/work/AGENTS.md`, `/work/ROLE.md`, `/work/packet.json`, `orient-repository`, `issue-pickup-execution`, `test-strategy`, `handoff-work`; binding `docs/CURRENT.md`, `docs/decision-log.md`, RFC 0002 §7.3, `docs/cli.md` audit/agent, scoped `packages/core/AGENTS.md` and `packages/cli/AGENTS.md`.
- What changed and why: preparation artifacts only. Public behavior documented, not changed. Two classes: canon `listAuditReceipts` for `kizuki audit` / TUI / app `activity`; agent `listAuditPage` with no user CLI verb.
- Ownership/dependencies: feeds P043, P045. P003/P015/P006/Astra remain reserved. Review/rebase before production use.

| Check | Exact command, head, runtime, time and evidence | Result |
| --- | --- | --- |
| Focused/public behavior | `bun /work/out/scripts/audit-pagination-goldens.ts` on base `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7`, Bun 1.3.14, 22 PASS, `/work/out/checks.json` | PASS |
| Package/type/full gate | `bun test` / `bunx tsc --noEmit` / `bash scripts/verify.sh` | NOT_RUN (no node_modules; no test slot) |
| Privacy/diff integrity | no source diff; goldens are synthetic ids/paths only | PASS (static) |
| Independent review | not assigned | NOT_RUN |
| Retained package/consumer | none | NOT_RUN |

Findings first, severity ordered:

1. `packages/cli/src/commands/audit.ts:53-76` — CLI/app audit lists have no truncated/next signal; TUI does. Silent tail drop past 5000/50. Independent expect: a non-final page must say so.
2. `packages/core/src/canon/receipts.ts:216,238-240` and `packages/core/src/agents/audit.ts:723-732` — missing table, contested-without-claims, unknown agent, and limit 0 present as empty success. Vault-unavailable (exit 1 / `no_vault`) stays distinct. TUI already splits “no writes yet” from filter miss; CLI JSON does not.
3. Canon `limit: 0` becomes one row (`receipts.ts:217`); agent `limit: 0` is empty and shares the unknown-name branch.
4. No `kizuki agent audit` verb (`packages/cli/src/commands/agent.ts:86`). Keep agent rows off user `kizuki audit`.

Existing tests already cover canon offset walks and agent cursor walks; do not duplicate them (`/work/out/existing-coverage.md`).

Remaining risk: CLI process and package tests NOT_RUN (missing workspace install). Offset staleness untested. Next smallest action: P043/P045 consume `/work/out/row-type-ordering-table.md` and `/work/out/goldens/` after review/rebase.

No merge, deploy, publication, credentials, private records, or owner-vault paths.
