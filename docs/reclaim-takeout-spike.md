# Reclaim Takeout activity spike

Status: post-1.0 experiment for #553, under #551. Not part of #403, not a
registered importer, and not world-model integration.

`scripts/reclaim-takeout-spike.ts` projects a caller-selected JSON array of
My Activity-shaped records into title, source timestamp, product names and
record position. Its receipt hashes the exact supplied UTF-8 input and records
input bytes and row count. It is a parsing receipt, not a ledger or canon receipt.
No model interprets a search title as a belief or as proof of an action.

Run its synthetic acceptance cases with:

    bun test scripts/reclaim-takeout-spike.test.ts

## Local-only boundary

Use only the data subject's own explicitly selected export. The function accepts
text; it opens no file, downloads nothing, invokes no model, embeds nothing,
and writes no state. Do not send input, projected titles, or receipts to a remote
endpoint. A digest is still private, linkable metadata. This boundary applies to
this experiment; it is not proof that future integration enforces source egress
policy. No registry entry or public CLI verb is added.

## Size and schema limits

Select one already-extracted activity JSON file, not a ZIP or whole Takeout tree.
The spike refuses more than 1 MiB of supplied UTF-8 text or 10,000 records before
projection. It validates all records before returning any result, preserves
source timestamp precision and offsets, and omits unselected fields such as
location information. Duplicate rows retain distinct positions. Positions bound
to the input digest are provenance pointers, not stable provider record IDs.

This is bounded selective ingestion, not multi-GB streaming. The caller has
already allocated the input string. A production reader still needs bounded
streaming, explicit selection/consent, archive handling, interruption/resume,
ledger admission and purge proofs. The synthetic shape is not a current vendor
schema compatibility claim. A versioned, representative export must be qualified
before registration; no real account or private export was accessed here.

The RFC, vendor priority, accepted claim/world-slice mapping, local-model policy
integration, multi-GB strategy and end-to-end receipt remain outstanding under
#553. This experiment does not complete the epic.
