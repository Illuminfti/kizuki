# Result R030

Outcome: FINDINGS. Scope: inventory of how ordinary `source_record_id` and Core machine-origin stamps are recorded, serialized, and diagnosed when missing — no repository edits, no self-ingest injection.

- Repository/worktree/branch: read-only git archive `/repo` (no Git metadata). Packet owner `grok-R030`. Write scope `/work/out` only.
- Base, input head, final head and tree: `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7` (FLEET-SOURCE-IDENTITY.json). No source HEAD movement. Archive sha256 `187e004334b2aa998dd3ac9d29057e1725d635a00faab24d75bf092eef8b8f36`.
- Dirty/local-only state and owned files: repository untouched. Outputs only under `/work/out`.
- Applicable instruction/skill paths and effective discovery: `/work/AGENTS.md`, `/work/ROLE.md`, `/work/packet.json`; `/work/.grok/skills/orient-repository`, `issue-pickup-execution`, `test-strategy`, `handoff-work`; `/repo/AGENTS.md`, `docs/CURRENT.md`, `docs/decision-log.md`, `rfcs/0002-autonomous-canon.md`, `rfcs/0000-constraints.md`, `docs/architecture.md`, `docs/event-identity-origin.md`, `packages/core/AGENTS.md`, `packages/connectors/AGENTS.md`. Remote GitHub/live worktree state was not fetched (controller owns host navigation).
- What changed and why: no product behavior change. Produced an origin field-lineage table and neutral serialization fixtures with expected classifications.
- Ownership/dependencies: feeds P029, P067, P087. P003 retains shared evidence design; P015 retains source-B schema/recovery/authority/export; P006 owns canonical docs. No native/account/model/human qualification claim.

| Check | Exact command, head, runtime, time and evidence | Result |
| --- | --- | --- |
| Focused/public behavior | `cd /repo && bun test packages/core/test/event-causal-origin.test.ts packages/core/test/event-identity.test.ts packages/core/test/event.test.ts` on base `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7`, bun 1.3.14, 167 pass / 0 fail / 652ms | PASS |
| Local classifier | `cd /repo && bun --no-install /work/out/classify-origin-fixtures.ts` exit 0; receipt `/work/out/checks/classify-receipt.json` | PASS |
| Connector source-id tests | `bun test packages/connectors/test/source-id.test.ts packages/connectors/test/native-identifier-compat.test.ts` | NOT_RUN (archive cannot resolve `@kizuki/connector-beeper` / `@kizuki/core`) |
| Vault-backed origin tests | `bun test packages/core/test/event-identity-migration.test.ts packages/core/test/event-backup-v2.test.ts packages/core/test/loop/self-ingest.test.ts` | NOT_RUN (`canon_files_unsafe` on this tmpdir) |
| Package/type/full gate | `bun run typecheck`; `bun run verify` | NOT_RUN (not assigned; archive lacks workspace installs) |
| Privacy/diff integrity | No source edits; fixtures are synthetic (`the kettle is on`, `rec-1`, marker substring only as the documented classifier input) | PASS |
| Independent review | Not assigned. C2 independent-model lens remains root's. | NOT_RUN |
| Retained package/consumer | None. Preparation artifacts only. | NOT_RUN |

Findings first, severity ordered:

1. **Confirmed — source_record_id bound mismatch (high for identity persistence).** Ingress and architecture permit 1_048_584 UTF-8 bytes (`packages/core/src/contracts/event.ts` 16–18; `docs/architecture.md` 109–114; `event.test.ts` byte-limit cases PASS). Ledger v17 STRICT `events` checks `length(source_record_id) BETWEEN 1 AND 512` (`packages/core/src/ledger/schema-v16.ts` 20). Local `accept()` of a 513-ASCII id that passed `validateEventInput` threw `LedgerStoreError` `ledger store is unavailable (SQLITE_CONSTRAINT_CHECK)` (`code=infrastructure`). Affected invariant: opaque native identifiers must survive enrollment. Smallest correction: align the STRICT CHECK (and `LEDGER_ID_MAX`-style helpers) with `EVENT_LIMITS.sourceRecordIdBytes`, or fail closed at ingress with a field-named error. Owner: not this packet (P015 / schema lane). Do not add a duplicate ingress-limit test.

2. **Confirmed — missing-field diagnostics are seam-dependent (medium, diagnostic honesty).** Missing `source_record_id` is named at ingress. Missing `origin` / `origin_binding` / `text_hash` on a current stored record is opaque `event record is invalid`. SQL omit is `event identity fields are required`. Persistence CHECK failure is an infrastructure exception, not `status: "error", kind: "validation"`. Existing coverage: `event.test.ts:89-93`, `event-identity-migration.test.ts:134-143`, `event-causal-origin.test.ts:54-67`.

3. **Hypothesis, not a new defect — related 128 vs 256 identifier CHECKs.** STRICT `connector_id`/`kind` length 128 vs ingress 256. Not executed beyond static schema read.

Remaining risk: connector and vault-backed suites were not product-executed here. Exact matching still cannot detect paraphrases (documented in `docs/event-identity-origin.md`). Next smallest action: P029/P067/P087 consume the lineage table and fixtures; a named schema owner should resolve the 512-character CHECK before treating 1 MiB native ids as durable.

No merge, deploy, publication, or qualification claim.
