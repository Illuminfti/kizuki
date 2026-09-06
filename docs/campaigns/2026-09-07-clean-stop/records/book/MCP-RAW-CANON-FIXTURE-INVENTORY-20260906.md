# MCP raw-canon fixture inventory

Four additional tests have explicit positive canon expectations backed only by raw files. One further transport test has the same invalid premise without asserting positive content. These are static findings; root should use full-suite failure receipts before assigning any repair.

Compared f57 `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7` with accepted integration `3dfefd2810cec850b110343ea2973928a0b0a823` at `WORKTREES/kizuki-grok-integration-20260906`. All nine MCP test/support files and the existing Core recordedPage helper are byte-identical between these commits; inspected integration working bytes match. No tests, product commands, credential flows, transport exercises or fixes were run. P104's active files were not modified.

`packages/mcp/test/helpers.ts:66–104` writes Ada, the private kettle page and the unlabeled page without sources or writer receipts. The accepted event at lines 107–122 is separate. As established by the P104 review, a raw file does not supply a source-backed recorded revision.

| Consumer | Positive expectation and recommended disposition |
| --- | --- |
| `packages/mcp/test/server.test.ts:43` | The privileged reader must find `fact:kettle` at line 53. Use a valid recorded private page; keep the personal-reader exclusion and unlabeled-page exclusions. |
| `packages/mcp/test/server.test.ts:87` | Canon search must return Ada at line 92 while timeline remains quoted-only. Use recorded neutral prose with real provenance; preserve the single-event timeline and both channel assertions. |
| `packages/mcp/test/credential-stdio.test.ts:145` | The qualified process case requires Ada prose at line 162, then its absence after narrowing. Use a recorded positive page with the intended effective sensitivity and subject. Preserve qualification gating, private-content exclusion, grant/revocation and redaction checks. |
| `packages/mcp/test/stdio.test.ts:219` | The separate raw `fact:long` file is expected to yield a canon excerpt at line 262. Its fixture also lacks provenance/revision. Retain as a root-scoped transport follow-up; this inventory proposes no timing/resource exercise. |

`stdio.test.ts:173` similarly writes raw `fact:wide`, but asserts termination only. It can therefore succeed without demonstrating its intended positive-canon premise. Do not count it as observed failure or transport proof. P104 owns `schema.test.ts`: its known chunk failure and the isError-only loop at line 35 are recorded separately and excluded from new repair ownership.

Preserve the deliberate negative controls. `fact:unlabeled` is intentionally excluded at `server.test.ts:50,54`; do not turn it into valid canon. Private-page exclusions and post-narrowing absence must continue to exercise their intended restrictions once a positive page exists. I found no MCP test explicitly asserting that an otherwise labeled raw owner file is withheld specifically because its revision is unrecorded; current absence assertions should not be advertised as that proof.

The ordinary repair approach is an opt-in positive fixture builder using `packages/core/test/helpers/recorded-page.ts`, which creates real synthetic evidence, a claim and a receipted write. Use fresh page paths/IDs, retain concrete inclusion/exclusion assertions, and rebuild the existing derived indexes for search consumers. Direct get_page needs no index rebuild. Where the timeline must retain one event, use the appropriate existing event as explicit sourceIds and verify effective sensitivity; never lower grants or source floors to force a pass.

Do not convert every mcpFixture consumer globally. Proposal tests assert exact claim counts (`server.test.ts:117`), and correction tests require no materialized rewrite (`:166–169`). A global writer seed can change those premises. Principal/version/startup tests need no positive canon. The lexical-floor test's positive text is an accepted ledger event (`stdio.test.ts:137`), and two-client continuity uses imported source files and claim-only context, so neither is a raw positive-page repair.

No admission changes, fabricated receipts, weakened assertions, new repair assignments or claims of passing tests follow from this inventory. Detailed hashes and classifications are in `MCP-RAW-CANON-FIXTURE-INVENTORY-20260906.json`.
