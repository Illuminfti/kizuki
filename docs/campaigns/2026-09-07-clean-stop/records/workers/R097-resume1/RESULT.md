# Result R097

Outcome: FINDINGS (preparation complete). Scope: inventory of supported prior schema/backup/release-fixture versions, actual upgrade entry points, native-owner command/observation matrix, and a neutral fixture manifest. No repository source edits. No new schema. Existing tests untouched.

- Repository/worktree/branch: read-only git archive `/repo` of `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7` (`FLEET-SOURCE-IDENTITY.json`). No Git metadata. Host navigation/fetch not run (controller-owned).
- Base, input head, final head and tree: base_sha `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7`; this worker did not move HEAD; `/work/out` only.
- Dirty/local-only state and owned files: repository unmodified; outputs listed below.
- Applicable instruction/skill paths and effective discovery: `/work/AGENTS.md`, `/work/ROLE.md`, `/work/packet.json`, `orient-repository`, `issue-pickup-execution`, `migration-work`, `release-readiness`, `handoff-work`; binding `docs/CURRENT.md`, `docs/decision-log.md` D19, RFC 0002. RFC 0002 §18.1 still says “Current schema_version is 2” while code is 19 — docs mismatch for P006, not restated as current.
- What changed and why: preparation artifacts only. Public behavior is already: `openLedger` migrates 1→19 in one transaction; backup restore rebuilds a current vault; agent `--dry-run` refuses `migration_required`.
- Ownership/dependencies: P015 schema/recovery implementation; P003 evidence design; P006 docs; P028/P091/P092 consume this matrix; Astra/external doctor reserved.

| Check | Exact command, head, runtime, time and evidence | Result |
| --- | --- | --- |
| Focused/public behavior | `bun /work/out/local-check-upgrade.ts` on archive `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7`, Bun 1.3.14, 2026-09-06T22:01:44Z, `/work/out/local-check-receipt.json` | PASS for version stamp, ledger15/16 in-place, future refuse, backup verify. Restore `canon_files_unsafe`. |
| Package/type/full gate | `bun test` / `bun run typecheck` / `bash scripts/verify.sh` | NOT_RUN (would write outside `/work/out`; not assigned) |
| Privacy/diff integrity | Static: fixtures are synthetic; doctor must not echo event bodies (`legacy-ledger.test.ts:39`); backups exclude credentials (`agent-enrollment-backup.test.ts:169`) | NOT_RUN as a suite; cited |
| Independent review | Not this packet | NOT_RUN |
| Retained package/consumer | `dist/` absent; compiled `./kizuki` upgrade journey | NOT_RUN |
| Existing exact cases | Cited in `/work/out/existing-coverage.json` | static; not duplicated |

Findings first, severity ordered:

1. **Verification gap (confirmed for this archive):** compiled native prior-schema upgrade is unexecuted. `scripts/smoke-release.ts` and `scripts/artifact-proof.ts` only `init` a fresh vault. `lifecycle.<target>` is `NOT_IMPLEMENTED` (`scripts/go-no-go.ts:156`). Missing input: retained `dist/kizuki-<version>/bun-linux-x64-baseline/kizuki` built from this SHA.
2. **Platform limit (confirmed here, not a contract failure):** `restoreVault` of the genuine ledger16 backup threw `CanonFilesError: canon_files_unsafe` in this sandbox. Expected on a qualified Linux x64 owner-only ancestry: restore `events=1` then `openLedger` reports version 19 (`agent-enrollment-backup.test.ts:144-166`).
3. **Coverage gap (confirmed by inventory):** genuine writer dumps exist only for ledger **15** (SQL) and **16** (SQL + backup-v3). v1–v14, v17, v18 are reconstructed tests or transitive. v5, v6, v11–v14 have no start-version fixture. P015 owns any new dump/migration; this packet does not add one.
4. **Docs stale (hypothesis for P006):** RFC 0002 §18.1 line 2667 still says current `schema_version` is 2. Code `LEDGER_SCHEMA_VERSION` is 19 (`packages/core/src/ledger/db.ts:188`). Do not treat the RFC sentence as the live stamp.

Remaining risk, failed/interrupted checks, unavailable accounts/platforms, and next smallest action: no compiled binary, no native lifecycle producer, restore not qualified in this sandbox. Next: P028 run the native-owner command list against a retained Linux x64 package using the in-tree ledger15/16 fixtures; do not duplicate core tests.

No credentials, private records, or owner-vault paths.
