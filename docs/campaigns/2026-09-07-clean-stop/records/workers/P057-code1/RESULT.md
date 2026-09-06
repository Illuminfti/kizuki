# Result P057

Outcome: IMPLEMENTED (draft candidate, awaiting_root_test). Scope: IMAP RFC 2231 continued attachment filenames now decode as one value with the charset declared on the first encoded segment.

- Repository/worktree/branch: `/repo` on `agent/grok-p057`
- Base, input head, final head and tree: base `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7`; final head `85778e3f343f854e227f744aff0c13a47051278f`
- Dirty/local-only state and owned files: clean; only the three packet write_paths changed
- Applicable instruction/skill paths and effective discovery: packet P057, connector-work, implement-change, test-strategy, elegance-review; RFC 2231 §§3 and 4.1; review receipt in `GROK-P050-P056-REVIEW`
- What changed and why: `normalizeParams` reassembles continuation octets in numeric order and decodes once. Later ISO-8859-1 pieces and UTF-8 characters split across segments keep their declared charset. Unencoded pieces, including a percent sign, stay literal. Simple unencoded parameters and single `filename*=` values are unchanged.
- Ownership/dependencies: this lane owns only the three MIME files. P051 history coverage is not this assignment. P058 real IMAP qualification remains separate.

| Check | Exact command, head, runtime, time and evidence | Result |
| --- | --- | --- |
| Focused/public behavior | Requested `bun test packages/connector-imap/test/mime/parse.test.ts packages/connector-imap/test/events.test.ts` on `85778e3f343f854e227f744aff0c13a47051278f`; Bun 1.3.14; `test-request.json` request_id `p057-mime-continued-charset` | NOT_RUN / awaiting_root_test |
| Package/type/full gate | Not executed in this network-enabled agent container | NOT_RUN |
| Privacy/diff integrity | Diff limited to owned write_paths; synthetic filenames only; no credentials or mailbox access | PASS (static) |
| Independent review | Required on the exact head after tests | NOT_RUN |
| Retained package/consumer | Not a packaging task | NOT_RUN |

Findings first, severity ordered: the continued-filename charset loss is addressed in the candidate. Existing assertions were preserved. Expected Unicode strings are authored in the tests, not generated from `messageEvent`.

Remaining risk, failed/interrupted checks, unavailable accounts/platforms, and next smallest action: focused tests and repository gates are root-owned and have not run here. Next step is those tests on `85778e3f343f854e227f744aff0c13a47051278f`, then independent review. Real IMAP qualification stays with P058.
