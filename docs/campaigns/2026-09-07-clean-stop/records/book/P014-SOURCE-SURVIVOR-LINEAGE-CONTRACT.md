# P014 source-survivor lineage contract

Status: implementation-ready contract submitted for independent review, 6 September 2026. Root selected the design below. Independent approval is required before root freezes this contract for P015; this document does not assert that approval or implement production behavior.

Pinned implementation base: `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7`, tree `8ec4dd36ba80041c13cdf75f09fc17fa8e0e25c0`, clean `WORKTREES/kizuki-fleet-base-20260906`. The earlier diagnosis inspected a7e; the relevant authority/intent/apply paths remain unchanged at f57. P015 solely owns this migration, checkpoint, intent/recovery, resolver, portable stream, and their tests. Other workers must not independently change those contracts.

## Durable record

Create `canon_source_survivor_lineage` as a STRICT SQLite table. Every column is NOT NULL. Its exact column and portable JSON key set is:

| Field | Representation and validation |
| --- | --- |
| `version` | Integer exactly `1`; booleans and numeric strings are invalid. |
| `kind` | String exactly `source_survivor`. |
| `child_receipt_id` | TEXT primary key; foreign key to `canon_receipts(receipt_id)`. |
| `predecessor_receipt_id` | TEXT foreign key to `canon_receipts(receipt_id)`; different from child ID. |
| `before_hash` | String matching `^[0-9a-f]{64}$`. |
| `after_hash` | String matching `^[0-9a-f]{64}$`. |
| `predecessor_effective_authority` | An existing `AuthorityTier` enum value. |
| `result_authority` | An existing `AuthorityTier` enum value. |

Root's binding field vocabulary is exactly these eight names, including `predecessor_receipt_id` and `predecessor_effective_authority`; it supersedes the earlier names `prior_receipt_id` and `historical_effective_authority`, which are not accepted aliases.

IDs are nonempty, round-trip-valid UTF-8 strings of at most 1,024 bytes, without C0/C1 control characters. Preserve exact bytes: no trimming, normalization, truncation, path-derived IDs, or newly imposed ULID requirement. Use the existing authority values and ordering: `owner_correction:4`, `owner_authored:3`, `connector_evidence:2`, `model_inference:1`. Encode constant/type/hash/ID-length/unequal-ID constraints in the schema and repeat semantic validation at producer and import/read boundaries. Foreign keys use RESTRICT; no cascade silently removes lineage. Explicit row insertion is immutable: no replace/upsert that changes an existing checkpoint.

A checkpoint's authority is the existing writer's assertion of an already-proved positive transition. It is not a fabricated write receipt, owner receipt, raw-owner fallback, or cryptographic proof of historical database integrity. The checkpoint is the durable boundary that allows historical path information to be erased.

## Stage one actual survivor transition

Before writing the postimage, under the existing mutation owner, read the actual current live page through the existing owned byte interface. Require the exact preimage hash and `CanonAuthorityResolver.basis(live_path, preimage_hash)` to be non-null. The basis receipt ID must equal `original_receipt_id` selected by the staged source intent; its after-hash must equal that preimage hash. The predecessor row must still name the same live page. Archive-path coincidence does not qualify.

The actual child receipt must have `kind = purge_rewrite`, `page_action = edit`, a current non-archive live path, `archive_path = null`, `reverts = null`, `writer = loop`, `producer = deterministic`, and `model_ref = null`. Its before/after hashes must equal the actual owned preimage and serialized survivor postimage. Archive/deletion outcomes do not receive a survivor checkpoint.

Require both participating receipt timestamps to be valid under existing `isRfc3339`, at most 64 UTF-8 bytes, and finite under `Date.parse`. The predecessor must be strictly earlier under the existing ordering: parsed timestamp, then receipt ID using the resolver's code-unit comparison. Equal timestamps do not waive the ID ordering. Timestamps are validated from the existing receipt rows; they are not new checkpoint fields.

Store `predecessor_effective_authority = basis.authority`, including historically resolved purge/revert semantics. Never use the predecessor's raw `authority` as a substitute and never call `resolve()` to establish positivity.

Use the existing nonempty retained-claim set selected by source erasure. Validate its rows, existing source/purpose checks, and that none is selected for purging. Compute `result_authority` as the minimum retained-claim authority by `AUTHORITY_TIERS`, exactly as `canon/apply.ts:753–759` does today. It must equal the actual child receipt's stored authority. The result can differ from the predecessor's effective tier; this is an explicit source-survivor rule. Ordinary purge inheritance is unchanged. Freeze both authority facts; readers must not recompute historical authority from mutable claim lifecycle or grant state.

