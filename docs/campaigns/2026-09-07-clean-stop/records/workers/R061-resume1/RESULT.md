# Result R061

Outcome: FINDINGS. Scope: IMAP body transfer-encoding + charset golden corpus and pure decoder draft for P057; no product source edits.

- Repository/worktree/branch: read-only git archive `/repo` of `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7` (FLEET-SOURCE-IDENTITY.json). No Git metadata. Write scope `/work/out` only.
- Base, input head, final head and tree: base `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7`; this lane did not move HEAD; repository files unchanged.
- Dirty/local-only state and owned files: only `/work/out/*` written. No product paths touched.
- Applicable instruction/skill paths and effective discovery: `/work/AGENTS.md`, `/work/ROLE.md`, `/work/packet.json`, `orient-repository`, `issue-pickup-execution`, `connector-work`, `test-strategy`; binding `docs/CURRENT.md`, `docs/decision-log.md`, RFC 0002; scoped `packages/connectors/AGENTS.md`.
- What changed and why: preparation artifacts only — independently specified multilingual transfer-encoding fixtures and a pure RFC 2045/4648 decoder draft. Product IMAP connector is live-sync (`kizuki.imap`); this packet tests local MIME byte conversion, not a mailbox.
- Ownership/dependencies: feeds P057. P056 MIME protocol oracle not duplicated. P003/P015/P006/Astra reserved. Shared registry/lockfiles untouched.

| Check | Exact command, head, runtime, time and evidence | Result |
| --- | --- | --- |
| Focused/public behavior | `bun test /repo/packages/connector-imap/test/mime/transfer.test.ts` at base `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7`, bun 1.3.14 (`0d9b296a`), 2026-09-06: 12 pass, 0 fail, 34 expects, exit 0 | PASS |
| Draft vs independent corpus | `bun /work/out/run-golden-corpus.ts` bun 1.3.14: 49/49 draft pass, 49/49 product pass, RFC 4648 `Zm9vYmFy` match, exit 0; evidence `/work/out/golden-corpus-run.json` | PASS |
| Package/type/full gate | Not assigned; this archive has no `node_modules` / `@kizuki/core` workspace install | NOT_RUN |
| Privacy/diff integrity | No product diff; corpus is synthetic ordinary greetings; no credentials | PASS |
| Independent review | Not assigned | NOT_RUN |
| Retained package/consumer | N/A (preparation only) | NOT_RUN |
| events.test.ts fixture path | `bun test /repo/packages/connector-imap/test/events.test.ts` → `Cannot find module '@kizuki/core'` | NOT_RUN |

Findings first, severity ordered:

1. **Limitation (existing, now independently specified).** `decodeCharset` (`charset.ts:14–25`) falls back to windows-1252 when Bun has no decoder. `iso-8859-2` `łódź` (QP `=B3=F3d=BC`) independently decodes to `łódź` but the product yields `³ód¼` with `fallback: iso-8859-2`. `windows-1251` `Привет` (bytes `cf f0 e8 e2 e5 f2`) independently decodes to `Привет` but the product yields `Ïðèâåò` with `fallback: windows-1251`. The in-tree iso-8859-2 test (`transfer.test.ts:64–67`) uses byte `0xE9`, which is é in both maps, so it does not catch this. ibm866 `Привет` **does** decode correctly on this Bun.

2. **No transfer mismatch.** Product `decodeTransfer` matched independently encoded RFC 2045/4648 bytes for all 49 new vectors, including Japanese Shift_JIS/ISO-2022-JP, GBK `你好` (`c4 e3 ba c3`), EUC-KR `안녕` (`be c8 b3 e7`), and the official QP soft-break example.

Remaining risk: events-layer composition (`normalizeBody`, subject join) was not executed here. Full `bun test` / typecheck / `scripts/verify.sh` NOT_RUN. No live IMAP. Artifacts must be reviewed/rebased before production use.

Next smallest action: P057 lands focused `decodeTransfer`+`decodeCharset` tests from `/work/out/transfer-encoding-golden-corpus.json` `vectors`, skipping `already_covered`.
