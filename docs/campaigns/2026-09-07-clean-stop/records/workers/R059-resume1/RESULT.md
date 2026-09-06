# Result R059

Outcome: FINDINGS. Scope: independently specified ASCII and common Unicode IMAP folder-name round-trip fixtures for `decodeModifiedUtf7`; no repository source change.

- Repository/worktree/branch: read-only `/repo` git archive; no Git metadata. Packet owner `grok-R059`. Write scope `/work/out` only.
- Base, input head, final head and tree: `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7` (FLEET-SOURCE-IDENTITY.json). No product HEAD movement.
- Dirty/local-only state and owned files: repository untouched. Owned outputs listed below.
- Applicable instruction/skill paths and effective discovery: `/work/AGENTS.md`, `/work/ROLE.md`, `/work/packet.json`, `orient-repository`, `issue-pickup-execution`, `connector-work`, `test-strategy`, `packages/connectors/AGENTS.md`, `docs/CURRENT.md`, RFC 0002. Host `vps-nav` / git fetch not run (controller forbids them in this container).
- What changed and why: preparation corpus + draft encoder + executed local round-trip against the product decoder. Public IMAP contract unchanged.
- Ownership/dependencies: feeds P057, P058. Shared registry, connector interface, lockfiles, P003/P015/P006 untouched.

| Check | Exact command, head, runtime, time and evidence | Result |
| --- | --- | --- |
| Focused/public behavior | `bun /work/out/roundtrip.ts` on base `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7`, bun 1.3.14, 2026-09-06T22:02:50Z, exit 0, `/work/out/roundtrip-results.json` (17/17) | PASS |
| Existing decoder tests | `bun test packages/connector-imap/test/utf7.test.ts` in `/repo`, bun 1.3.14, exit 0, 10 pass / 0 fail | PASS |
| Package/type/full gate | `bun run typecheck` / `bun run verify` | NOT_RUN (no source change) |
| Privacy/diff integrity | Synthetic folder names only; `/repo` unmodified | PASS |
| Independent review | not assigned | NOT_RUN |
| Retained package/consumer | no native/account artifact | NOT_RUN |

Findings first, severity ordered:

1. **info** `packages/connector-imap/src/imap/utf7.ts` — product is decode-only. Read-only IMAP stores LIST wires (`sign-in.ts:130-147`, `mailbox.ts:148-221`). Keep the draft encoder as a test helper unless a later packet creates mailboxes.
2. **info** `packages/connector-imap/test/utf7.test.ts:6-15` — seven legitimate decode vectors already PASS. Do not add another decode-only copy; round-trip those rows and add the ten new corpus ids.
3. **info** `folderLabel` / unicode LIST is untested. Fixture `&AOk-quipe` (`testing/index.ts:75`) is `\Noselect` and skipped. Optional later; out of this encoding-only packet.

Remaining risk: full gate and independent review unrun; no live IMAP. Next smallest action: P057/P058 consume `/work/out/mailbox-name-roundtrip-fixtures.json` as a table-driven round-trip test.

Owned files: `mailbox-name-roundtrip-fixtures.json`, `encode-modified-utf7.ts`, `roundtrip.ts`, `roundtrip-results.json`, `existing-coverage.json`, `source-evidence.md`, `RESULT.md`, `result.json`.