## Intent, transaction, and retry

New source-erasure intents use version `2`, retaining their existing fields and adding `lineage`, which is the exact checkpoint object for a live survivor and `null` for archive/deletion. Validate the exact version-specific shape. The entire serialized intent, including lineage, remains at most 256 KiB in UTF-8 on write and read. Check the stored byte bound before materializing or parsing it; the existing JavaScript character-count read check is insufficient for this contract.

The existing temporary `path_hash` and `original_receipt_digest` continue their current origin/recovery checks. Neither may enter the checkpoint or portable lineage stream. Every retry revalidates the stored origin, policy bindings, child identity, checkpoint fields, and current byte state. A reused receipt ID/time retains an identical checkpoint; changed content or authority is a conflict, never a replacement record.

Preserve the existing ordering: stage the validated intent; commit machine-byte admission; perform the owned expected-hash rewrite with no retained erased preimage; append or verify the one actual JSONL receipt; then, in the existing immediate SQLite transaction, validate and insert the child receipt, insert its checkpoint, update page index/holds, and delete the intent. The receipt-stream capability remains held and verified through commit. No await, callback, second canon writer, or separate lineage commit is introduced.

Any SQLite failure rolls back child, checkpoint, index/hold changes, and intent deletion together. A filesystem/log partial outcome leaves the existing recovery evidence; it never publishes a standalone checkpoint. Existing identical child/checkpoint pairs are idempotent only after the complete pair and byte/log bindings validate. A missing half, duplicate conflicting row, different intent, or mismatched postimage refuses completion and preserves recovery state.

Recovery distinguishes actual bytes equal to the saved before-hash, saved after-hash, or neither. Before-hash permits the original validated write path to retry. After-hash permits completion only with the original validated version-2 checkpoint and unchanged origin/policy bindings. Neither refuses. Do not derive a replacement checkpoint from the rewritten file. Existing per-source recovery bounds remain 10,000 intents with a 10,001st-row overflow sentinel.

Migration preserves pending version-1 intents. A legacy live-survivor intent may be upgraded only while its actual preimage bytes and still-path-bound strict basis are available and equal the saved original; perform that explicit validation before staging version 2. A legacy postimage without a checkpoint remains incomplete and withheld rather than receiving synthesized positive evidence. Legacy archive/deletion recovery retains its prior validation and emits no checkpoint.

## Resolver semantics

1. Resolve the actual current page path and exact current byte hash through the existing path-local receipt selection. A checkpoint cannot discover a page or choose another current receipt.
2. For a selected child with a checkpoint, validate exact keys/types/bounds, child ID/kind/action/writer/producer/reverts, child before/after hashes and `result_authority == child.authority`. Load its predecessor by primary-key ID and validate its ID, after-hash equal to the checkpoint before-hash, valid authority enum, and strict chronology. Allowed predecessor kinds are exactly `write`, `purge_rewrite`, and `revert`, with the existing `CanonAuthorityResolver.state` predicates (`canon/authority.ts:103–127`): `write` requires `reverts = null` and a null or valid before-hash; `purge_rewrite` requires a non-null valid before-hash and `reverts = null`; `revert` requires its `reverts` ID to name an existing, same-page, strictly earlier target, a non-null target before-hash, a valid target after-hash and authority enum, exact hash reversal (`predecessor.before_hash == target.after_hash` and `predecessor.after_hash == target.before_hash`), and a target not already visited. Apply the checkpoint and redaction rules to those checks: an unredacted predecessor path must still equal the child's path; sanitized empty paths are permitted only through explicit checkpoint/revert ID bindings and never treated as a shared page namespace. Equal empty paths alone do not establish same-page identity. Every target load and traversal uses the shared row, visited-set, and depth budgets below.
3. A valid checkpoint returns a positive basis for the actual child ID/hash/time with `authority = result_authority`. The stored predecessor effective tier records the strict positive basis established at staging. For a direct write predecessor, it must equal that write's effective tier. If the predecessor itself has a checkpoint, recursively validate it and require its result tier to equal this stored predecessor tier. Where the predecessor was an ordinary purge/revert whose older path bindings were erased, this checkpoint's stage-verified effective tier is the positive anchor; do not reconstruct erased path links or replace it with the raw predecessor tier.
4. Existing ordinary purge/revert/undo-of-undo traversal continues using its established before/after/revert-target checks and reaches an existing validated checkpoint as a positive anchor when applicable. Missing checkpoint means the ordinary path-bound rules still apply; absence never makes a purge self-authorizing. A checkpoint present but invalid yields unavailable/no positive basis, not a fallback to raw receipt authority.
5. Repeated source erasures create new actual child/checkpoint pairs, each staged from the strict positive basis of its actual preimage. Validate explicit checkpoint links recursively; reject cycles, self-links, inconsistent effective tiers, missing referenced rows, invalid kind structure, or non-earlier edges. Preserve the distinction between protective owner resolution and a positive basis.
6. Preserve the existing fail-closed limits of 4,096 receipt rows per requested live-page history and 128 traversal generations. Charge explicitly loaded predecessor/target rows to that page's bounded distinct-row budget; use a 4,097th-row overflow sentinel. Every recursive step shares the same visited set/depth budget, including checkpoint edges and revert targets. Use bounded primary-key lookups/batches and indexed current-page history only. No global matching-hash search, unbounded sanitized-history scan, or ambiguity tie-break can grant positive evidence.

