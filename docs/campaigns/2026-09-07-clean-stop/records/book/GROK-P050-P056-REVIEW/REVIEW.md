# P050 / P056 bounded independent review

Checked 2026-09-06 at 22:07 UTC against source `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7` and the completed P050/P056 output artifacts. This source is the fleet composition, not a claim about public main. Archive identity: `187e004334b2aa998dd3ac9d29057e1725d635a00faab24d75bf092eef8b8f36`.

**One production correction is ready for a narrow owner assignment: IMAP continued filename decoding. Gmail has a useful additional coverage task, but this review did not establish a production history defect.** The tasks are in [implementation-packets.json](implementation-packets.json). No production files, controller, worker outputs, accounts, or remote state were changed by this review.

## P056: confirmed ordinary MIME fidelity gap

`packages/connector-imap/src/mime/parse.ts:77` sorts continued parameters, but lines 101–103 decode each segment into text before concatenating. `decodeExtended` at line 109 reads a charset only from the segment being decoded; later segments normally carry no charset declaration. Thus a later ISO-8859-1 octet is decoded as UTF-8, and a UTF-8 character spanning two segments is decoded as two incomplete byte sequences.

RFC 2231 sections 3 and 4.1 define one continued parameter value with one charset declared at its beginning; encoded and unencoded continuation segments may be mixed. The resulting value must preserve that charset across the complete sequence. [RFC 2231](https://www.rfc-editor.org/rfc/rfc2231)

The pure local parser check used Bun 1.3.14, matching the source package manager. It imports the exact immutable source directly and uses ordinary attachment names. It performed no network or mailbox operations. Exit status was **1**, correctly recording the mismatch:

| Ordinary case | Expected | Observed in both filename and Content-Type name |
| --- | --- | --- |
| Existing whole UTF-8 character fixture | `café report.pdf` | `café report.pdf` |
| Latin-1 charset used by later continuation | `café.txt` | `caf�.txt` |
| UTF-8 character bytes cross continuations | `café.txt` | `caf��.txt` |
| Latin-1 encoded pieces plus plain suffix | `café.txt` | `caf�.txt` |

Receipt: [imap-filename-check.json](imap-filename-check.json). Check source: [imap-filename-check.ts](imap-filename-check.ts). This confirms the parser fidelity failure. The public attachment consequence follows statically from `packages/connector-imap/src/events.ts:153`, which consumes these already-decoded names; an event-level assertion is required in the implementation packet.

P056's MIME JSON is a characterization of the implementation. Its `_generate-oracles.ts` imports `messageEvent` and `fixtureEvents`, and its Markdown explicitly says the expected records were generated from them. It is useful inventory, but it cannot independently establish the correctness of the producing decoder. Its existing continued-name example also keeps the whole non-ASCII character in one segment, like `test/mime/parse.test.ts:40`, and misses this defect.

Assign P057 only `src/mime/parse.ts`, `test/mime/parse.test.ts`, and `test/events.test.ts` in the IMAP package. Decode the ordered continuation as one byte sequence using its declared charset; retain supported simple parameters, literal unencoded segments, parameter ordering independence, and existing bounds. Independently author expected Unicode and one ordinary multipart attachment event. This does not require mailbox access, an auth mechanism, CLI work, cursor changes, or an architectural decision.

## P050: existing history machinery, narrow coverage gap

The following existing code and tests were inspected on f57:

| Behavior | Current implementation | Existing coverage |
| --- | --- | --- |
| Expired history starts a bounded full rescan and marks an unreconciled deletion gap | `connector.ts:242`, `connector.ts:267` | `test/connector.test.ts:50` covers one missing message and expiry |
| Multiple history pages keep their starting anchor until the final page | `connector.ts:291` | `test/boundaries.test.ts:55` covers 25 explicit deletions |
| Pending plan is persisted before output, with retry fingerprints and bounded batches | `connector.ts:296`, `connector.ts:312`, `connector.ts:356` | `test/connector.test.ts:16` covers snapshot reconnect; `test/live-retry.test.ts:50` covers a normal 25-item history response |
| Missing message GET records missing coverage rather than inventing a tombstone | `connector.ts:347`, `connector.ts:367` | `test/connector.test.ts:50`; `test/boundaries.test.ts:97` |

The paths in this table are under `packages/connector-gmail/`. Inspection establishes that these mechanisms exist; it is not a fresh execution receipt for those tests.

Google requires a full synchronization after an expired history ID produces HTTP 404. Its history reference documents ordered, noncontiguous history IDs and retaining the returned anchor after pagination completes. [Gmail sync guide](https://developers.google.com/workspace/gmail/api/guides/sync), [history.list reference](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.history/list)

The minimum additional task is **test-only composition coverage**: an expired history cursor causes a rescan of more than one batch, the process reconnects between batches, an ordinary retry stays identical, all surviving records are recovered once across the completed rescan, the gap remains visible, and a subsequent ordinary label update resumes from the new anchor. Include one previously seen message that is absent during the expired interval and verify the rescan does not invent its deletion. Use the existing `GmailFixture` and one new file, `test/fleet-history-resync.test.ts`; do not modify shared fixtures or production source as part of that initial grant.

This coverage task is runnable with a prepared ordinary repository test environment and no account access. It has not been executed by this review. A newly discovered normal-behavior failure must be routed back to the single Gmail owner for a precise source correction. Do not create a history rewrite merely to occupy P051.

Two P050 wording corrections matter before adopting its owner map:

- Google's installed-app guide says incremental authorization is unsupported. That supports avoiding incremental-scope assumptions; it does **not** itself require two OAuth client registrations or forbid a combined initial scope request. Kizuki's separate product authorizations and source grants are the current product contract and remain in force. [Google native-app OAuth guide](https://developers.google.com/identity/protocols/oauth2/native-app)
- Source inspection establishes the lack of a compiled-in client configuration on f57. It cannot establish that no registered Google project/client or verification exists outside the repository. External project configuration and verification remain **unverified**, not disproved by this packet.

This review does not certify all P050 provider-verification claims, credential custody behavior, or P056 provider support matrices. None is needed to begin the two scoped tasks above.

## Ownership and dependency reconciliation

| Existing packet | Disposition |
| --- | --- |
| P051 Gmail/shared Google | Preserve one shared OAuth owner. Assign the narrow Gmail coverage file as a named child of P051; its completion neither completes shared OAuth architecture nor unlocks real Gmail qualification. No core auth, browser, enrollment, grant, schema, or state-format writes. |
| P052 real Gmail | Keep real account, configured application, accepted package, and evidence producer dependencies. Local coverage does not satisfy it. |
| P053 Calendar temporal QA | Separate Calendar-only test file remains its own scope. |
| P054 Calendar implementation | Consume the approved shared contract; no `core/src/auth/*`, shared browser, shared `connections.ts`, or `connect.ts` grant. Calendar-specific work does not wait for unrelated Gmail test execution when its own accepted prerequisites are satisfied. |
| P055 real Calendar | Keep external account/application and actual package qualification gates. |
| P057 IMAP | Narrow to the three MIME files above. The roster's `packages/cli/src/commands/connect-imap.ts` does not exist on f57; actual IMAP routing is in shared `connect.ts`, which this task does not need. |
| P058 real IMAP | Keep the authorized mailbox, accepted package, and independent real-server evidence requirements. A filename fix does not qualify flags, UIDVALIDITY, or provider authentication. |

Related R054–R056 and R059–R062 entries are frozen-source output-only reviews/drafts, not production file ownership. This packet does not grant them source writes or restart any worker. Root still assigns the concrete production/test owner after live reconciliation.

The broader C4 stranger onboarding/application configuration gap remains separate from these source-level tasks. No compiled-in credentials, Google project creation, broader consent, IMAP OAuth, or architecture migration is proposed here.
