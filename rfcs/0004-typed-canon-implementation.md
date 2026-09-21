# Typed canon implementation amendment

Status: Proposed for independent review, 2026-09-21. This implementation scope is part of the launch work; it does not assert historical owner acceptance or completed launch qualification.

Typed assertions remain neutral in the legacy claim columns. A separate bounded queue in the existing configured-model write pass selects complete, currently permitted WorldAdmission contributions. The existing receipted canon writer renders their attributed bodies at `auto/world/<random semantic handle>.md`. It never merges by label, invents a legacy subject identity, or admits caller-supplied rendering as authority. A page is recomposed from selected complete assertions, without copying obsolete prose or frontmatter from its predecessor.

Ledger33 and canon5 add a discriminated representation in the existing receipt table and JSONL stream. Legacy v1 wire ordering, strict intent validation, row data, and hash bytes remain unchanged. Retained typed receipts have schema `kizuki.canon-receipt/v2`, state `retained`, own_id_origin `core`, the existing common receipt fields, and an exact basis:

```typescript
{
  schema: "kizuki.world-canon-basis/v1",
  before: WorldClaimBasis[] | null,
  after: WorldClaimBasis[] | null
}
// WorldClaimBasis:
{ claim_id, semantic_key, supports: [{ support_key, admission_hash }] }
```

Claims and support entries are sorted, unique, and bounded. `admission_hash` hashes the canonical closed WorldAdmission in the `kizuki.world-canon-admission/v1` domain, binding rendering and epistemic classification as well as the support key's evidence and meaning. Exact bases govern reads under the actual principal and source purpose, commit, recovery, projection, and undo. Current output requires live assertions. Historical undo support may be superseded or reverted while its source remains authorized; lifecycle supersession alone does not erase an authorized historical assertion.

The ordinary typed write intent and projection obligation use version 2. They retain the existing durable intent, receipt, native writer capability, and projection completion mechanisms. They do not add a second journal or truth store. Replays revalidate exact typed basis and canonical evidence; an authorized source or neutral parent alone cannot authorize changed rendering.

Erased typed receipts use only `{schema,state:"erased",receipt_id,purge_receipt_id,own_id_origin:"core",erased_at,sensitivity:"private",integrity}`. The integrity hash covers those fields in the `kizuki.canon-receipt/v2#erased` domain. They retain no path, claim/evidence identity, semantic handle, before/after content hash, archive, model reference, or basis. Undo returns an explicit erased refusal.

Source/event erasure requires a separate version 3 arm in the existing canon intent mechanism: no captured preimage, exact prior hash during the unfinished operation, recorded purge proof, replacement bytes and independently revalidated survivor basis. Successful completion erases obsolete archives and retained receipt payload, leaving either a fresh supported receipt without a preimage or an erased record and no page. This arm, its recovery, backup/restore compatibility, and physical-erasure oracles must be complete before this implementation is integrated. This proposal does not adopt backup6 or unrelated proposed Purge6 contracts.

Verification includes real admitted claims through the configured write pass, correction and exact-byte undo, selected-source loss with an independent survivor, zero-survivor deletion, current principal/relay policy, recovery after interruption and changed support, exact v1 compatibility, migration rollback, export/restore, and rebuild. Focused writer tests do not satisfy these lifecycle gates by themselves.

The proposed v3 erasure arm stores the exact completed event-purge proof tuples, strict erased replacements, digests of all affected retained receipt records, an exact archive path/hash deletion manifest, the final retained-or-erased record, and the receipt-log postimage digest/length. `purge_receipt_id` names the actual `event_purges.receipt_id`. Recovery rechecks the existing purge batch/store absence proofs, current receipt and image basis, the complete affected history, and the independently reconstructed survivor. It cannot authorize unrelated archive deletion or erase an available independent materialization. The old page bytes and old receipt-log bytes are never copied into this intent.

Publication uses the same native canon writer. Receipt-log redaction uses a separate purpose-bound capability that atomically replaces the log with its exact admitted postimage; the ordinary append/recovery capability keeps its existing surface. Recovery accepts either the original bound log or the exact redacted postimage, including a failure after file publication but before the SQLite receipt transaction. Completion clears retained columns, receipt-path quota metadata, and old derived page state in that transaction. Current source-independent claims point to the fresh receipt; an empty survivor removes the page and its catalog entry. Export/restore and causal current-receipt validation remain explicit integration gates.

A typed create has no before image and `before_hash:null`. Undoing its deletion is a revert with a real absent before image: `basis.before:null`, `before_hash:ABSENT_PAGE_HASH`, and no archive. This is distinct from an unrecorded preimage. Intent and shared image validation accept that combination only for a revert; create→undo→redo restores the exact admitted page bytes.

Purge discovery includes retained typed receipt history independently of current page existence or current citations. An undone create can leave only an archive: its v3 operation has absent before/after images, null before/after bases, and no claim IDs. A dedicated internal transient-operation parser accepts that exact purge-only shape; the retained receipt storage/log/export codec continues to reject it. The only durable outcome of that operation is an erased receipt. Admission and replay require erased outcome if and only if no after-image exists, so a rehashed invented page cannot accompany an erased record.