Current source grant, sensitivity, live-event, exact-byte and serving admission checks remain independent requirements. A lineage checkpoint does not override revoked source permission or authorize exporting protected payload.

## Migration and portable representation

At f57, `ledger/db.ts` ends at migration 19. P015 owns migration 20, after rechecking the integration allocation; if another accepted migration has consumed 20, root assigns the next unused version before implementation. Fresh databases and every supported upgrade path create the same strict table and constraints, with no scan that invents records for historical completed erasures. Readiness/schema assertions must include the new table; readers do not silently create or repair it during serving.

For current v3 backups at the new ledger version, always emit `canon/source-survivor-lineage.v1.jsonl`, including an empty stream. Its row keys are exactly the eight table fields above. Order by child receipt ID using SQLite BINARY UTF-8 byte ordering; this portable stream ordering is distinct from the resolver's timestamp-tie code-unit comparison. Each row is limited to 16 KiB serialized UTF-8, at most 100,000 rows per backup, with the existing receipt inventory bound still enforced. Stream rows; use SQL byte projections to refuse oversized stored values before decoding them into JavaScript. Record exact file size, row count, and SHA-256 in the existing versioned manifest.

Capture lineage in the same owned immediate snapshot as canon receipts. Pending source-erasure intents continue to block export. Restore the stream after canon receipt rows, inside the existing all-stream transaction; enforce row keys, version, bounds, uniqueness, references, binding/chronology, recursive consistency, counts, and manifest hashes before installation or derived rebuilding. A malformed or missing required stream, orphan, conflicting duplicate, unsupported version, truncated row, or exceeded budget refuses the complete restore. Foreign-key enforcement alone is not the semantic validator.

Supported legacy backups without the stream restore their recorded data with no generated checkpoints and an explicit lineage-unavailable recovery limitation. Their still-verifiable ordinary history remains usable; affected already-sanitized survivor history remains withheld. A legacy-format backup carrying the new stream is incompatible and must be rejected. Absence is never interpreted as an empty authoritative lineage set for a new-version manifest. Do not add lineage to or redefine the ordinary promotions JSONL receipt shape.

P015 must update version-dependent export compatibility deliberately: f57's `hasPurgeHistory` currently requires ledger version exactly 19. Completed purge-history streams remain supported for both 19 and the new schema version; preserve their existing strict validation and legacy absence behavior. Do not break the accepted completed-purge repair merely by advancing the ledger version.

## Privacy and acceptance

The checkpoint contains only already-retained receipt IDs/content hashes and frozen authority facts. It contains no old/current path, path hash/digest, original-row digest, body, source identifier/endpoint, subject, claim payload, or newly derived erased-identity hash. Source sanitization preserves this exact metadata while continuing to erase its existing path/payload fields. No already-redacted history is backfilled from hash coincidence.

Acceptance keeps both real surviving-B expectations positive (`source-grants.test.ts:1396` and `:1563` at f57) and preserves the corrected raw-unrecorded negative fixture. Add neutral public-seam proof for differing predecessor/result tiers; repeated erasure; ordinary purge/revert/undo-of-undo reaching checkpoints; no-positive-preimage refusal; exact retry and interrupted completion; supported migration and legacy pending intent handling; new-stream export/clean restore; required-stream absence refusal; and surviving completed-purge portability at the new ledger version. Preserve existing assertions and safe-validation restrictions. Exact-head focused/full verification, both review axes, and the independently assigned model lens remain separate acceptance evidence; this contract itself supplies none of those PASS claims.
